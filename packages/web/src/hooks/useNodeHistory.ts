'use client';

import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

/** 切换/刷新节点时加载该节点历史对话（仅显示，真实记忆在 CLI resume） */
export function useNodeHistory(): void {
  const projectId = useChatStore((s) => s.projectId);
  const activeNodeId = useChatStore((s) => s.activeNodeId);
  const reloadKey = useChatStore((s) => s.reloadKey);
  const loadHistory = useChatStore((s) => s.loadHistory);

  useEffect(() => {
    let cancelled = false;
    // 竞态保护：捕获请求时的 projectId+node，返回后若已变则丢弃
    const pid = projectId;
    const node = activeNodeId;
    fetch(`${API_URL}/api/projects/${pid}/nodes/${encodeURIComponent(node)}/history`)
      .then((r) => (r.ok ? r.json() : { history: [] }))
      .then((d) => {
        if (cancelled) return;
        if (useChatStore.getState().projectId !== pid) return;
        if (useChatStore.getState().activeNodeId !== node) return;
        if (Array.isArray(d.history)) loadHistory(d.history);
      })
      .catch(() => {
        if (!cancelled) loadHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, activeNodeId, reloadKey, loadHistory]);
}
