/**
 * 图运行历史持久化（per-run jsonl，仿 transcript 模式）
 *
 * - agents/graph-runs/<runId>.jsonl：首行 run_meta（快照图结构 + prompt + createdAt），其后每行一个 GraphEvent envelope。
 * - 用 fs.WriteStream（异步缓冲），不用 appendFileSync（审核#3：避免阻塞事件循环）。
 * - run_meta 快照 nodes[{id,type,agentNodeKey?}]，重放时按快照配节点 label，改图后不失真（审核#4）。
 * - 单图阶段不写 graphId（审核#15：避免造未来要对齐的假 id）；多图落地时再定。
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../../utils/project-root.js';
import type { GraphEvent } from '../../infrastructure/websocket/SocketManager.js';
import type { Graph } from './graph.js';

function runsDir(): string {
  return join(getProjectRoot(), 'agents', 'graph-runs');
}

function runFile(runId: string): string {
  return join(runsDir(), `${runId}.jsonl`);
}

export interface RunMeta {
  type: 'run_meta';
  runId: string;
  prompt: string;
  createdAt: number;
  nodes: { id: string; type: 'input' | 'agent'; agentNodeKey?: string }[];
}

export interface RunSummary {
  runId: string;
  prompt: string;
  createdAt: number;
  status: 'done' | 'error' | 'aborted' | 'unknown';
}

const openStreams = new Map<string, WriteStream>();

function getStream(runId: string): WriteStream {
  const existing = openStreams.get(runId);
  if (existing && !existing.destroyed) return existing;
  mkdirSync(runsDir(), { recursive: true });
  const stream = createWriteStream(runFile(runId), { flags: 'a' });
  openStreams.set(runId, stream);
  return stream;
}

/** 运行开始：写 run_meta 首行（快照图结构）。 */
export function recordRunStart(runId: string, prompt: string, graph: Graph): void {
  const meta: RunMeta = {
    type: 'run_meta',
    runId,
    prompt,
    createdAt: Date.now(),
    nodes: graph.nodes.map((n) =>
      n.type === 'input'
        ? { id: n.id, type: 'input' }
        : { id: n.id, type: 'agent', agentNodeKey: n.agentNodeKey },
    ),
  };
  getStream(runId).write(JSON.stringify(meta) + '\n');
}

/** 追加一个 envelope 事件。 */
export function recordRunEvent(runId: string, event: GraphEvent): void {
  getStream(runId).write(JSON.stringify(event) + '\n');
}

/** 运行结束：关闭流，释放 fd。 */
export function closeRunStream(runId: string): void {
  const stream = openStreams.get(runId);
  if (stream) {
    stream.end();
    openStreams.delete(runId);
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
      continue;
    }
    if (isRunMeta(obj)) meta = obj;
    else if (isGraphEvent(obj)) events.push(obj);
  }
  return { meta, events };
}

/** 重放某次 run：返回 meta + 事件序列。 */
export function readRun(runId: string): { meta?: RunMeta; events: GraphEvent[] } {
  return readJsonl(runFile(runId));
}

/** 列出最近 N 次 run（按 createdAt 降序）。status 从末尾事件推断。 */
export function listRuns(limit = 20): RunSummary[] {
  const dir = runsDir();
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
    summaries.push({ runId: meta.runId, prompt: meta.prompt, createdAt: meta.createdAt, status });
  }
  summaries.sort((a, b) => b.createdAt - a.createdAt);
  return summaries.slice(0, limit);
}
