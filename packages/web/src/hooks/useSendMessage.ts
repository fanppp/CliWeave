'use client';

import { useState } from 'react';
import { useChatStore } from '../stores/chatStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

export function useSendMessage(): {
  handleSend: (text: string) => Promise<void>;
  handleAbort: () => Promise<void>;
  sending: boolean;
} {
  const projectId = useChatStore((s) => s.projectId);
  const activeNodeId = useChatStore((s) => s.activeNodeId);
  const activeInstanceKey = useChatStore((s) => s.activeInstanceKey);
  const joinedInstanceKey = useChatStore((s) => s.joinedInstanceKey);
  const addUser = useChatStore((s) => s.addUser);
  const setStreaming = useChatStore((s) => s.setStreaming);
  const setInvocationId = useChatStore((s) => s.setInvocationId);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const [sending, setSending] = useState(false);

  const handleSend = async (text: string): Promise<void> => {
    const content = text.trim();
    if (!content || sending || isStreaming) return;
    // join ack 守卫：未入 room 前不发（防丢首批流事件）
    if (!activeInstanceKey || joinedInstanceKey !== activeInstanceKey) {
      setStreaming(false);
      return;
    }
    const pid = projectId;
    const node = activeNodeId;
    setSending(true);
    addUser(content); // 乐观插入用户消息
    try {
      const res = await fetch(`${API_URL}/api/projects/${pid}/nodes/${encodeURIComponent(node)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        setStreaming(false);
        return;
      }
      // 竞态：fetch 期间若已切项目/节点，丢弃结果
      if (useChatStore.getState().projectId !== pid || useChatStore.getState().activeNodeId !== node) {
        setStreaming(false);
        return;
      }
      const data = (await res.json()) as { invocationId?: string };
      if (data.invocationId) setInvocationId(data.invocationId);
    } catch {
      setStreaming(false);
    } finally {
      setSending(false);
    }
  };

  const handleAbort = async (): Promise<void> => {
    const invocationId = useChatStore.getState().currentInvocationId;
    const pid = useChatStore.getState().projectId;
    if (!invocationId) return;
    try {
      await fetch(`${API_URL}/api/projects/${pid}/messages/${invocationId}/abort`, { method: 'POST' });
    } catch {
      // ignore
    }
  };

  return { handleSend, handleAbort, sending };
}
