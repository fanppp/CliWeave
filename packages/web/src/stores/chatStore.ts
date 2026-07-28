import { create } from 'zustand';

export type AgentEventType =
  | 'session_init'
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'error'
  | 'system_info'
  | 'session_fallback'
  | 'done';

export interface AgentEvent {
  type: AgentEventType;
  nodeId: string;
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  sessionId?: string;
  error?: string;
  previousSessionId?: string;
  reason?: string;
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
  projectId: string;
  activeNodeId: string;
  /** 当前激活节点的 instanceKey（projectId:nodeKey），由 NodeSelector 从节点列表项设置，禁组件内拼模板。 */
  activeInstanceKey: string | null;
  /** 已 join 成功的 instanceKey；ack 守卫：只在 activeInstanceKey===请求键 且 socket 不变 且 ok 时写入。 */
  joinedInstanceKey: string | null;
  reloadKey: number;
  currentInvocationId: string | null;
  setProjectId: (id: string) => void;
  setActiveNode: (id: string, instanceKey?: string) => void;
  setActiveInstanceKey: (key: string | null) => void;
  setJoinedInstanceKey: (key: string | null) => void;
  hydrateActiveNode: () => void;
  addUser: (content: string) => void;
  pushAgentEvent: (event: AgentEvent) => void;
  loadHistory: (entries: HistoryEntry[]) => void;
  triggerReload: () => void;
  setStreaming: (streaming: boolean) => void;
  setInvocationId: (id: string | null) => void;
  clear: () => void;
}

let seq = 0;
const nextId = (): string => `m${Date.now()}_${seq++}`;

/** 项目级 active-node localStorage key（切项目不互相覆盖）。 */
function activeNodeKey(pid: string): string {
  return `0agentteams.activeNodeKey:${pid}`;
}

function readActiveNodeForProject(pid: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(activeNodeKey(pid));
  } catch {
    return null;
  }
}
function persistActiveNodeForProject(pid: string, id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(activeNodeKey(pid), id);
  } catch {
    // Browser storage may be unavailable in private or restricted contexts.
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isStreaming: false,
  projectId: 'default',
  activeNodeId: 'codex:codex-node',
  activeInstanceKey: null,
  joinedInstanceKey: null,
  reloadKey: 0,
  currentInvocationId: null,
  // 原子切换：由 projectStore 在调用前仲裁（忙则根本不调）；一旦调用即无条件同步重置。
  setProjectId: (id) => {
    const saved = readActiveNodeForProject(id);
    set({
      projectId: id,
      activeNodeId: saved ?? 'codex:codex-node',
      activeInstanceKey: null,          // 等 NodeSelector 加载列表后从列表项设置
      joinedInstanceKey: null,          // 至 join ack
      messages: [],
      currentInvocationId: null,
      isStreaming: false,
      reloadKey: get().reloadKey + 1,   // 触发 NodeSelector/useNodeHistory/useSocket 重载/重 join
    });
  },
  setActiveNode: (id, instanceKey) => {
    persistActiveNodeForProject(get().projectId, id);
    set((s) => ({
      activeNodeId: id,
      ...(instanceKey ? { activeInstanceKey: instanceKey } : {}),
      joinedInstanceKey: null,          // 节点变了，旧 join 失效
      reloadKey: s.reloadKey + 1,
    }));
  },
  setActiveInstanceKey: (key) => set({ activeInstanceKey: key }),
  setJoinedInstanceKey: (key) => set({ joinedInstanceKey: key }),
  hydrateActiveNode: () => {
    if (typeof window === 'undefined') return;
    const saved = readActiveNodeForProject(get().projectId);
    if (saved) set({ activeNodeId: saved });
  },
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
      if (event.type === 'session_init' || event.type === 'session_fallback') {
        return s; // 不显示气泡；done 时统一刷新历史与会话列表
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
    set((s) => ({
      messages: entries.map(entryToChatMessage),
      isStreaming: s.isStreaming,
    })),
  triggerReload: () => set((s) => ({ reloadKey: s.reloadKey + 1 })),
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  setInvocationId: (id) => set({ currentInvocationId: id }),
  clear: () => set({ messages: [], isStreaming: false, currentInvocationId: null }),
}));
