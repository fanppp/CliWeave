'use client';

import { useState } from 'react';
import { useChatStore } from '../stores/chatStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

export function useSendMessage(): {
  handleSend: (text: string) => Promise<void>;
  handleAbort: () => Promise<void>;
  sending: boolean;
} {
  const activeNodeId = useChatStore((s) => s.activeNodeId);
  const addUser = useChatStore((s) => s.addUser);
  const setStreaming = useChatStore((s) => s.setStreaming);
  const setInvocationId = useChatStore((s) => s.setInvocationId);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const [sending, setSending] = useState(false);

  const handleSend = async (text: string): Promise<void> => {
    const content = text.trim();
    if (!content || sending || isStreaming) return;
    setSending(true);
    addUser(content); // 乐观插入用户消息
    try {
      const res = await fetch(`${API_URL}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, nodeId: activeNodeId }),
      });
      if (!res.ok) {
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
    if (!invocationId) return;
    try {
      await fetch(`${API_URL}/api/messages/${invocationId}/abort`, { method: 'POST' });
    } catch {
      // ignore
    }
  };

  return { handleSend, handleAbort, sending };
}
