/**
 * Agent 消息类型
 * 所有 CLI provider 输出统一转成 AgentMessage 判别联合。
 * 借鉴 clowder-ai domains/cats/services/types.ts，字段名 catId → nodeId。
 */

export type NodeId = string;

export interface HistoryEntry {
  role: 'user' | 'agent';
  content: string;
  type?: string;
  toolName?: string;
  timestamp: number;
}

export interface MessageMetadata {
  provider?: string;
  model?: string;
  sessionId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
  };
}

export type AgentMessage =
  | { type: 'session_init'; nodeId: NodeId; sessionId: string; timestamp: number; metadata?: MessageMetadata }
  | { type: 'text'; nodeId: NodeId; content: string; timestamp: number; metadata?: MessageMetadata }
  | {
      type: 'tool_use';
      nodeId: NodeId;
      toolName: string;
      toolInput?: Record<string, unknown>;
      timestamp: number;
      metadata?: MessageMetadata;
    }
  | { type: 'tool_result'; nodeId: NodeId; content: string; timestamp: number; metadata?: MessageMetadata }
  | { type: 'error'; nodeId: NodeId; error: string; timestamp: number; metadata?: MessageMetadata }
  | { type: 'system_info'; nodeId: NodeId; content: string; timestamp: number }
  | { type: 'done'; nodeId: NodeId; timestamp: number; metadata?: MessageMetadata };

export function makeMessage<T extends AgentMessage>(msg: T): T {
  return msg;
}
