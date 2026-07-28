/**
 * thread-store —— 跨轮对话 Thread 的 append-only 事件源存储。
 *
 * agents/projects/<projectId>/threads/<threadId>/
 *   thread.json   —— ThreadMeta（revision + activeRunId，可变，原子写）
 *   events.jsonl  —— ThreadEvent 事实源（append-only，永不改写）
 *   summaries/     —— ThreadSummary 可重建缓存（首版留空，Step 8 增强生成）
 *
 * - revision lock：继续 Thread 须传 expectedRevision，不匹配 → 409（并发任务用 fork/new Thread）。
 * - 同一 Thread 同时只允许一个 pending/running run（activeRunId 非空 → 409）。
 * - turn 生命周期：openTurn（create /run 时）→ completeTurn/failTurn（run 终态时）。
 * - pending run 落盘（graph-runs/<runId>.pending.json）：create↔start 之间重启不丢 user turn。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectRoot } from '../../utils/project-root.js';
import { projectDir, projectRunsDir, projectTrashDir } from '../project-storage.js';
import { withNodeLock } from '../node-mutex.js';

// ── 类型 ──────────────────────────────────────────────────────
export interface ThreadMeta {
  schemaVersion: 1;
  id: string;
  projectId: string;
  title: string;
  /** 单调递增；每次 turn_opened/turn_completed/turn_failed +1。继续 Thread 须传 expectedRevision 匹配。 */
  revision: number;
  /** 当前 pending/running run 的 runId；非空 → 拒绝新 run（409）。终态时清空。 */
  activeRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ThreadEvent =
  | { type: 'turn_opened'; turnId: string; runId: string; seq: number; userMessage: string; createdAt: number }
  | {
      type: 'turn_completed';
      turnId: string;
      runId: string;
      finalArtifact: string;
      quality?: { status: string; termination: string; reason?: string };
      completedAt: number;
    }
  | { type: 'turn_failed'; turnId: string; runId: string; status: 'error' | 'aborted'; reason?: string; completedAt: number }
  | { type: 'memory_pinned'; memoryId: string; content: string; sourceTurnIds: string[]; createdAt: number }
  | { type: 'memory_unpinned'; memoryId: string; createdAt: number };

/** 可重建缓存（首版不生成，留接口）。 */
export interface ThreadSummary {
  schemaVersion: 1;
  throughTurnSeq: number;
  sourceTurnIds: string[];
  sourceHash: string;
  content: string;
  createdAt: number;
}

/** create↔start 之间持久化的 pending run（替代内存 Map，重启不丢）。 */
export interface PendingRun {
  runId: string;
  projectId: string;
  threadId: string;
  turnId: string;
  prompt: string;
  /** 开轮后的 thread.revision（run_meta 快照 + start 重试校验用）。 */
  threadRevision: number;
  createdAt: number;
}

// ── 路径 ───────────────────────────────────────────────────────
export function threadsDir(projectId: string): string {
  return join(projectDir(projectId), 'threads');
}
export function threadDir(projectId: string, threadId: string): string {
  return join(threadsDir(projectId), threadId);
}
function threadFile(projectId: string, threadId: string): string {
  return join(threadDir(projectId, threadId), 'thread.json');
}
function eventsFile(projectId: string, threadId: string): string {
  return join(threadDir(projectId, threadId), 'events.jsonl');
}
export function pendingRunFile(projectId: string, runId: string): string {
  return join(projectRunsDir(projectId), `${runId}.pending.json`);
}

// ── 原子写 ─────────────────────────────────────────────────────
function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, file);
}
function writeThreadMeta(projectId: string, meta: ThreadMeta): void {
  writeAtomic(threadFile(projectId, meta.id), JSON.stringify(meta, null, 2) + '\n');
}
function appendLine(file: string, line: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, line + '\n', { flag: 'a' });
}

// ── CRUD ───────────────────────────────────────────────────────
function parseThreadMeta(raw: unknown, projectId: string): ThreadMeta {
  const m = raw as ThreadMeta;
  if (!m || m.schemaVersion !== 1 || typeof m.id !== 'string' || m.projectId !== projectId) {
    throw new Error(`invalid thread meta: ${projectId}/${m?.id}`);
  }
  return m;
}

export function readThread(projectId: string, threadId: string): ThreadMeta | null {
  const f = threadFile(projectId, threadId);
  if (!existsSync(f)) return null;
  try {
    return parseThreadMeta(JSON.parse(readFileSync(f, 'utf-8')), projectId);
  } catch {
    return null;
  }
}

export interface ThreadListItem extends ThreadMeta {
  lastTurnPreview?: string;
  lastTurnAt?: number;
}

export function listThreads(projectId: string): ThreadListItem[] {
  const root = threadsDir(projectId);
  if (!existsSync(root)) return [];
  const out: ThreadListItem[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const meta = readThread(projectId, entry.name);
    if (!meta) continue;
    // 末轮 preview（最近的 turn_completed/turn_opened）
    const evs = readThreadEvents(projectId, entry.name);
    const lastTurn = [...evs].reverse().find((e) => e.type === 'turn_completed' || e.type === 'turn_opened');
    out.push({
      ...meta,
      ...(lastTurn?.type === 'turn_completed' ? { lastTurnPreview: lastTurn.finalArtifact.slice(0, 80), lastTurnAt: lastTurn.completedAt } : {}),
      ...(lastTurn?.type === 'turn_opened' ? { lastTurnPreview: lastTurn.userMessage.slice(0, 80), lastTurnAt: lastTurn.createdAt } : {}),
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createThread(projectId: string, title: string): ThreadMeta {
  const id = randomUUID();
  const now = Date.now();
  const meta: ThreadMeta = {
    schemaVersion: 1,
    id,
    projectId,
    title: title.trim().slice(0, 80) || '新对话',
    revision: 0,
    activeRunId: null,
    createdAt: now,
    updatedAt: now,
  };
  mkdirSync(threadDir(projectId, id), { recursive: true });
  mkdirSync(join(threadDir(projectId, id), 'summaries'), { recursive: true });
  writeThreadMeta(projectId, meta);
  return meta;
}

export function trashThread(projectId: string, threadId: string): void {
  const dir = threadDir(projectId, threadId);
  if (!existsSync(dir)) throw new Error(`thread not found: ${threadId}`);
  const meta = readThread(projectId, threadId);
  if (meta?.activeRunId) throw new Error(`thread has active run ${meta.activeRunId}; abort it first`);
  const trash = join(projectTrashDir(projectId), 'threads', `${threadId}-${Date.now().toString(36)}`);
  mkdirSync(dirname(trash), { recursive: true });
  renameSync(dir, trash);
}

// ── events ─────────────────────────────────────────────────────
export function readThreadEvents(projectId: string, threadId: string): ThreadEvent[] {
  const f = eventsFile(projectId, threadId);
  if (!existsSync(f)) return [];
  const out: ThreadEvent[] = [];
  for (const line of readFileSync(f, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as ThreadEvent);
    } catch {
      // 末行不完整容忍
    }
  }
  return out;
}

function appendThreadEvent(projectId: string, threadId: string, event: ThreadEvent): void {
  appendLine(eventsFile(projectId, threadId), JSON.stringify(event));
}

// ── turn 生命周期（revision lock + activeRunId 互斥）────────────
export class ThreadConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThreadConflictError';
  }
}

export interface OpenTurnResult {
  turnId: string;
  seq: number;
  revision: number;
}

/** 开轮：校验 expectedRevision + activeRunId 互斥；追加 turn_opened；bump revision + 设 activeRunId。 */
export function openTurn(
  projectId: string,
  threadId: string,
  expectedRevision: number,
  input: { runId: string; userMessage: string },
): Promise<OpenTurnResult> {
  return withNodeLock(`thread:${projectId}:${threadId}`, async () => {
    const meta = readThread(projectId, threadId);
    if (!meta) throw new ThreadConflictError(`thread not found: ${threadId}`);
    if (meta.revision !== expectedRevision) {
      throw new ThreadConflictError(`thread revision stale: expected ${expectedRevision}, got ${meta.revision}`);
    }
    if (meta.activeRunId) {
      throw new ThreadConflictError(`thread already has active run: ${meta.activeRunId}`);
    }
    const events = readThreadEvents(projectId, threadId);
    const seq = events.filter((e) => e.type === 'turn_opened').length + 1;
    const turnId = randomUUID();
    const now = Date.now();
    appendThreadEvent(projectId, threadId, {
      type: 'turn_opened',
      turnId,
      runId: input.runId,
      seq,
      userMessage: input.userMessage,
      createdAt: now,
    });
    const updated: ThreadMeta = { ...meta, revision: meta.revision + 1, activeRunId: input.runId, updatedAt: now };
    writeThreadMeta(projectId, updated);
    return { turnId, seq, revision: updated.revision };
  });
}

/** 完成轮：追加 turn_completed；清 activeRunId；bump revision。activeRunId 不匹配则忽略（防过期回调）。 */
export function completeTurn(
  projectId: string,
  threadId: string,
  runId: string,
  turnId: string,
  result: { finalArtifact: string; quality?: { status: string; termination: string; reason?: string } },
): Promise<void> {
  return withNodeLock(`thread:${projectId}:${threadId}`, async () => {
    const meta = readThread(projectId, threadId);
    if (!meta) return;
    if (meta.activeRunId !== runId) return; // 过期回调（run 已被 abort/替换）
    const now = Date.now();
    appendThreadEvent(projectId, threadId, {
      type: 'turn_completed',
      turnId,
      runId,
      finalArtifact: result.finalArtifact,
      ...(result.quality ? { quality: result.quality } : {}),
      completedAt: now,
    });
    writeThreadMeta(projectId, { ...meta, revision: meta.revision + 1, activeRunId: null, updatedAt: now });
  });
}

/** 失败轮：追加 turn_failed；清 activeRunId（若匹配）；bump revision。 */
export function failTurn(
  projectId: string,
  threadId: string,
  runId: string,
  turnId: string,
  result: { status: 'error' | 'aborted'; reason?: string },
): Promise<void> {
  return withNodeLock(`thread:${projectId}:${threadId}`, async () => {
    const meta = readThread(projectId, threadId);
    if (!meta) return;
    if (meta.activeRunId !== runId) return;
    const now = Date.now();
    appendThreadEvent(projectId, threadId, {
      type: 'turn_failed',
      turnId,
      runId,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      completedAt: now,
    });
    writeThreadMeta(projectId, { ...meta, revision: meta.revision + 1, activeRunId: null, updatedAt: now });
  });
}

/** abort pending run（未 start）：清 activeRunId + turn_failed aborted。 */
export function abortPendingTurn(projectId: string, threadId: string, runId: string, turnId: string): Promise<void> {
  return withNodeLock(`thread:${projectId}:${threadId}`, async () => {
    const meta = readThread(projectId, threadId);
    if (!meta) return;
    if (meta.activeRunId !== runId) return;
    const now = Date.now();
    appendThreadEvent(projectId, threadId, {
      type: 'turn_failed',
      turnId,
      runId,
      status: 'aborted',
      reason: 'aborted before start',
      completedAt: now,
    });
    writeThreadMeta(projectId, { ...meta, revision: meta.revision + 1, activeRunId: null, updatedAt: now });
  });
}

// ── memory pin（context-builder 读取；首版无 UI，但事件源已支持）────────
export function pinMemory(
  projectId: string,
  threadId: string,
  input: { memoryId: string; content: string; sourceTurnIds?: string[] },
): Promise<void> {
  return withNodeLock(`thread:${projectId}:${threadId}`, async () => {
    const meta = readThread(projectId, threadId);
    if (!meta) return;
    appendThreadEvent(projectId, threadId, {
      type: 'memory_pinned',
      memoryId: input.memoryId,
      content: input.content,
      sourceTurnIds: input.sourceTurnIds ?? [],
      createdAt: Date.now(),
    });
    writeThreadMeta(projectId, { ...meta, updatedAt: Date.now() });
  });
}

export function unpinMemory(projectId: string, threadId: string, memoryId: string): Promise<void> {
  return withNodeLock(`thread:${projectId}:${threadId}`, async () => {
    const meta = readThread(projectId, threadId);
    if (!meta) return;
    appendThreadEvent(projectId, threadId, {
      type: 'memory_unpinned',
      memoryId,
      createdAt: Date.now(),
    });
    writeThreadMeta(projectId, { ...meta, updatedAt: Date.now() });
  });
}

// ── pending run 持久化（create↔start 之间）─────────────────────
export function writePendingRun(p: PendingRun): void {
  writeAtomic(pendingRunFile(p.projectId, p.runId), JSON.stringify(p, null, 2) + '\n');
}
export function readPendingRun(projectId: string, runId: string): PendingRun | null {
  const f = pendingRunFile(projectId, runId);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf-8')) as PendingRun;
  } catch {
    return null;
  }
}
export function deletePendingRun(projectId: string, runId: string): void {
  const f = pendingRunFile(projectId, runId);
  if (existsSync(f)) {
    try {
      rmSync(f, { force: true });
    } catch {
      // ignore
    }
  }
}

void getProjectRoot;
