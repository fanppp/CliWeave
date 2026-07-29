/**
 * Durable Pause/Resume 检查点协议（V4/V5 gate 共用；#11 加 clarify kind）。
 *
 * - V4 HarnessCheckpoint 显式标 runner:'v4'/kind:'gate'；旧 JSONL 无此二字段时按 v4-gate 回退（parseDurableCheckpoint）。
 * - V5 gate 检查点 runner:'v5'/kind:'gate'，含 plan/routeDecision + walkLane 全部可恢复状态。
 * - token 只经 WS/API 返回；JSONL 只存 hash（recordRunEvent 拒 raw resumeToken）；恒定时间比较 + 过期。
 *
 * 本模块只含纯逻辑（可单测）；实际 pause/resume 编排在 EvaluatorOptimizerRouter（V4）与 V5Router（V5）。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { HarnessCheckpoint, ResumeAction } from './EvaluatorOptimizerRouter.js';
import type { RunPlan, RouteDecision } from './routing.js';
import type { Candidate } from './evaluation.js';

export type { ResumeAction } from './EvaluatorOptimizerRouter.js';

/** resume token 有效期 24h（与 V4 一致）。 */
export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** V5 gate 检查点：walkLane 在 gate 耗尽/阻塞 ask_user 时落盘的全部可恢复状态。 */
export interface V5GateCheckpoint {
  runner: 'v5';
  kind: 'gate';
  schemaVersion: 1;
  branchId: string;
  plan: RunPlan;
  routeDecision: RouteDecision;
  nodeId: string;
  upstreamArtifact: string;
  candidates: Candidate[];
  currentCandidateId: string;
  workerSessionId?: string;
  gateIndex: number;
  gateCounts: Record<string, number>;
  degraded: boolean;
  unresolvedGateIds: string[];
  exhausted: boolean;
  allowedActions: ResumeAction[];
  bestCandidateId?: string;
  pauseReason: 'exhausted' | 'blocked' | 'malformed';
  tokenHash: string;
  expiresAt: number;
}

/** V5 clarify 检查点：Router 判定 clarify（缺关键信息）时落盘的路由状态，resume 补充文本后同 run 重跑 Router。 */
export interface V5ClarifyCheckpoint {
  runner: 'v5';
  kind: 'clarify';
  schemaVersion: 1;
  branchId: string;
  routeDecision: RouteDecision;
  originalPrompt: string;
  clarificationAttempts: number;
  tokenHash: string;
  expiresAt: number;
}

export type DurableCheckpoint = HarnessCheckpoint | V5GateCheckpoint | V5ClarifyCheckpoint;

/** 解析 JSONL branch_checkpoint.payload 为判别联合；旧 V4（无 runner/kind）回退 v4-gate。 */
export function parseDurableCheckpoint(raw: unknown): DurableCheckpoint {
  if (typeof raw !== 'object' || raw === null) throw new Error('invalid checkpoint payload');
  const r = raw as Record<string, unknown>;
  if (r.runner === 'v5' && r.kind === 'gate') return raw as V5GateCheckpoint;
  if (r.runner === 'v5' && r.kind === 'clarify') return raw as V5ClarifyCheckpoint;
  return raw as HarnessCheckpoint;
}

export function isV5GateCheckpoint(cp: DurableCheckpoint): cp is V5GateCheckpoint {
  return (cp as { runner?: string }).runner === 'v5' && (cp as { kind?: string }).kind === 'gate';
}

export function isV5ClarifyCheckpoint(cp: DurableCheckpoint): cp is V5ClarifyCheckpoint {
  return (cp as { runner?: string }).runner === 'v5' && (cp as { kind?: string }).kind === 'clarify';
}

/** 恒定时间比较 + 过期校验（V4/V5 通用）。 */
export function verifyDurableToken(cp: DurableCheckpoint, token: string): boolean {
  if (cp.expiresAt < Date.now()) return false;
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(cp.tokenHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 该 checkpoint 允许的恢复动作（无 best 时不包含 continue_best；旧 V4 无 allowedActions 回退全三种；clarify 不用 action）。 */
export function allowedDurableActions(cp: DurableCheckpoint): ResumeAction[] {
  return (cp as { allowedActions?: ResumeAction[] }).allowedActions ?? (['continue_best', 'revise_once', 'fail'] as ResumeAction[]);
}

export function isAllowedDurableAction(cp: DurableCheckpoint, action: string): boolean {
  return allowedDurableActions(cp).includes(action as ResumeAction);
}
