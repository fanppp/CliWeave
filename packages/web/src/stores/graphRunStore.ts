'use client';

import { create } from 'zustand';
import type { AgentEvent } from './chatStore';

export interface GraphNode {
  id: string;
  type: 'input' | 'agent';
  agentNodeKey?: string;
  position?: { x: number; y: number };
}
export interface Graph {
  schemaVersion: 1;
  inputNode: string;
  nodes: GraphNode[];
  edges: { source: string; target: string }[];
}

export type GraphEvent =
  | { type: 'node_started'; runId: string; nodeId: string }
  | { type: 'node_message'; runId: string; nodeId: string; message: AgentEvent }
  | { type: 'node_done'; runId: string; nodeId: string }
  | { type: 'node_error'; runId: string; nodeId: string; error: string }
  | { type: 'run_done'; runId: string }
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
  /** 重放历史 run 时的图快照（用于节点配色/label）；null 时用 live graph。 */
  replayGraph: Graph | null;
  bubbles: GraphBubble[];
  status: GraphRunStatus;
  activeNodeId: string | null;
  currentRunId: string | null;
  loadGraph: (g: Graph) => void;
  setGraph: (g: Graph) => void;
  saveGraph: (g: Graph) => Promise<void>;
  setReplayGraph: (g: Graph | null) => void;
  pushEvent: (event: GraphEvent) => void;
  reset: () => void;
  setCurrentRun: (runId: string | null) => void;
}

let seq = 0;
const nextId = (): string => `g${Date.now()}_${seq++}`;
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

export const useGraphRunStore = create<GraphRunState>((set) => ({
  graph: null,
  replayGraph: null,
  bubbles: [],
  status: 'idle',
  activeNodeId: null,
  currentRunId: null,
  loadGraph: (g) => set({ graph: g }),
  setGraph: (g) => set({ graph: g }),
  saveGraph: async (g) => {
    set({ graph: g }); // 乐观更新
    await fetch(`${API_URL}/api/graph`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(g),
    });
  },
  setReplayGraph: (g) => set({ replayGraph: g }),
  setCurrentRun: (runId) => set({ currentRunId: runId }),
  reset: () => set({ bubbles: [], status: 'idle', activeNodeId: null, currentRunId: null, replayGraph: null }),
  pushEvent: (event) =>
    set((s) => {
      if (s.currentRunId && event.runId !== s.currentRunId) return s; // 忽略其他 run
      switch (event.type) {
        case 'node_started':
          return { ...s, status: 'running', activeNodeId: event.nodeId };
        case 'node_done':
          return s.activeNodeId === event.nodeId ? { ...s, activeNodeId: null } : s;
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
          return { ...s, bubbles: [...s.bubbles, bubble], activeNodeId: null, status: 'error' };
        }
        case 'run_done':
          return { ...s, status: 'done', activeNodeId: null };
        case 'run_aborted': {
          const bubble: GraphBubble = {
            id: nextId(),
            nodeId: '__run__',
            role: 'system',
            content: '已中止',
            eventType: 'run_aborted',
            timestamp: Date.now(),
          };
          return { ...s, bubbles: [...s.bubbles, bubble], status: 'idle', activeNodeId: null };
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
          return { ...s, bubbles: [...s.bubbles, bubble], status: 'error', activeNodeId: null };
        }
        default:
          return s;
      }
    }),
}));
