/**
 * SessionPolicy —— 节点调用边界的会话策略。
 *
 * - active：单节点聊天，读写节点 active-session.json（legacy）。图运行永不传此模式。
 * - fresh：图节点首执行 / evaluator / node_only —— 启新 CLI session，session_init 的 sessionId
 *   只回 NodeOutcome.sessionId（run-scoped），不落 active-session.json。
 * - resume：同一 gate 的 worker revision，复用上次 sessionId。provider 在 resume 不可用且
 *   **无实质输出** 时发 session_fallback 诊断并内部 fresh 重试一次（用 ${invocationId}:fb 独立审计）；
 *   Router/调用方仅观察 session_fallback 置 resumeFallback，**不自重试**（防双执行）。
 *
 * 画布图运行完全不读/不写 active-session.json；跨轮记忆来自 Thread（Step 2+），不依赖恢复上一轮 CLI session。
 */
export type SessionPolicy =
  | { mode: 'active' }
  | { mode: 'fresh'; persistActive: false }
  | { mode: 'resume'; sessionId: string; persistActive: false };

export interface NodeOutcome {
  status: 'ok' | 'error' | 'aborted';
  finalText?: string;
  /** CLI session_init 返回的 sessionId（run-scoped，供同一 gate 的 worker revision resume）。 */
  sessionId?: string;
  /** provider 发了 session_fallback（resume 回退 fresh）时置 true（诊断）。 */
  resumeFallback?: boolean;
  error?: string;
}
