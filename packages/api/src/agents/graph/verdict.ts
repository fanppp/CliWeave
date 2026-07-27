/**
 * Verdict 接口（可插拔）—— reviewer 节点的"满意放行"裁定。
 *
 * - M4a 占位实现：正则解析 `VERDICT: APPROVE/REJECT`（按行锚定、大小写不敏感、取最后一个完整匹配）。
 * - M5a 升级：改读 MCP `submit_verdict` 写的 verdict 文件（路径含 runId/nodeId/iteration，调用前清旧/一次性消费），签名不变，Router 无感切换。
 *
 * VerdictContext 预留 runId/nodeId/iteration，供 M5a 定位 verdict 文件、防读上一轮旧文件。
 */
import type { GraphNode } from './graph.js';

export interface Verdict {
  approved: boolean;
  feedback: string;
}

export interface TrailEntry {
  nodeId: string;
  output: string;
  verdict?: Verdict;
  iter: number;
}

export interface VerdictContext {
  runId: string;
  nodeId: string;
  iteration: number;
  finalText: string;
  trail: TrailEntry[];
}

/** 占位：从 reviewer 最终 text 解析 `VERDICT: APPROVE/REJECT`。未取到 → null（Router 当 reject）。 */
const VERDICT_RE = /^[ \t]*VERDICT[ \t]*:[ \t]*(APPROVE|REJECT)\b/gim;

export function extractVerdict(_node: GraphNode, ctx: VerdictContext): Verdict | null {
  const matches = [...ctx.finalText.matchAll(VERDICT_RE)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const decision = last[1].toUpperCase();
  const after = ctx.finalText.slice((last.index ?? 0) + last[0].length).trim();
  return {
    approved: decision === 'APPROVE',
    feedback: after || (decision === 'APPROVE' ? '(approved)' : '(rejected)'),
  };
}
