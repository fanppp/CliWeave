'use client';

import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

/** 切换/刷新节点时加载该节点历史对话（仅显示，真实记忆在 CLI resume） */
export function useNodeHistory(): void {
  const activeNodeId = useChatStore((s) => s.activeNodeId);
  const reloadKey = useChatStore((s) => s.reloadKey);
  const loadHistory = useChatStore((s) => s.loadHistory);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/agents/${encodeURIComponent(activeNodeId)}/history`)
      .then((r) => (r.ok ? r.json() : { history: [] }))
      .then((d) => {
        if (!cancelled && Array.isArray(d.history)) {
          loadHistory(d.history);
        }
      })
      .catch(() => {
        if (!cancelled) loadHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeNodeId, reloadKey, loadHistory]);
}
