'use client';

import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

/** 切换/刷新节点时加载该节点历史对话（仅显示，真实记忆在 CLI resume） */
export function useNodeHistory(): void {
  const projectId = useChatStore((s) => s.projectId);
  const activeNodeId = useChatStore((s) => s.activeNodeId);
  const activeInstanceKey = useChatStore((s) => s.activeInstanceKey);
  const reloadKey = useChatStore((s) => s.reloadKey);
  const loadHistory = useChatStore((s) => s.loadHistory);

  useEffect(() => {
    let cancelled = false;
    // 项目切换后，activeNodeId 暂时可能是该项目不存在的 fallback。
    // 只有 NodeSelector 从服务端节点列表确认 instanceKey 后才允许请求历史。
    if (!activeInstanceKey) {
      loadHistory([]);
      return () => { cancelled = true; };
    }
    // 竞态保护：捕获请求时的 projectId+node，返回后若已变则丢弃
    const pid = projectId;
    const node = activeNodeId;
    const instanceKey = activeInstanceKey;
    fetch(`${API_URL}/api/projects/${pid}/nodes/${encodeURIComponent(node)}/history`)
      .then((r) => (r.ok ? r.json() : { history: [] }))
      .then((d) => {
        if (cancelled) return;
        if (useChatStore.getState().projectId !== pid) return;
        if (useChatStore.getState().activeNodeId !== node) return;
        if (useChatStore.getState().activeInstanceKey !== instanceKey) return;
        if (Array.isArray(d.history)) loadHistory(d.history);
      })
      .catch(() => {
        if (!cancelled) loadHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, activeNodeId, activeInstanceKey, reloadKey, loadHistory]);
}
