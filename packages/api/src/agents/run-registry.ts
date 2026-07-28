/**
 * RunRegistry —— 统一运行注册表（替代 abort-registry + routes/graph.ts 私有 pendingRuns）。
 *
 * - entry: {id(=runId 或 message invocationId), projectId, instanceKey?, kind, status, controller?}。
 * - status: pending|running|paused|done|error|aborted|interrupted（M5 用 pending/running/aborted/interrupted；
 *   paused + branch 聚合为 M8 预留）。
 * - subInvocations: Map<subInvocationId, {parentRunId, projectId, instanceKey}>；
 *   图运行每节点调用生成 subInvocationId（= runId:graphNodeId:iteration:rand），供 spawnCli 登记 PID。
 * - 迁移/删除/start/abort 全部走本注册表；maintenance 阻止 pending/running/paused。
 */
import type { InstanceKey } from './instance-key.js';

export type RunStatus = 'pending' | 'running' | 'paused' | 'done' | 'error' | 'aborted' | 'interrupted';
/** M8 分支状态预留（M5 不使用）。 */
export type BranchStatus = 'running' | 'paused' | 'done' | 'error' | 'aborted';

export interface RunRegistryEntry {
  id: string;
  projectId: string;
  instanceKey?: InstanceKey;
  kind: 'message' | 'graph';
  status: RunStatus;
  controller?: AbortController;
  createdAt: number;
  /** M8 分支状态预留（M5 不使用）。 */
  branches?: Record<string, BranchStatus>;
  /** Step 2: 图运行归属的 Thread（单节点消息无）。 */
  threadId?: string;
  /** Step 2: 对应 Thread 的 turnId。 */
  turnId?: string;
}

export interface SubInvocation {
  subInvocationId: string;
  parentRunId: string;
  projectId: string;
  instanceKey: InstanceKey;
  createdAt: number;
}

const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set(['pending', 'running', 'paused']);
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['done', 'error', 'aborted', 'interrupted']);

const runs = new Map<string, RunRegistryEntry>();
const subInvocations = new Map<string, SubInvocation>();

/** 终态 entry 短暂保留后清理（默认 5 分钟）。 */
const TERMINAL_TTL_MS = 5 * 60 * 1000;

function sweepTerminal(now = Date.now()): void {
  for (const [id, e] of runs) {
    if (TERMINAL_STATUSES.has(e.status) && now - e.createdAt > TERMINAL_TTL_MS) runs.delete(id);
  }
}

export function registerRun(entry: RunRegistryEntry): void {
  runs.set(entry.id, entry);
  sweepTerminal();
}

export function getRun(id: string): RunRegistryEntry | undefined {
  return runs.get(id);
}

export function transitionRunStatus(id: string, status: RunStatus): void {
  const e = runs.get(id);
  if (e) e.status = status;
}

export function removeRun(id: string): void {
  runs.delete(id);
}

export function listRunsByProject(projectId: string): RunRegistryEntry[] {
  return [...runs.values()].filter((e) => e.projectId === projectId);
}

export function listRunsByInstance(instanceKey: InstanceKey): RunRegistryEntry[] {
  return [...runs.values()].filter((e) => e.instanceKey === instanceKey);
}

/** 该项目是否有活跃运行（pending/running/paused）——迁移/删除前置检查。 */
export function hasActiveRuns(projectId: string): boolean {
  return listRunsByProject(projectId).some((e) => ACTIVE_STATUSES.has(e.status));
}

/** 中止某 run：触发 controller.abort()；活跃态置 aborted。返回是否找到。 */
export function abortRunEntry(id: string): boolean {
  const e = runs.get(id);
  if (!e) return false;
  e.controller?.abort();
  if (ACTIVE_STATUSES.has(e.status)) e.status = 'aborted';
  return true;
}

// ── sub-invocation ──────────────────────────────────────────────
export function registerSubInvocation(s: SubInvocation): void {
  subInvocations.set(s.subInvocationId, s);
}

export function getSubInvocation(subInvocationId: string): SubInvocation | undefined {
  return subInvocations.get(subInvocationId);
}

export function listSubInvocationsByRun(parentRunId: string): SubInvocation[] {
  return [...subInvocations.values()].filter((s) => s.parentRunId === parentRunId);
}

export function removeSubInvocation(subInvocationId: string): void {
  subInvocations.delete(subInvocationId);
}

/**
 * 生成 subInvocationId：<runId>:<graphNodeId>:<iteration>:<rand8>。
 * provider 类不变，Router 把它作为 options.invocationId 透传给 spawnCli 登记 PID。
 */
export function formatSubInvocationId(
  runId: string,
  graphNodeId: string,
  iteration: number,
  random?: string,
): string {
  const r = random ?? (globalThis.crypto?.randomUUID()?.slice(0, 8) ?? String(Date.now().toString(36)));
  return `${runId}:${graphNodeId}:${iteration}:${r}`;
}
