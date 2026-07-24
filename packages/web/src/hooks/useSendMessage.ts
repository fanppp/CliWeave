'use client';

import { useState } from 'react';
import { useChatStore } from '../stores/chatStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

export function useSendMessage(): {
  handleSend: (text: string) => Promise<void>;
  sending: boolean;
} {
  const activeNodeId = useChatStore((s) => s.activeNodeId);
  const addUser = useChatStore((s) => s.addUser);
  const setStreaming = useChatStore((s) => s.setStreaming);
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
      }
    } catch {
      setStreaming(false);
    } finally {
      setSending(false);
    }
  };

  return { handleSend, sending };
}
