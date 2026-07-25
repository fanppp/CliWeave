'use client';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useChatStore, type AgentEvent } from '../stores/chatStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

export function useSocket(): { connected: boolean } {
  const socketRef = useRef<Socket | null>(null);
  const activeNodeId = useChatStore((s) => s.activeNodeId);
  const pushAgentEvent = useChatStore((s) => s.pushAgentEvent);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socket = io(API_URL, {
      transports: ['websocket', 'polling'],
      autoConnect: false,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('join_node', activeNodeId);
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('agent_message', (msg: AgentEvent) => {
      pushAgentEvent(msg);
    });

    // React Strict Mode mounts, cleans up, then mounts again in development.
    // Deferring connect prevents the discarded mount from opening a WebSocket.
    const connectTimer = window.setTimeout(() => socket.connect(), 0);

    return () => {
      window.clearTimeout(connectTimer);
      socket.removeAllListeners();
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换节点时重新 join
  useEffect(() => {
    const socket = socketRef.current;
    if (socket && socket.connected) {
      socket.emit('join_node', activeNodeId);
    }
  }, [activeNodeId]);

  return { connected };
}
