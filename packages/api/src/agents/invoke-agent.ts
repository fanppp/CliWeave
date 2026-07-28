/**
 * invokeAgentWithPolicy —— 统一的 CLI 节点调用核心（provider 无关）。
 *
 * 由 runAgentNode（图运行）与单节点消息端点共用，保证：
 * - provider 自己完成受保护的 resume→fresh fallback（无实质输出才回退）；本函数**不自重试**（防双执行）。
 * - session_fallback 是诊断（非终态）：经 onMessage 流出 + 置 resumeFallback；error 不中途流出。
 * - 唯一终态：ok/error/aborted 由返回值表达，调用方据此发**一个**终态事件。
 * - active 模式才读写 active-session（getActiveSession/setActiveSession 仅 active 时被调）。
 *
 * onMessage 收原始 AgentMessage：图运行把它包成 node_message GraphEvent；单节点直接 broadcast。
 */
import type { AgentService } from './AgentService.js';
import type { AgentMessage } from './types.js';
import type { SessionPolicy, NodeOutcome } from './session-policy.js';

export interface InvokeAgentDeps {
  service: AgentService;
  /** 裸 nodeKey（AgentMessage.nodeId + 诊断/错误文案用）。 */
  nodeId: string;
  workingDirectory: string;
  /** 每条 AgentMessage 的流式回调。调用方负责包装成 GraphEvent 或直接 broadcast。 */
  onMessage: (message: AgentMessage) => void;
  signal?: AbortSignal;
  invocationId?: string;
  runId?: string;
  /** active 模式专用：读写 active-session.json。图运行不传 active → 不会被调。 */
  getActiveSession?: () => string | undefined;
  setActiveSession?: (sid: string) => void;
}

export interface InvokeAgentParams extends InvokeAgentDeps {
  prompt: string;
  policy: SessionPolicy;
}

export async function invokeAgentWithPolicy(p: InvokeAgentParams): Promise<NodeOutcome> {
  const { service, nodeId, prompt, policy, workingDirectory, onMessage, signal, invocationId, runId, getActiveSession, setActiveSession } = p;
  const persistActive = policy.mode === 'active';
  const resumeSid =
    policy.mode === 'active' ? getActiveSession?.() : policy.mode === 'resume' ? policy.sessionId : undefined;

  let sessionId = '';
  let resumeFallback = false;
  let errMsg = '';
  const texts: string[] = [];

  for await (const msg of service.invoke(prompt, {
    ...(resumeSid != null ? { sessionId: resumeSid } : {}),
    workingDirectory,
    ...(invocationId ? { invocationId } : {}),
    ...(runId ? { runId } : {}),
    ...(signal ? { signal } : {}),
  })) {
    if (msg.type === 'session_init') {
      sessionId = msg.sessionId;
      if (persistActive) setActiveSession?.(msg.sessionId);
      continue;
    }
    if (msg.type === 'session_fallback') {
      // 诊断（非终态）：流出 + 置 flag；provider 内部已 fresh 重试，本函数不自重试
      resumeFallback = true;
      onMessage(msg);
      continue;
    }
    if (msg.type === 'done') continue; // 终态标记，由返回值驱动调用方发终态
    if (msg.type === 'error') {
      // 吞入，不中途发 error（保证唯一终态）；终态 error 由调用方据返回值发一次
      errMsg = msg.error;
      continue;
    }
    if (msg.type === 'text' && !msg.content.startsWith('[notice]')) texts.push(msg.content);
    onMessage(msg);
  }

  if (signal?.aborted) {
    return { status: 'aborted', ...(sessionId ? { sessionId } : {}), ...(resumeFallback ? { resumeFallback } : {}) };
  }
  if (errMsg) {
    return { status: 'error', error: errMsg, ...(sessionId ? { sessionId } : {}), ...(resumeFallback ? { resumeFallback } : {}) };
  }
  const finalText = texts.at(-1) ?? '';
  if (!finalText) {
    const error = `node '${nodeId}' produced no valid text output`;
    return { status: 'error', error, ...(sessionId ? { sessionId } : {}), ...(resumeFallback ? { resumeFallback } : {}) };
  }
  return { status: 'ok', finalText, ...(sessionId ? { sessionId } : {}), ...(resumeFallback ? { resumeFallback } : {}) };
}
