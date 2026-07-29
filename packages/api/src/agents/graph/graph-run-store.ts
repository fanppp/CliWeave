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
import type { PersistedRunEvent, GraphEvent } from '../../infrastructure/websocket/SocketManager.js';
import type { ContextSnapshot } from '../context-builder.js';
import type { Rubric } from './evaluation.js';
import type { AnyGraph } from './graph.js';
import type { RunMode } from './completion.js';

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
  graph: AnyGraph;
  /** 仅 agent 图节点 → instanceKey（input/end 无 instanceKey，故 Partial）。重放/审计用。 */
  graphNodeInstances: Partial<Record<string, string>>;
  /** Step 2: 归属 Thread + turn + 开轮时的 revision（重放/审计用；旧 run 无则缺省）。 */
  threadId?: string;
  turnId?: string;
  threadRevision?: number;
  /** Step 3: 本次注入的上下文快照（included turns/summary/pins/serverContext + 预算估算）。 */
  contextSnapshot?: ContextSnapshot;
  runMode?: RunMode;
  rubrics?: Record<string, { rubricRef: string; hash: string; rubric: Rubric }>;
  gatePolicyOverrides?: Record<string, 'ask_user' | 'continue_best' | 'fail'>;
}

export interface RunSummary {
  runId: string;
  projectId: string;
  prompt: string;
  createdAt: number;
  status: 'done' | 'error' | 'aborted' | 'paused' | 'unknown';
  /** Step 2: 归属 Thread（旧 run 无则缺省）。 */
  threadId?: string;
  turnId?: string;
}

export function deriveRunStatus(events: PersistedRunEvent[]): RunSummary['status'] {
  let status: RunSummary['status'] = 'unknown';
  for (const event of events) {
    if (event.type === 'branch_checkpoint' || (event.type === 'run_state' && event.phase === 'paused')) status = 'paused';
    else if (event.type === 'run_state' && event.phase === 'resume_token_consumed') status = 'unknown';
    else if (event.type === 'run_done') status = 'done';
    else if (event.type === 'run_error') status = 'error';
    else if (event.type === 'run_aborted') status = 'aborted';
  }
  return status;
}

/** 启动恢复专用：只返回最后 durable 状态仍为 paused 的 run_meta。 */
export function listRecoverablePausedRuns(projectId: string): RunMeta[] {
  const dir = projectRunsDir(projectId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((file) => {
    const { meta, events } = readJsonl(join(dir, file));
    return meta && deriveRunStatus(events) === 'paused' ? [meta] : [];
  });
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

/** 运行开始：写 run_meta 首行（完整 graph 快照 + graphNodeInstances + thread 关联）。 */
export function recordRunStart(
  projectId: string,
  runId: string,
  prompt: string,
  graph: AnyGraph,
  thread?: { threadId: string; turnId: string; threadRevision: number },
  contextSnapshot?: ContextSnapshot,
  runMode?: RunMode,
  rubrics?: RunMeta['rubrics'],
  gatePolicyOverrides?: RunMeta['gatePolicyOverrides'],
): void {
  const meta: RunMeta = {
    type: 'run_meta',
    runId,
    projectId,
    prompt,
    createdAt: Date.now(),
    graph,
    graphNodeInstances: Object.fromEntries(graph.nodes.flatMap((n) =>
      n.type === 'agent' || n.type === 'decision' ? [[n.id, formatInstanceKey(projectId, n.agentNodeKey)] as const] : [],
    )),
    ...(thread ? { threadId: thread.threadId, turnId: thread.turnId, threadRevision: thread.threadRevision } : {}),
    ...(contextSnapshot ? { contextSnapshot } : {}),
    ...(runMode ? { runMode } : {}),
    ...(rubrics ? { rubrics } : {}),
    ...(gatePolicyOverrides && Object.keys(gatePolicyOverrides).length ? { gatePolicyOverrides } : {}),
  };
  getStream(projectId, runId).write(JSON.stringify(meta) + '\n');
}

/** 追加一个 envelope 事件（公开或内部检查点）。防御性净化：原始 resumeToken 不得进 JSONL（M8 须发 hash 形）。 */
export function recordRunEvent(projectId: string, runId: string, event: PersistedRunEvent): void {
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
function isPersistedRunEvent(o: unknown): o is PersistedRunEvent {
  return typeof o === 'object' && o !== null && 'type' in o && 'runId' in o;
}

function readJsonl(file: string): { meta?: RunMeta; events: PersistedRunEvent[] } {
  const content = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  if (!content) return { events: [] };
  const events: PersistedRunEvent[] = [];
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
    else if (isPersistedRunEvent(obj)) events.push(obj);
  }
  return { meta, events };
}

/** 重放某次 run：返回 meta + 事件序列。 */
export function readRun(projectId: string, runId: string): { meta?: RunMeta; events: GraphEvent[] } {
  const { meta, events } = readJsonl(runFile(projectId, runId));
  return { ...(meta ? { meta } : {}), events: events.filter((e): e is GraphEvent => e.type !== 'run_state' && e.type !== 'branch_checkpoint') };
}

/** 服务端恢复专用：包含内部 checkpoint，禁止直接返回 HTTP/WS。 */
export function readPersistedRun(projectId: string, runId: string): { meta?: RunMeta; events: PersistedRunEvent[] } {
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
    const status = deriveRunStatus(events);
    summaries.push({
      runId: meta.runId,
      projectId: meta.projectId,
      prompt: meta.prompt,
      createdAt: meta.createdAt,
      status,
      ...(meta.threadId ? { threadId: meta.threadId } : {}),
      ...(meta.turnId ? { turnId: meta.turnId } : {}),
    });
  }
  summaries.sort((a, b) => b.createdAt - a.createdAt);
  return summaries.slice(0, limit);
}

// 兼容：导出 runsDir 根（迁移/调试用）。
export function _runsDir(projectId: string): string {
  return projectRunsDir(projectId);
}
void getProjectRoot;
