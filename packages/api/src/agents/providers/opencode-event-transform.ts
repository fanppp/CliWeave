/**
 * opencode CLI 事件 → AgentMessage 转换
 * opencode run --format json 实测格式：
 *   {type:step_start, sessionID, part:{type:step-start}} → session_init
 *   {type:text, part:{type:text, text}} → text
 *   {type:tool_start, part:{type:tool-start, tool}} → tool_use
 *   {type:step_finish, part:{tokens, cost}} → done
 */
import type { AgentMessage, MessageMetadata, NodeId } from '../types.js';

type RawEvent = Record<string, unknown>;
const ts = (): number => Date.now();

export function transformOpenCodeEvent(event: unknown, nodeId: NodeId): AgentMessage[] {
  if (typeof event !== 'object' || event === null) return [];
  const e = event as RawEvent;
  const type = e.type;
  const part = (e.part as RawEvent | undefined) ?? {};
  const metadata: MessageMetadata = { provider: 'opencode' };
  const sessionId = typeof e.sessionID === 'string' ? e.sessionID : (typeof part.sessionID === 'string' ? part.sessionID : undefined);

  if (type === 'step_start' && sessionId) {
    return [{ type: 'session_init', nodeId, sessionId, timestamp: ts(), metadata }];
  }
  if (type === 'text' && typeof part.text === 'string') {
    return [{ type: 'text', nodeId, content: part.text, timestamp: ts(), metadata }];
  }
  if (type === 'tool_start') {
    const toolName = typeof part.tool === 'string' ? part.tool : 'tool';
    return [{ type: 'tool_use', nodeId, toolName, toolInput: {}, timestamp: ts(), metadata }];
  }
  if (type === 'step_finish') {
    const tokens = part.tokens as RawEvent | undefined;
    if (tokens) {
      metadata.usage = {
        ...(typeof tokens.input === 'number' ? { inputTokens: tokens.input } : {}),
        ...(typeof tokens.output === 'number' ? { outputTokens: tokens.output } : {}),
        ...(typeof (tokens.cache as RawEvent | undefined)?.read === 'number' ? { cacheReadTokens: (tokens.cache as RawEvent).read as number } : {}),
      };
    }
    return [{ type: 'done', nodeId, timestamp: ts(), metadata }];
  }
  return [];
}
