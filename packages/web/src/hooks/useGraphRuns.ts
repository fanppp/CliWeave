'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useGraphRunStore, type Graph, type GraphEvent } from '../stores/graphRunStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

export interface RunSummary {
  runId: string;
  prompt: string;
  createdAt: number;
  status: 'done' | 'error' | 'aborted' | 'unknown';
}
interface RunMeta {
  type: 'run_meta';
  runId: string;
  prompt: string;
  createdAt: number;
  graph: Graph;
}

function metaToGraph(meta: RunMeta): Graph {
  return meta.graph;
}

export function useGraphRuns(): {
  runs: RunSummary[];
  loading: boolean;
  loadRun: (runId: string) => Promise<void>;
  loadLatest: () => Promise<void>;
  backToLive: () => Promise<void>;
} {
  const reset = useGraphRunStore((s) => s.reset);
  const setReplayGraph = useGraphRunStore((s) => s.setReplayGraph);
  const pushEvent = useGraphRunStore((s) => s.pushEvent);
  const loadProjectGraph = useGraphRunStore((s) => s.loadProjectGraph);
  const projectId = useGraphRunStore((s) => s.projectId);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  // projectId 引用：异步 load 完成后比对，切画布则丢弃旧结果（防 default 的慢 loadRun 覆盖 test 的最新 run）
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // 按当前画布拉 runs 列表（项目路由；legacy /api/graph 只读 default，会漏掉非 default 画布的 run）
  const refresh = useCallback(async (): Promise<RunSummary[]> => {
    const pid = projectId;
    const res = await fetch(`${API_URL}/api/projects/${pid}/runs`);
    if (pid !== projectIdRef.current) return []; // 切画布：丢弃
    if (!res.ok) return [];
    const data = (await res.json()) as { runs: RunSummary[] };
    if (pid !== projectIdRef.current) return [];
    const list = Array.isArray(data.runs) ? data.runs : [];
    setRuns(list);
    return list;
  }, [projectId]);

  const loadRun = useCallback(
    async (runId: string): Promise<void> => {
      const pid = projectId;
      setLoading(true);
      try {
        const res = await fetch(`${API_URL}/api/projects/${pid}/runs/${runId}`);
        if (pid !== projectIdRef.current) return; // 切画布：丢弃
        if (!res.ok) return;
        const data = (await res.json()) as { meta?: RunMeta; events: GraphEvent[] };
        if (pid !== projectIdRef.current) return; // 切画布：丢弃
        reset();
        if (data.meta) setReplayGraph(metaToGraph(data.meta));
        for (const ev of data.events) pushEvent(ev);
      } finally {
        if (pid === projectIdRef.current) setLoading(false);
      }
    },
    [projectId, reset, setReplayGraph, pushEvent],
  );

  const loadLatest = useCallback(async (): Promise<void> => {
    const list = await refresh();
    const latest = list.find((r) => r.status === 'done') ?? list[0];
    if (latest) await loadRun(latest.runId);
  }, [refresh, loadRun]);

  const backToLive = useCallback(async (): Promise<void> => {
    setReplayGraph(null);
    reset();
    await loadProjectGraph(); // 项目路由拉当前画布图
  }, [setReplayGraph, reset, loadProjectGraph]);

  // 首次挂载 + 切画布（projectId 变化）时重载列表
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { runs, loading, loadRun, loadLatest, backToLive };
}
