/**
 * Codex NDJSON 事件 → AgentMessage 转换
 * 0.145.0 实测格式：
 *   thread.started → session_init
 *   item.completed{agent_message} → text
 *   item.completed{command_execution} → tool_use
 *   item.completed{file_change} → tool_use
 *   item.completed{error} → text (警告类，非致命)
 *   turn.completed → done (+usage)
 *   turn.started / 其余 → skip
 */
import type { AgentMessage, MessageMetadata, NodeId } from '../types.js';

type RawEvent = Record<string, unknown>;

function ts(): number {
  return Date.now();
}

export function transformCodexEvent(event: unknown, nodeId: NodeId): AgentMessage[] {
  if (typeof event !== 'object' || event === null) return [];
  const e = event as RawEvent;
  const type = e.type;

  if (type === 'thread.started' && typeof e.thread_id === 'string') {
    return [
      {
        type: 'session_init',
        nodeId,
        sessionId: e.thread_id,
        timestamp: ts(),
      },
    ];
  }

  if (type === 'item.completed' && e.item && typeof e.item === 'object') {
    const item = e.item as RawEvent;
    const itemType = item.type;
    const metadata: MessageMetadata = { provider: 'openai' };

    if (itemType === 'agent_message' && typeof item.text === 'string') {
      return [{ type: 'text', nodeId, content: item.text, timestamp: ts(), metadata }];
    }
    if (itemType === 'command_execution') {
      const toolInput: Record<string, unknown> = {};
      if (typeof item.command === 'string') toolInput.command = item.command;
      if (item.exit_code !== undefined) toolInput.exitCode = item.exit_code;
      return [
        {
          type: 'tool_use',
          nodeId,
          toolName: 'shell',
          toolInput,
          timestamp: ts(),
          metadata,
        },
      ];
    }
    if (itemType === 'file_change') {
      const toolInput: Record<string, unknown> = {};
      if (Array.isArray(item.changes)) toolInput.changes = item.changes;
      return [
        {
          type: 'tool_use',
          nodeId,
          toolName: 'edit',
          toolInput,
          timestamp: ts(),
          metadata,
        },
      ];
    }
    if (itemType === 'error' && typeof item.message === 'string') {
      // 非致命警告（如 deprecation），作为 text 可见但不中断
      return [{ type: 'text', nodeId, content: `[notice] ${item.message}`, timestamp: ts(), metadata }];
    }
  }

  if (type === 'turn.completed') {
    const metadata: MessageMetadata = { provider: 'openai' };
    const u = e.usage as RawEvent | undefined;
    if (u) {
      metadata.usage = {
        ...(typeof u.input_tokens === 'number' ? { inputTokens: u.input_tokens } : {}),
        ...(typeof u.output_tokens === 'number' ? { outputTokens: u.output_tokens } : {}),
        ...(typeof u.cached_input_tokens === 'number' ? { cacheReadTokens: u.cached_input_tokens } : {}),
      };
    }
    return [{ type: 'done', nodeId, timestamp: ts(), metadata }];
  }

  // turn.started 等其余事件跳过
  return [];
}
