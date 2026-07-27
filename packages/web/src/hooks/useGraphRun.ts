'use client';

import { useEffect } from 'react';
import { useGraphRunStore, type GraphEvent } from '../stores/graphRunStore';
import { useSocketConnection } from '../providers/SocketProvider';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

/**
 * 图运行：GET /api/graph 加载图；startRun 两步启动（create → join_graph → start）；
 * 订阅共享 socket 的 graph_message（审核 #1 #10）。
 */
export function useGraphRun(): {
  startRun: (prompt: string) => Promise<void>;
  abortRun: () => Promise<void>;
  reloadGraph: () => Promise<void>;
} {
  const { socket } = useSocketConnection();
  const loadGraph = useGraphRunStore((s) => s.loadGraph);
  const reset = useGraphRunStore((s) => s.reset);
  const setCurrentRun = useGraphRunStore((s) => s.setCurrentRun);
  const pushEvent = useGraphRunStore((s) => s.pushEvent);

  // 订阅 graph_message（只处理当前 run）
  useEffect(() => {
    if (!socket) return;
    const onGraphMessage = (event: GraphEvent): void => pushEvent(event);
    socket.on('graph_message', onGraphMessage);
    return () => {
      socket.off('graph_message', onGraphMessage);
    };
  }, [socket, pushEvent]);

  const reloadGraph = async (): Promise<void> => {
    const res = await fetch(`${API_URL}/api/graph`);
    if (res.ok) loadGraph((await res.json()) as Parameters<typeof loadGraph>[0]);
  };

  // 首次挂载加载图
  useEffect(() => {
    void reloadGraph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startRun = async (prompt: string): Promise<void> => {
    if (!socket || !socket.connected) throw new Error('WebSocket 未连接');
    reset();
    // 步骤 1：创建运行
    const createRes = await fetch(`${API_URL}/api/graph/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (!createRes.ok) throw new Error(`创建运行失败: ${(await createRes.json()).error ?? createRes.status}`);
    const { runId } = (await createRes.json()) as { runId: string };
    setCurrentRun(runId);
    // 步骤 2：先 join_graph room，等 ack 确认已加入后再 start（审核#11：消除硬 50ms 丢消息窗口）
    await new Promise<void>((resolve, reject) => {
      socket.timeout(5000).emit('join_graph', runId, (err?: unknown) => {
        if (err) reject(new Error('join_graph 超时'));
        else resolve();
      });
    });
    const startRes = await fetch(`${API_URL}/api/graph/run/${runId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!startRes.ok) throw new Error(`启动运行失败: ${(await startRes.json()).error ?? startRes.status}`);
  };

  const abortRun = async (): Promise<void> => {
    const runId = useGraphRunStore.getState().currentRunId;
    if (!runId) return;
    await fetch(`${API_URL}/api/graph/run/${runId}/abort`, { method: 'POST' });
  };

  return { startRun, abortRun, reloadGraph };
}
