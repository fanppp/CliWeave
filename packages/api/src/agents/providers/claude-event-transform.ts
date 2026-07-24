/**
 * Claude Code CLI 事件 → AgentMessage 转换
 * claude 2.1.100 stream-json 实测格式：
 *   {type:system,subtype:init,session_id} → session_init
 *   {type:assistant,message.content[].type=text} → text
 *   {type:assistant,message.content[].type=tool_use} → tool_use
 *   {type:assistant,message.content[].type=thinking} → skip
 *   {type:result,subtype:success,usage} → done
 *   {type:result,subtype:error,error} → error
 */
import type { AgentMessage, MessageMetadata, NodeId } from '../types.js';

type RawEvent = Record<string, unknown>;

function ts(): number {
  return Date.now();
}

export function transformClaudeEvent(event: unknown, nodeId: NodeId): AgentMessage[] {
  if (typeof event !== 'object' || event === null) return [];
  const e = event as RawEvent;
  const type = e.type;
  const metadata: MessageMetadata = { provider: 'anthropic' };

  if (type === 'system' && e.subtype === 'init' && typeof e.session_id === 'string') {
    if (typeof e.model === 'string') metadata.model = e.model;
    return [{ type: 'session_init', nodeId, sessionId: e.session_id, timestamp: ts(), metadata }];
  }

  if (type === 'assistant' && e.message && typeof e.message === 'object') {
    const msg = e.message as RawEvent;
    const content = msg.content;
    if (!Array.isArray(content)) return [];
    const out: AgentMessage[] = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as RawEvent;
      if (b.type === 'text' && typeof b.text === 'string') {
        out.push({ type: 'text', nodeId, content: b.text, timestamp: ts(), metadata });
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        out.push({
          type: 'tool_use',
          nodeId,
          toolName: b.name,
          toolInput: (b.input as Record<string, unknown>) ?? {},
          timestamp: ts(),
          metadata,
        });
      }
      // thinking 块跳过
    }
    return out;
  }

  if (type === 'result') {
    if (e.subtype === 'success') {
      if (typeof e.usage === 'object' && e.usage !== null) {
        const u = e.usage as RawEvent;
        metadata.usage = {
          ...(typeof u.input_tokens === 'number' ? { inputTokens: u.input_tokens } : {}),
          ...(typeof u.output_tokens === 'number' ? { outputTokens: u.output_tokens } : {}),
          ...(typeof u.cache_read_input_tokens === 'number' ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
        };
      }
      return [{ type: 'done', nodeId, timestamp: ts(), metadata }];
    }
    if (e.subtype === 'error' || e.is_error === true) {
      const err = typeof e.error === 'string' ? e.error : (typeof e.result === 'string' ? e.result : 'Claude 错误');
      return [{ type: 'error', nodeId, error: err, timestamp: ts(), metadata }];
    }
  }

  return [];
}
