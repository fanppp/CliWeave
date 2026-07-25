import { create } from 'zustand';

export type AgentEventType =
  | 'session_init'
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'error'
  | 'system_info'
  | 'done';

export interface AgentEvent {
  type: AgentEventType;
  nodeId: string;
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  sessionId?: string;
  error?: string;
  metadata?: { model?: string; usage?: Record<string, number> };
  timestamp: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  toolName?: string;
  eventType?: AgentEventType;
  timestamp: number;
}

export interface HistoryEntry {
  role: 'user' | 'agent';
  content: string;
  type?: string;
  toolName?: string;
  timestamp: number;
}

function entryToChatMessage(e: HistoryEntry, i: number): ChatMessage {
  if (e.role === 'user') {
    return { id: `h${i}`, role: 'user', content: e.content, timestamp: e.timestamp };
  }
  const isTool = e.type === 'tool_use';
  const isErr = e.type === 'error';
  return {
    id: `h${i}`,
    role: isErr ? 'system' : 'agent',
    content: e.content,
    toolName: e.toolName,
    eventType: (e.type as AgentEventType) ?? 'text',
    timestamp: e.timestamp,
  };
}

interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  activeNodeId: string;
  reloadKey: number;
  setActiveNode: (id: string) => void;
  addUser: (content: string) => void;
  pushAgentEvent: (event: AgentEvent) => void;
  loadHistory: (entries: HistoryEntry[]) => void;
  triggerReload: () => void;
  setStreaming: (streaming: boolean) => void;
  clear: () => void;
}

let seq = 0;
const nextId = (): string => `m${Date.now()}_${seq++}`;

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isStreaming: false,
  activeNodeId: 'codex:codex-node',
  reloadKey: 0,
  setActiveNode: (id) => set({ activeNodeId: id }),
  addUser: (content) =>
    set((s) => ({
      messages: [...s.messages, { id: nextId(), role: 'user', content, timestamp: Date.now() }],
      isStreaming: true,
    })),
  pushAgentEvent: (event) =>
    set((s) => {
      if (event.type === 'done') {
        return { ...s, isStreaming: false, reloadKey: s.reloadKey + 1 };
      }
      if (event.type === 'session_init') {
        return { ...s, reloadKey: s.reloadKey + 1 }; // 不显示气泡，但刷新会话列表
      }
      const role: ChatMessage['role'] = event.type === 'error' ? 'system' : 'agent';
      let content = event.content ?? '';
      if (event.type === 'tool_use') {
        content = JSON.stringify(event.toolInput ?? {}, null, 2);
      }
      if (event.type === 'error') {
        content = event.error ?? content;
      }
      const msg: ChatMessage = {
        id: nextId(),
        role,
        content,
        eventType: event.type,
        toolName: event.toolName,
        timestamp: event.timestamp,
      };
      return { ...s, messages: [...s.messages, msg] };
    }),
  loadHistory: (entries) =>
    set({
      messages: entries.map(entryToChatMessage),
      isStreaming: false,
    }),
  triggerReload: () => set((s) => ({ reloadKey: s.reloadKey + 1 })),
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  clear: () => set({ messages: [], isStreaming: false }),
}));
