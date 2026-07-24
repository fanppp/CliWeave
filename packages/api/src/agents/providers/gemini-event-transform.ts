/**
 * gemini CLI 事件 → AgentMessage 转换（按 clowder-ai 文档，待实测校准）
 * gemini -p -o stream-json 格式：
 *   {type:init, session_id} → session_init
 *   {type:message, role:assistant, content} → text
 *   {type:tool_use, tool_name, parameters} → tool_use
 *   {type:result, status:success/error} → done/error
 */
import type { AgentMessage, MessageMetadata, NodeId } from '../types.js';

type RawEvent = Record<string, unknown>;
const ts = (): number => Date.now();

export function transformGeminiEvent(event: unknown, nodeId: NodeId): AgentMessage[] {
  if (typeof event !== 'object' || event === null) return [];
  const e = event as RawEvent;
  const type = e.type;
  const metadata: MessageMetadata = { provider: 'google' };

  if (type === 'init' && typeof e.session_id === 'string') {
    return [{ type: 'session_init', nodeId, sessionId: e.session_id, timestamp: ts(), metadata }];
  }
  if (type === 'message' && e.role === 'assistant' && typeof e.content === 'string') {
    return [{ type: 'text', nodeId, content: e.content, timestamp: ts(), metadata }];
  }
  if (type === 'tool_use' && typeof e.tool_name === 'string') {
    return [{ type: 'tool_use', nodeId, toolName: e.tool_name, toolInput: (e.parameters as Record<string, unknown>) ?? {}, timestamp: ts(), metadata }];
  }
  if (type === 'result') {
    if (e.status === 'success') return [{ type: 'done', nodeId, timestamp: ts(), metadata }];
    const err = typeof e.error === 'string' ? e.error : 'Gemini 错误';
    return [{ type: 'error', nodeId, error: err, timestamp: ts(), metadata }];
  }
  return [];
}
