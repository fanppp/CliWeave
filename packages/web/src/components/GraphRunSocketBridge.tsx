'use client';

import { useEffect } from 'react';
import { useSocketConnection } from '../providers/SocketProvider';
import { useGraphRunStore, type GraphEvent } from '../stores/graphRunStore';

/**
 * 图运行 WS 单订阅桥（B）。
 * 把共享 socket 注入 graphRunStore（供 startRun/abortRun 用），并唯一订阅 graph_message。
 * 图模式常驻渲染一次即可；多处调 store action 不重复订阅。
 */
export function GraphRunSocketBridge() {
  const { socket } = useSocketConnection();
  const setSocket = useGraphRunStore((s) => s.setSocket);

  useEffect(() => {
    setSocket(socket);
  }, [socket, setSocket]);

  useEffect(() => {
    if (!socket) return;
    const onMessage = (event: GraphEvent): void => {
      useGraphRunStore.getState().pushEvent(event);
    };
    socket.on('graph_message', onMessage);
    return () => {
      socket.off('graph_message', onMessage);
    };
  }, [socket]);

  return null;
}
