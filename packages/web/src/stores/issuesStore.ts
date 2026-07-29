'use client';

import { create } from 'zustand';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

export interface Issue {
  issueId: string;
  status: 'observed' | 'confirmed' | 'open' | 'resolved' | 'accepted' | 'superseded';
  title: string;
  detail: string;
  severity?: 'info' | 'warning' | 'blocking';
  source: { runId?: string; nodeId?: string; gateId?: string; criterionId?: string };
  occurrences: number;
  evidence: string[];
}

interface IssuesState {
  projectId: string | null;
  issues: Issue[];
  loading: boolean;
  error: string | null;
  lastSummarizeAt: number | null;
  load: (projectId: string) => Promise<void>;
  refresh: () => Promise<void>;
  act: (issueId: string, action: 'confirm' | 'resolve' | 'accept' | 'reopen') => Promise<void>;
  publish: () => Promise<void>;
  summarize: () => Promise<void>;
}

export const useIssuesStore = create<IssuesState>((set, get) => ({
  projectId: null,
  issues: [],
  loading: false,
  error: null,
  lastSummarizeAt: null,
  load: async (projectId: string) => {
    set({ projectId, loading: true, error: null });
    try {
      const res = await fetch(`${API_URL}/api/projects/${projectId}/issues`, { cache: 'no-store' });
      const data = await res.json() as { issues: Issue[] };
      set({ issues: data.issues ?? [], loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },
  refresh: async () => {
    const pid = get().projectId;
    if (pid) await get().load(pid);
  },
  act: async (issueId, action) => {
    const pid = get().projectId;
    if (!pid) return;
    try {
      await fetch(`${API_URL}/api/projects/${pid}/issues/${issueId}/${action}`, { method: 'POST' });
      await get().refresh();
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
  publish: async () => {
    const pid = get().projectId;
    if (!pid) return;
    try {
      const res = await fetch(`${API_URL}/api/projects/${pid}/issues/publish`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        set({ error: err.error ?? `publish failed (${res.status})` });
      }
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
  summarize: async () => {
    const pid = get().projectId;
    if (!pid) return;
    try {
      set({ error: null });
      const res = await fetch(`${API_URL}/api/projects/${pid}/issues/summarize`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        set({ error: err.error ?? `summarize failed (${res.status})` });
      } else {
        set({ lastSummarizeAt: Date.now() });
      }
      await get().refresh();
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
}));
