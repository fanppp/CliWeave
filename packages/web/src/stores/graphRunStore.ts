'use client';

import { create } from 'zustand';
import type { Socket } from 'socket.io-client';
import type { AgentEvent } from './chatStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

export interface GraphNode {
  id: string;
  type: 'input' | 'agent' | 'end';
  agentNodeKey?: string;
  position?: { x: number; y: number };
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  maxIterations?: number;
}
export interface Graph {
  schemaVersion: 3;
  inputNode: string;
  endNode?: string;
  maxNodeExecutions?: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type GraphEvent =
  | { type: 'node_started'; runId: string; nodeId: string }
  | { type: 'node_iteration'; runId: string; nodeId: string; iteration: number }
  | { type: 'node_message'; runId: string; nodeId: string; message: AgentEvent }
  | { type: 'node_done'; runId: string; nodeId: string }
  | { type: 'node_error'; runId: string; nodeId: string; error: string }
  | {
      type: 'run_done';
      runId: string;
      finalText: string;
      termination: 'completed' | 'edge_limit' | 'global_limit';
      reason?: string;
    }
  | { type: 'run_aborted'; runId: string }
  | { type: 'run_error'; runId: string; error: string };

export interface GraphBubble {
  id: string;
  nodeId: string;
  role: 'agent' | 'system';
  content: string;
  eventType: string;
  toolName?: string;
  timestamp: number;
}

export type GraphRunStatus = 'idle' | 'running' | 'done' | 'error';

interface GraphRunState {
  graph: Graph | null;
  replayGraph: Graph | null;
  bubbles: GraphBubble[];
  status: GraphRunStatus;
  /** 当前正在执行的节点（支持多节点并行：node_started 加 / node_done·error 删） */
  activeNodeIds: string[];
  /** 每个节点的迭代轮次（node_iteration 更新，画布角标用） */
  nodeIterations: Record<string, number>;
  currentRunId: string | null;
  /** 画布上选中的 agent 节点（用于右侧编辑 identity/rules） */
  selectedAgentNodeKey: string | null;
  /** 画布上选中的图节点 id（用于 GraphRunStream 过滤显示该节点流） */
  selectedGraphNodeId: string | null;
  /** agentNodeKey → 显示名 映射（GraphCanvas 填充，GraphRunStream 下拉用） */
  agentNameMap: Record<string, string>;
  /** 由 SocketProvider 注入的共享 socket，供 startRun/abortRun 使用 */
  socket: Socket | null;
  /** 上次保存图失败的原因（画布顶部红条显示，空=无错） */
  saveError: string | null;
  loadGraph: (g: Graph) => void;
  setGraph: (g: Graph) => void;
  saveGraph: (g: Graph) => Promise<void>;
  setReplayGraph: (g: Graph | null) => void;
  setSelectedAgentNodeKey: (key: string | null) => void;
  setSelectedGraphNodeId: (id: string | null) => void;
  setAgentNameMap: (m: Record<string, string>) => void;
  setSocket: (s: Socket | null) => void;
  startRun: (prompt: string) => Promise<void>;
  abortRun: () => Promise<void>;
  pushEvent: (event: GraphEvent) => void;
  reset: () => void;
  setCurrentRun: (runId: string | null) => void;
}

let seq = 0;
const nextId = (): string => `g${Date.now()}_${seq++}`;

function addActive(list: string[], id: string): string[] {
  return list.includes(id) ? list : [...list, id];
}
function removeActive(list: string[], id: string): string[] {
  return list.filter((x) => x !== id);
}

export const useGraphRunStore = create<GraphRunState>((set, get) => ({
  graph: null,
  replayGraph: null,
  bubbles: [],
  status: 'idle',
  activeNodeIds: [],
  nodeIterations: {},
  currentRunId: null,
  selectedAgentNodeKey: null,
  selectedGraphNodeId: null,
  agentNameMap: {},
  socket: null,
  saveError: null,
  loadGraph: (g) => set({ graph: g }),
  setGraph: (g) => set({ graph: g }),
  saveGraph: async (g) => {
    set({ graph: g, saveError: null }); // 乐观更新
    try {
      const res = await fetch(`${API_URL}/api/graph`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(g),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = body.error ?? `保存失败 HTTP ${res.status}`;
        set({ saveError: msg });
        // eslint-disable-next-line no-console
        console.error('[saveGraph] PUT 400:', msg, '\ngraph=', g);
      }
    } catch (e) {
      set({ saveError: (e as Error).message });
    }
  },
  setReplayGraph: (g) => set({ replayGraph: g }),
  setSelectedAgentNodeKey: (key) => set({ selectedAgentNodeKey: key }),
  setSelectedGraphNodeId: (id) => set({ selectedGraphNodeId: id }),
  setAgentNameMap: (m) => set({ agentNameMap: m }),
  setSocket: (s) => set({ socket: s }),
  setCurrentRun: (runId) => set({ currentRunId: runId }),
  reset: () => set({ bubbles: [], status: 'idle', activeNodeIds: [], nodeIterations: {}, currentRunId: null, replayGraph: null }),
  startRun: async (prompt: string) => {
    const socket = get().socket;
    if (!socket || !socket.connected) throw new Error('WebSocket 未连接');
    get().reset();
    const createRes = await fetch(`${API_URL}/api/graph/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (!createRes.ok) throw new Error(`创建运行失败: ${(await createRes.json()).error ?? createRes.status}`);
    const { runId } = (await createRes.json()) as { runId: string };
    set({ currentRunId: runId });
    // join_graph 用 ack 回调确认已入 room 再 start（防丢首批事件）
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
  },
  abortRun: async () => {
    const runId = get().currentRunId;
    if (!runId) return;
    await fetch(`${API_URL}/api/graph/run/${runId}/abort`, { method: 'POST' });
  },
  pushEvent: (event) =>
    set((s) => {
      if (s.currentRunId && event.runId !== s.currentRunId) return s;
      switch (event.type) {
        case 'node_started':
          return { ...s, status: 'running', activeNodeIds: addActive(s.activeNodeIds, event.nodeId) };
        case 'node_iteration':
          return { ...s, nodeIterations: { ...s.nodeIterations, [event.nodeId]: event.iteration } };
        case 'node_done':
          return { ...s, activeNodeIds: removeActive(s.activeNodeIds, event.nodeId) };
        case 'node_message': {
          const m = event.message;
          if (m.type === 'session_init' || m.type === 'done') return s;
          let content = m.content ?? '';
          if (m.type === 'tool_use') content = JSON.stringify(m.toolInput ?? {}, null, 2);
          if (m.type === 'error') content = m.error ?? content;
          const role: GraphBubble['role'] = m.type === 'error' ? 'system' : 'agent';
          const bubble: GraphBubble = {
            id: nextId(),
            nodeId: event.nodeId,
            role,
            content,
            eventType: m.type,
            toolName: m.toolName,
            timestamp: m.timestamp,
          };
          return { ...s, bubbles: [...s.bubbles, bubble] };
        }
        case 'node_error': {
          const bubble: GraphBubble = {
            id: nextId(),
            nodeId: event.nodeId,
            role: 'system',
            content: event.error,
            eventType: 'node_error',
            timestamp: Date.now(),
          };
          return { ...s, bubbles: [...s.bubbles, bubble], activeNodeIds: removeActive(s.activeNodeIds, event.nodeId), status: 'error' };
        }
        case 'run_done': {
          const label = event.termination === 'completed' ? '完成' : event.termination === 'edge_limit' ? '达到最大迭代，采用最后一版' : '达到全局执行上限';
          const bubble: GraphBubble = {
            id: nextId(),
            nodeId: '__run__',
            role: 'system',
            content: event.finalText ? `运行${label}\n\n【最终输出】\n${event.finalText}` : `运行${label}`,
            eventType: 'run_done',
            timestamp: Date.now(),
          };
          return { ...s, bubbles: [...s.bubbles, bubble], status: 'done', activeNodeIds: [] };
        }
        case 'run_aborted': {
          const bubble: GraphBubble = {
            id: nextId(),
            nodeId: '__run__',
            role: 'system',
            content: '已中止',
            eventType: 'run_aborted',
            timestamp: Date.now(),
          };
          return { ...s, bubbles: [...s.bubbles, bubble], status: 'idle', activeNodeIds: [] };
        }
        case 'run_error': {
          const bubble: GraphBubble = {
            id: nextId(),
            nodeId: '__run__',
            role: 'system',
            content: event.error,
            eventType: 'run_error',
            timestamp: Date.now(),
          };
          return { ...s, bubbles: [...s.bubbles, bubble], status: 'error', activeNodeIds: [] };
        }
        default:
          return s;
      }
    }),
}));
