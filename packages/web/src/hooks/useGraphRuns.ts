'use client';

import { useEffect, useState, useCallback } from 'react';
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
  nodes: { id: string; type: 'input' | 'agent'; agentNodeKey?: string }[];
}

function metaToGraph(meta: RunMeta): Graph {
  const inputNode = meta.nodes.find((n) => n.type === 'input')?.id ?? meta.nodes[0]?.id ?? '__input__';
  return { schemaVersion: 1, inputNode, nodes: meta.nodes, edges: [] };
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
  const loadGraph = useGraphRunStore((s) => s.loadGraph);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (): Promise<RunSummary[]> => {
    const res = await fetch(`${API_URL}/api/graph/runs`);
    if (!res.ok) return [];
    const data = (await res.json()) as { runs: RunSummary[] };
    const list = Array.isArray(data.runs) ? data.runs : [];
    setRuns(list);
    return list;
  }, []);

  const loadRun = useCallback(
    async (runId: string): Promise<void> => {
      setLoading(true);
      try {
        const res = await fetch(`${API_URL}/api/graph/runs/${runId}`);
        if (!res.ok) return;
        const data = (await res.json()) as { meta?: RunMeta; events: GraphEvent[] };
        reset();
        if (data.meta) setReplayGraph(metaToGraph(data.meta));
        for (const ev of data.events) pushEvent(ev);
      } finally {
        setLoading(false);
      }
    },
    [reset, setReplayGraph, pushEvent],
  );

  const loadLatest = useCallback(async (): Promise<void> => {
    const list = await refresh();
    const latest = list.find((r) => r.status === 'done') ?? list[0];
    if (latest) await loadRun(latest.runId);
  }, [refresh, loadRun]);

  const backToLive = useCallback(async (): Promise<void> => {
    setReplayGraph(null);
    reset();
    const res = await fetch(`${API_URL}/api/graph`);
    if (res.ok) loadGraph((await res.json()) as Graph);
  }, [setReplayGraph, reset, loadGraph]);

  // 首次挂载加载列表（不自动重放，由 RunPicker 选择；刷新若想自动重放改调 loadLatest）
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { runs, loading, loadRun, loadLatest, backToLive };
}
