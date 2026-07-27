'use client';

import { create } from 'zustand';
import { useGraphRunStore } from './graphRunStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

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

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentId: 'default',
  loadProjects: async () => {
    try {
      const res = await fetch(`${API_URL}/api/projects`);
      if (res.ok) {
        const list = (await res.json()) as ProjectMeta[];
        set({ projects: list });
        if (!list.some((p) => p.id === get().currentId)) {
          set({ currentId: list[0]?.id ?? 'default' });
        }
      }
    } catch {
      // 忽略
    }
  },
  createProject: async (name, path) => {
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
    // 切换 graphRunStore 到新画布
    useGraphRunStore.getState().setProjectId(meta.id);
    await useGraphRunStore.getState().loadProjectGraph();
    return meta.id;
  },
  switchProject: (id) => {
    set({ currentId: id });
    useGraphRunStore.getState().setProjectId(id);
    void useGraphRunStore.getState().loadProjectGraph();
  },
}));
