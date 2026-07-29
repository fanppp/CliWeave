'use client';

import { create } from 'zustand';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';
const ACTIVE_KEY = '0agentteams.activeThread:';

export interface ThreadMeta {
  schemaVersion: 1;
  id: string;
  projectId: string;
  title: string;
  revision: number;
  activeRunId: string | null;
  createdAt: number;
  updatedAt: number;
  lastTurnPreview?: string;
}

interface ThreadState {
  projectId: string;
  threads: ThreadMeta[];
  activeThreadId: string | null;
  loading: boolean;
  loadProject: (projectId: string) => Promise<void>;
  selectThread: (threadId: string | null) => void;
  createConversation: () => Promise<void>;
  prepareRun: () => Promise<{ threadId: string; expectedThreadRevision: number } | null>;
  adoptCreatedThread: (threadId: string, revision: number) => Promise<void>;
  handleCommitted: (threadId: string) => Promise<void>;
}

function stored(projectId: string): string | null {
  try { return window.localStorage.getItem(ACTIVE_KEY + projectId); } catch { return null; }
}
function persist(projectId: string, threadId: string | null): void {
  try {
    if (threadId) window.localStorage.setItem(ACTIVE_KEY + projectId, threadId);
    else window.localStorage.removeItem(ACTIVE_KEY + projectId);
  } catch { /* storage unavailable */ }
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  projectId: 'default',
  threads: [],
  activeThreadId: null,
  loading: false,
  loadProject: async (projectId) => {
    set({ projectId, threads: [], activeThreadId: null, loading: true });
    try {
      const res = await fetch(`${API_URL}/api/projects/${encodeURIComponent(projectId)}/threads`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { threads } = await res.json() as { threads: ThreadMeta[] };
      if (get().projectId !== projectId) return;
      const remembered = stored(projectId);
      const active = threads.find((t) => t.id === remembered)?.id ?? threads[0]?.id ?? null;
      persist(projectId, active);
      set({ threads, activeThreadId: active, loading: false });
    } catch {
      if (get().projectId === projectId) set({ loading: false });
    }
  },
  selectThread: (threadId) => {
    persist(get().projectId, threadId);
    set({ activeThreadId: threadId });
  },
  createConversation: async () => {
    const projectId = get().projectId;
    const res = await fetch(`${API_URL}/api/projects/${encodeURIComponent(projectId)}/threads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '新对话' }),
    });
    if (!res.ok) throw new Error(`创建对话失败: ${res.status}`);
    const thread = await res.json() as ThreadMeta;
    if (get().projectId !== projectId) return;
    persist(projectId, thread.id);
    set((s) => ({ threads: [thread, ...s.threads.filter((t) => t.id !== thread.id)], activeThreadId: thread.id }));
  },
  prepareRun: async () => {
    const { projectId, activeThreadId } = get();
    if (!activeThreadId) return null;
    const res = await fetch(`${API_URL}/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(activeThreadId)}`);
    if (!res.ok) {
      if (res.status === 404) { persist(projectId, null); set({ activeThreadId: null }); return null; }
      throw new Error(`读取对话失败: ${res.status}`);
    }
    const { thread } = await res.json() as { thread: ThreadMeta };
    if (thread.activeRunId) throw new Error('当前对话已有运行，请等待或中止后再试');
    set((s) => ({ threads: [thread, ...s.threads.filter((t) => t.id !== thread.id)] }));
    return { threadId: thread.id, expectedThreadRevision: thread.revision };
  },
  adoptCreatedThread: async (threadId, revision) => {
    const projectId = get().projectId;
    persist(projectId, threadId);
    set({ activeThreadId: threadId });
    // create /run 已 open turn；先放入最小状态，终态事件后刷新完整列表。
    set((s) => {
      const existing = s.threads.find((t) => t.id === threadId);
      const thread = existing
        ? { ...existing, revision }
        : { schemaVersion: 1 as const, id: threadId, projectId, title: '新对话', revision, activeRunId: null, createdAt: Date.now(), updatedAt: Date.now() };
      return { threads: [thread, ...s.threads.filter((t) => t.id !== threadId)] };
    });
  },
  handleCommitted: async (threadId) => {
    if (get().activeThreadId !== threadId) return;
    await get().loadProject(get().projectId);
    get().selectThread(threadId);
  },
}));
