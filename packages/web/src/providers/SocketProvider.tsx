'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

interface SocketContextValue {
  socket: Socket | null;
  connected: boolean;
}

const SocketContext = createContext<SocketContextValue>({ socket: null, connected: false });

export function useSocketConnection(): SocketContextValue {
  return useContext(SocketContext);
}

/**
 * 共享 socket 连接 provider（审核 #10）。
 * useSocket 与 useGraphRun 共用同一连接，避免第二连接 / 重复重连 / Strict-Mode 双挂。
 * autoConnect:false + setTimeout(connect,0) 规避 React Strict Mode 丢弃挂载打开废连接。
 */
export function SocketProvider({ children }: { children: ReactNode }) {
  const socketRef = useRef<Socket | null>(null);
  const [state, setState] = useState<SocketContextValue>({ socket: null, connected: false });

  useEffect(() => {
    const socket = io(API_URL, { transports: ['websocket', 'polling'], autoConnect: false });
    socketRef.current = socket;
    setState({ socket, connected: false });

    const onConnect = (): void => setState((s) => ({ ...s, connected: true }));
    const onDisconnect = (): void => setState((s) => ({ ...s, connected: false }));
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    const connectTimer = window.setTimeout(() => socket.connect(), 0);

    return () => {
      window.clearTimeout(connectTimer);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.removeAllListeners();
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
      setState({ socket: null, connected: false });
    };
  }, []);

  const value = useMemo<SocketContextValue>(() => state, [state]);
  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}
