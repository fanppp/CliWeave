'use client';

import { create } from 'zustand';
import { useChatStore } from './chatStore';
import { useGraphRunStore } from './graphRunStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';
const CURRENT_PROJECT_KEY = 'cliweave.currentProject';

/** 切换画布前的统一仲裁：单节点消息或图运行忙时拒绝（防 abort 拿新 projectId 杀旧 invocation、防状态分裂）。 */
export function canSwitchProject(): boolean {
  const chatBusy = useChatStore.getState().isStreaming;
  const graphStatus = useGraphRunStore.getState().status;
  const graphBusy = graphStatus === 'starting' || graphStatus === 'running';
  return !chatBusy && !graphBusy;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  path?: string;
  pathMissing?: boolean;
}

interface ProjectState {
  projects: ProjectMeta[];
  currentId: string;
  loadProjects: () => Promise<void>;
  createProject: (name: string, path: string) => Promise<string>; // 返回新 id
  switchProject: (id: string) => void;
}

function readStoredCurrentId(): string {
  try {
    return window.localStorage.getItem(CURRENT_PROJECT_KEY) ?? 'default';
  } catch {
    return 'default';
  }
}
function writeStoredCurrentId(id: string): void {
  try {
    window.localStorage.setItem(CURRENT_PROJECT_KEY, id);
  } catch {
    // 忽略
  }
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentId: 'default',
  loadProjects: async () => {
    try {
      const res = await fetch(`${API_URL}/api/projects`);
      if (res.ok) {
        const list = (await res.json()) as ProjectMeta[];
        const stored = readStoredCurrentId();
        // 恢复上次画布：若存储的 id 仍在列表中则用它，否则取第一项/default
        const restore = list.some((p) => p.id === stored) ? stored : (list[0]?.id ?? 'default');
        set({ projects: list, currentId: restore });
        writeStoredCurrentId(restore);
        // 联动 graphRunStore + chatStore 到恢复的画布
        if (useGraphRunStore.getState().projectId !== restore) {
          useGraphRunStore.getState().setProjectId(restore);
          await useGraphRunStore.getState().loadProjectGraph();
        }
        useChatStore.getState().setProjectId(restore);
      }
    } catch {
      // 忽略
    }
  },
  createProject: async (name, path) => {
    if (!canSwitchProject()) throw new Error('请先停止当前运行再创建画布');
    const res = await fetch(`${API_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `创建失败 HTTP ${res.status}`);
    }
    const meta = (await res.json()) as ProjectMeta;
    set((s) => ({ projects: [...s.projects, meta], currentId: meta.id }));
    writeStoredCurrentId(meta.id);
    useGraphRunStore.getState().setProjectId(meta.id);
    await useGraphRunStore.getState().loadProjectGraph();
    useChatStore.getState().setProjectId(meta.id);
    return meta.id;
  },
  switchProject: (id) => {
    if (!canSwitchProject()) throw new Error('请先停止当前运行再切换画布');
    set({ currentId: id });
    writeStoredCurrentId(id);
    useGraphRunStore.getState().setProjectId(id);
    void useGraphRunStore.getState().loadProjectGraph();
    useChatStore.getState().setProjectId(id);
  },
}));
