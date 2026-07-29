/**
 * Project Scribe —— 可选 documenter 节点，接 Knowledge observe 边，后台总结 issues。
 *
 * 约束：
 * - 不进入主链、不影响 run 成败（walkV5Graph 不处理 observe 边）。
 * - 只消费 confirmed/resolved/accepted 投影（observed 不够确证，不总结）。
 * - 只输出 ISSUE_SUMMARY_DRAFT（Markdown）。不确认/关闭/删除/合并 finding。
 * - 服务端校验草案（不得含 mutate 指令）后原子更新 PROJECT_ISSUES.md。
 * - 无 Scribe（节点缺失/未配置）→ IssueProjector 确定性模板（publish.ts）。
 */
import type { ExecNode, ExecuteOptions } from '../graph/AgentRouter.js';
import type { GraphV5 } from '../graph/graph.js';
import { listIssues, type Issue } from './issue-store.js';

/** Scribe 只看确证/已决问题。 */
function scribeVisibleIssues(projectId: string): Issue[] {
  return listIssues(projectId).filter((i) => ['confirmed', 'open', 'resolved', 'accepted'].includes(i.status));
}

export function scribePrompt(issues: Issue[]): string {
  const summary = issues.length
    ? issues.map((i) => `- [${i.status}${i.severity ? `:${i.severity}` : ''}] ${i.title} — ${i.detail} (×${i.occurrences})`).join('\n')
    : '(暂无确证问题)';
  return `你是项目 Scribe。只把已确证/已决问题总结为 Markdown 草案（ISSUE_SUMMARY_DRAFT），不得确认、关闭、删除或合并任何问题。\n\n【确证/已决问题】\n${summary}\n\n仅输出 Markdown 草案，以 "# Project Issues" 开头。不要输出任何 JSON 或指令。`;
}

/** 解析 Scribe 输出为草案文本；必须以 # 开头、含 Project Issues、长度合理。 */
export function parseIssueSummaryDraft(text: string): string | null {
  const draft = text.trim();
  if (draft.length < 10) return null;
  if (!/^#\s+Project\s+Issues\b/im.test(draft)) return null;
  return draft;
}

const MUTATE_PATTERNS: RegExp[] = [
  /\b(confirm|resolve|accept|close|delete|merge|supersede)\b.*\b(issue|finding)\b/i,
  /\bISSUE_(CONFIRMED|RESOLVED|ACCEPTED|DELETED|MERGED)\b/i,
];

/** 校验 Scribe 草案：不得含 mutate finding 的指令。 */
export function validateScribeDraft(draft: string): { ok: true } | { ok: false; reason: string } {
  for (const line of draft.split('\n')) {
    for (const p of MUTATE_PATTERNS) if (p.test(line)) return { ok: false, reason: `draft attempts to mutate findings: ${line.slice(0, 80)}` };
  }
  return { ok: true };
}

export interface ScribeContext {
  graph: GraphV5;
  scribeNodeKey: string;
}

/** 在 V5 图里找 documenter 节点 + 其 observe source（project_knowledge）。返回 documenter 的 agentNodeKey。 */
export function findScribe(graph: GraphV5): string | null {
  const observe = graph.edges.find((e): e is Extract<GraphV5['edges'][number], { kind: 'observe' }> => e.kind === 'observe');
  if (!observe) return null;
  const target = graph.nodes.find((n) => n.id === observe.target);
  if (!target || target.type !== 'documenter') return null;
  return target.agentNodeKey;
}

/**
 * 调用 Scribe 生成草案。exec/opts 由调用方提供（路由用 runAgentNode+合成 opts；测试用脚本 exec）。
 * 无 Scribe（图中无 observe/documenter）→ 返回 null（调用方回退确定性模板）。
 */
export async function summarizeWithScribe(projectId: string, graph: GraphV5, exec: ExecNode, opts: ExecuteOptions): Promise<string | null> {
  const scribeNodeKey = findScribe(graph);
  if (!scribeNodeKey) return null;
  const scribeNode = graph.nodes.find((n) => n.type === 'documenter' && n.agentNodeKey === scribeNodeKey);
  if (!scribeNode || scribeNode.type !== 'documenter') return null;
  const issues = scribeVisibleIssues(projectId);
  let out;
  try {
    out = await exec(scribeNode as Parameters<ExecNode>[0], scribePrompt(issues), opts, { iteration: 1, sessionPolicy: { mode: 'fresh', persistActive: false } });
  } catch {
    return null; // Scribe 调用失败 → 调用方回退确定性模板
  }
  if (out.status !== 'ok') return null;
  const draft = parseIssueSummaryDraft(out.finalText ?? '');
  if (!draft) return null;
  const validation = validateScribeDraft(draft);
  if (!validation.ok) return null;
  return draft;
}
