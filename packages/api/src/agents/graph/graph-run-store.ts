/**
 * 图运行历史持久化（per-project per-run jsonl）
 *
 * - agents/projects/<projectId>/graph-runs/<runId>.jsonl：首行 run_meta（projectId + prompt + createdAt + graph + graphNodeInstances），其后每行一个 GraphEvent envelope。
 * - 用 fs.WriteStream（异步缓冲）。
 * - recordRunEvent 防御性净化：若事件含原始 resumeToken → 抛错（M8 run_paused 须发 hash 形到 record）。
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../../utils/project-root.js';
import { formatInstanceKey } from '../instance-key.js';
import { projectRunsDir } from '../project-storage.js';
import type { GraphEvent } from '../../infrastructure/websocket/SocketManager.js';
import type { Graph, GraphNode } from './graph.js';

function runFile(projectId: string, runId: string): string {
  return join(projectRunsDir(projectId), `${runId}.jsonl`);
}

export interface RunMeta {
  type: 'run_meta';
  runId: string;
  projectId: string;
  prompt: string;
  createdAt: number;
  /** 完整 graph 快照（含 end/role/when/maxIterations/edge.id），重放时按快照配节点 label/配色/迭代。 */
  graph: Graph;
  /** 仅 agent 图节点 → instanceKey（input/end 无 instanceKey，故 Partial）。重放/审计用。 */
  graphNodeInstances: Partial<Record<string, string>>;
}

export interface RunSummary {
  runId: string;
  projectId: string;
  prompt: string;
  createdAt: number;
  status: 'done' | 'error' | 'aborted' | 'unknown';
}

const openStreams = new Map<string, WriteStream>();

function streamKey(projectId: string, runId: string): string {
  return `${projectId}/${runId}`;
}

function getStream(projectId: string, runId: string): WriteStream {
  const key = streamKey(projectId, runId);
  const existing = openStreams.get(key);
  if (existing && !existing.destroyed) return existing;
  mkdirSync(projectRunsDir(projectId), { recursive: true });
  const stream = createWriteStream(runFile(projectId, runId), { flags: 'a' });
  openStreams.set(key, stream);
  return stream;
}

/** 运行开始：写 run_meta 首行（完整 graph 快照 + graphNodeInstances）。 */
export function recordRunStart(projectId: string, runId: string, prompt: string, graph: Graph): void {
  const meta: RunMeta = {
    type: 'run_meta',
    runId,
    projectId,
    prompt,
    createdAt: Date.now(),
    graph,
    graphNodeInstances: Object.fromEntries(
      graph.nodes
        .filter((n): n is Extract<GraphNode, { type: 'agent' }> => n.type === 'agent' && 'agentNodeKey' in n && !!n.agentNodeKey)
        .map((n) => [n.id, formatInstanceKey(projectId, n.agentNodeKey)] as const),
    ),
  };
  getStream(projectId, runId).write(JSON.stringify(meta) + '\n');
}

/** 追加一个 envelope 事件。防御性净化：原始 resumeToken 不得进 JSONL（M8 须发 hash 形）。 */
export function recordRunEvent(projectId: string, runId: string, event: GraphEvent): void {
  if ('resumeToken' in event && typeof (event as { resumeToken?: unknown }).resumeToken === 'string') {
    throw new Error(`recordRunEvent: raw resumeToken must not be persisted (use resumeTokenHash); event type=${event.type}`);
  }
  getStream(projectId, runId).write(JSON.stringify(event) + '\n');
}

/** 运行结束：关闭流，释放 fd。 */
export function closeRunStream(projectId: string, runId: string): void {
  const stream = openStreams.get(streamKey(projectId, runId));
  if (stream) {
    stream.end();
    openStreams.delete(streamKey(projectId, runId));
  }
}

function isRunMeta(o: unknown): o is RunMeta {
  return typeof o === 'object' && o !== null && (o as { type?: unknown }).type === 'run_meta';
}
function isGraphEvent(o: unknown): o is GraphEvent {
  return typeof o === 'object' && o !== null && 'type' in o && 'runId' in o;
}

function readJsonl(file: string): { meta?: RunMeta; events: GraphEvent[] } {
  const content = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  if (!content) return { events: [] };
  const events: GraphEvent[] = [];
  let meta: RunMeta | undefined;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // 末行不完整容忍
    }
    if (isRunMeta(obj)) meta = obj;
    else if (isGraphEvent(obj)) events.push(obj);
  }
  return { meta, events };
}

/** 重放某次 run：返回 meta + 事件序列。 */
export function readRun(projectId: string, runId: string): { meta?: RunMeta; events: GraphEvent[] } {
  return readJsonl(runFile(projectId, runId));
}

/** 列出某画布最近 N 次 run（按 createdAt 降序）。status 从末尾事件推断。 */
export function listRuns(projectId: string, limit = 20): RunSummary[] {
  const dir = projectRunsDir(projectId);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const summaries: RunSummary[] = [];
  for (const f of files) {
    const runId = f.slice(0, -'.jsonl'.length);
    const { meta, events } = readJsonl(join(dir, f));
    if (!meta) continue;
    const last = events[events.length - 1];
    let status: RunSummary['status'] = 'unknown';
    if (last) {
      if (last.type === 'run_done') status = 'done';
      else if (last.type === 'run_error') status = 'error';
      else if (last.type === 'run_aborted') status = 'aborted';
    }
    summaries.push({ runId: meta.runId, projectId: meta.projectId, prompt: meta.prompt, createdAt: meta.createdAt, status });
  }
  summaries.sort((a, b) => b.createdAt - a.createdAt);
  return summaries.slice(0, limit);
}

// 兼容：导出 runsDir 根（迁移/调试用）。
export function _runsDir(projectId: string): string {
  return projectRunsDir(projectId);
}
void getProjectRoot;
