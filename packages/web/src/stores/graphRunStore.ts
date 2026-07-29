'use client';

import { create } from 'zustand';
import type { Socket } from 'socket.io-client';
import type { AgentEvent } from './chatStore';
import { useThreadStore } from './threadStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

export interface GraphNode {
  id: string;
  type: 'input' | 'agent' | 'decision' | 'end';
  agentNodeKey?: string;
  rubricRef?: string;
  position?: { x: number; y: number };
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  maxIterations?: number;
  kind?: 'forward' | 'gate' | 'rework';
  order?: number;
  maxRevisions?: number;
  onExhausted?: 'ask_user' | 'continue_best' | 'fail';
  onBlocked?: 'ask_user' | 'fail';
}
export interface Graph {
  schemaVersion: 3 | 4;
  inputNode: string;
  endNode?: string;
  maxNodeExecutions?: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface RunQuality {
  status: 'approved' | 'best_effort';
  exhausted: boolean;
  bestCandidateId?: string;
  unresolvedGateIds: string[];
}

export type GraphEvent =
  | { type: 'node_started'; runId: string; nodeId: string }
  | { type: 'node_iteration'; runId: string; nodeId: string; iteration: number }
  | { type: 'node_message'; runId: string; nodeId: string; message: AgentEvent }
  | { type: 'node_done'; runId: string; nodeId: string }
  | { type: 'node_error'; runId: string; nodeId: string; error: string }
  | {
      type: 'gate_exhausted';
      runId: string;
      nodeId: string;
      instanceKey?: string;
      edgeId: string;
      reason: string;
      lastProducerArtifact: string;
      reviewerFeedback: string | null;
      timestamp: number;
    }
  | {
      type: 'route_decided'; runId: string; branchId: string; nodeId: string;
      claim: { action: 'finish' | 'forward' | 'clarify'; category: string; reason: string } | null;
      decision: 'finish' | 'forward' | 'clarify'; reason: string; timestamp: number;
    }
  | { type: 'branch_done'; runId: string; branchId: string; cause: 'early_complete' | 'needs_input' | 'end'; finalArtifact: string; timestamp: number }
  | { type: 'thread_committed'; runId: string; threadId: string; turnId: string; revision: number; status: 'completed' | 'failed' }
  | { type: 'candidate_produced'; runId: string; branchId: string; gateId?: string; candidate: { id: string; workNodeId: string; revision: number; artifact: string }; timestamp: number }
  | { type: 'evaluation_done'; runId: string; branchId: string; gateId: string; decisionNodeId: string; evaluation: { verdict: 'approve' | 'revise' | 'blocked'; feedback?: string; reason?: string }; timestamp: number }
  | { type: 'best_candidate_selected'; runId: string; branchId: string; gateId: string; candidateId: string; timestamp: number }
  | { type: 'gate_status'; runId: string; branchId: string; gateId: string; status: 'running' | 'approved' | 'exhausted' | 'blocked'; timestamp: number }
  | { type: 'gate_blocked'; runId: string; branchId: string; gateId: string; candidateId: string; reason: string; timestamp: number }
  | { type: 'candidate_rejected'; runId: string; branchId: string; gateId: string; candidateId: string; verdict: 'revise' | 'blocked'; timestamp: number }
  | { type: 'run_paused'; runId: string; projectId: string; branchId: string; gateId: string; question: string; options: ('continue_best' | 'revise_once' | 'fail')[]; resumeToken: string; expiresAt: number }
  | { type: 'run_resumed'; runId: string; branchId: string; gateId: string }
  | { type: 'resume_rejected'; runId: string; branchId: string; reason: string; timestamp: number }
  | {
      type: 'run_done';
      runId: string;
      finalText: string;
      termination: 'completed' | 'early_complete' | 'needs_input' | 'best_effort' | 'edge_limit' | 'global_limit';
      reason?: string;
      quality?: RunQuality;
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

export type GraphRunStatus = 'idle' | 'starting' | 'running' | 'paused' | 'done' | 'error';

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
  /** 当前画布 id（默认 'default'）；切换画布会重载 graph/agents/runs */
  projectId: string;
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
  runMode: 'auto' | 'full';
  gatePolicyOverrides: Record<string, 'ask_user' | 'continue_best' | 'fail'>;
  paused: Extract<GraphEvent, { type: 'run_paused' }> | null;
  setRunMode: (mode: 'auto' | 'full') => void;
  setGatePolicyOverride: (gateId: string, policy: 'ask_user' | 'continue_best' | 'fail') => void;
  resumeRun: (action: 'continue_best' | 'revise_once' | 'fail') => Promise<void>;
  loadGraph: (g: Graph) => void;
  setGraph: (g: Graph) => void;
  saveGraph: (g: Graph) => Promise<void>;
  setProjectId: (id: string) => void;
  loadProjectGraph: () => Promise<void>;
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

// V4.4: 把当前 resumeToken 存 sessionStorage，刷新后可继续当前浏览器会话恢复 pause 操作（per-project，到期自清）。
const pausedResumeKey = (projectId: string): string => `cliweave:paused-resume:${projectId}`;
type PausedEvent = Extract<GraphEvent, { type: 'run_paused' }>;
function savePausedResume(projectId: string, event: PausedEvent): void {
  if (typeof sessionStorage === 'undefined') return;
  try { sessionStorage.setItem(pausedResumeKey(projectId), JSON.stringify(event)); } catch { /* quota / disabled */ }
}
function loadPausedResume(projectId: string): PausedEvent | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(pausedResumeKey(projectId));
    if (!raw) return null;
    const event = JSON.parse(raw) as PausedEvent;
    if (event.expiresAt < Date.now()) { sessionStorage.removeItem(pausedResumeKey(projectId)); return null; }
    return event;
  } catch { return null; }
}
function clearPausedResume(projectId: string): void {
  if (typeof sessionStorage === 'undefined') return;
  try { sessionStorage.removeItem(pausedResumeKey(projectId)); } catch { /* ignore */ }
}

export const useGraphRunStore = create<GraphRunState>((set, get) => ({
  graph: null,
  replayGraph: null,
  bubbles: [],
  status: 'idle',
  activeNodeIds: [],
  nodeIterations: {},
  currentRunId: null,
  projectId: 'default',
  selectedAgentNodeKey: null,
  selectedGraphNodeId: null,
  agentNameMap: {},
  socket: null,
  saveError: null,
  runMode: 'auto',
  gatePolicyOverrides: {},
  paused: null,
  setRunMode: (runMode) => set({ runMode }),
  setGatePolicyOverride: (gateId, policy) => set((s) => ({ gatePolicyOverrides: { ...s.gatePolicyOverrides, [gateId]: policy } })),
  loadGraph: (g) => set({ graph: g }),
  setGraph: (g) => set({ graph: g }),
  setProjectId: (id) => {
    const restored = loadPausedResume(id);
    set({ projectId: id, graph: null, bubbles: [], status: restored ? 'paused' : 'idle', activeNodeIds: [], nodeIterations: {}, currentRunId: restored?.runId ?? null, selectedAgentNodeKey: null, selectedGraphNodeId: null, replayGraph: null, gatePolicyOverrides: {}, paused: restored });
  },
  loadProjectGraph: async () => {
    const pid = get().projectId;
    try {
      const res = await fetch(`${API_URL}/api/projects/${pid}/graph`);
      if (res.ok) set({ graph: await res.json() });
    } catch {
      // 忽略；GraphCanvas 兜底
    }
  },
  saveGraph: async (g) => {
    const pid = get().projectId;
    set({ graph: g, saveError: null }); // 乐观更新
    try {
      const res = await fetch(`${API_URL}/api/projects/${pid}/graph`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(g),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = body.error ?? `保存失败 HTTP ${res.status}`;
        set({ saveError: msg });
        // eslint-disable-next-line no-console
        console.error('[saveGraph] PUT', res.status, ':', msg, '\ngraph=', g);
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
  reset: () => set({ bubbles: [], status: 'idle', activeNodeIds: [], nodeIterations: {}, currentRunId: null, replayGraph: null, paused: null }),
  startRun: async (prompt: string) => {
    const socket = get().socket;
    const pid = get().projectId;
    if (!socket || !socket.connected) throw new Error('WebSocket 未连接');
    const thread = await useThreadStore.getState().prepareRun();
    get().reset();
    const createRes = await fetch(`${API_URL}/api/projects/${pid}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt, runMode: get().runMode, gatePolicyOverrides: get().gatePolicyOverrides, ...(thread ?? {}) }),
    });
    if (!createRes.ok) throw new Error(`创建运行失败: ${(await createRes.json()).error ?? createRes.status}`);
    const { runId, threadId, threadRevision } = (await createRes.json()) as { runId: string; threadId: string; threadRevision: number };
    await useThreadStore.getState().adoptCreatedThread(threadId, threadRevision);
    // starting：run 已创建、首个 node_started 前的窗口（供项目切换仲裁识别"忙"）
    set({ currentRunId: runId, status: 'starting' });
    try {
      // join_graph 用 ack 回调确认已入 room 再 start（防丢首批事件）
      await new Promise<void>((resolve, reject) => {
        socket.timeout(5000).emit('join_graph', runId, (err?: unknown) => {
          if (err) reject(new Error('join_graph 超时'));
          else resolve();
        });
      });
      const startRes = await fetch(`${API_URL}/api/projects/${pid}/run/${runId}/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!startRes.ok) throw new Error(`启动运行失败: ${(await startRes.json()).error ?? startRes.status}`);
    } catch (error) {
      await fetch(`${API_URL}/api/projects/${pid}/run/${runId}/abort`, { method: 'POST' }).catch(() => undefined);
      set({ status: 'error', currentRunId: null, activeNodeIds: [] });
      await useThreadStore.getState().loadProject(pid);
      throw error;
    }
  },
  abortRun: async () => {
    const runId = get().currentRunId;
    const pid = get().projectId;
    if (!runId) return;
    await fetch(`${API_URL}/api/projects/${pid}/run/${runId}/abort`, { method: 'POST' });
  },
  resumeRun: async (action) => {
    const { paused, projectId, currentRunId } = get();
    if (!paused || !currentRunId) return;
    const response = await fetch(`${API_URL}/api/projects/${projectId}/run/${currentRunId}/resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branchId: paused.branchId, resumeToken: paused.resumeToken, action }),
    });
    if (!response.ok) throw new Error(`恢复失败: ${(await response.json()).error ?? response.status}`);
    set({ status: 'running', paused: null });
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
        case 'gate_exhausted': {
          const content = `⚠ 审核预算耗尽·best-effort 放行\n${event.reason}\n【最后产物】\n${event.lastProducerArtifact || '(无)'}${event.reviewerFeedback ? `\n【最后审核反馈】\n${event.reviewerFeedback}` : ''}`;
          const bubble: GraphBubble = {
            id: nextId(),
            nodeId: event.nodeId,
            role: 'system',
            content,
            eventType: 'gate_exhausted',
            timestamp: event.timestamp,
          };
          return { ...s, bubbles: [...s.bubbles, bubble] };
        }
        case 'route_decided': {
          const label = event.decision === 'finish' ? '提前完成' : event.decision === 'clarify' ? '等待补充信息' : '继续完整流程';
          const bubble: GraphBubble = { id: nextId(), nodeId: event.nodeId, role: 'system', content: `路由：${label}\n${event.reason}`, eventType: 'route_decided', timestamp: event.timestamp };
          return { ...s, bubbles: [...s.bubbles, bubble] };
        }
        case 'branch_done':
          return s;
        case 'thread_committed':
          void useThreadStore.getState().handleCommitted(event.threadId);
          return { ...s, status: event.status === 'completed' ? 'done' : s.status };
        case 'candidate_produced': {
          const bubble: GraphBubble = { id: nextId(), nodeId: event.candidate.workNodeId, role: 'system', content: `候选版本 r${event.candidate.revision} 已产生`, eventType: event.type, timestamp: event.timestamp };
          return { ...s, bubbles: [...s.bubbles, bubble] };
        }
        case 'evaluation_done': {
          const detail = event.evaluation.feedback ?? event.evaluation.reason ?? '';
          const bubble: GraphBubble = { id: nextId(), nodeId: event.decisionNodeId, role: 'system', content: `评估：${event.evaluation.verdict}${detail ? `\n${detail}` : ''}`, eventType: event.type, timestamp: event.timestamp };
          return { ...s, bubbles: [...s.bubbles, bubble] };
        }
        case 'gate_status':
        case 'best_candidate_selected':
          return s;
        case 'run_resumed': {
          clearPausedResume(s.projectId);
          return { ...s, status: 'running', paused: null, activeNodeIds: [] };
        }
        case 'resume_rejected': {
          // token 非法/过期/已用或 action 不允许：服务端仍 paused，但本浏览器会话的 token 已不可用 → 清掉，不再提供按钮。
          clearPausedResume(s.projectId);
          const bubble: GraphBubble = { id: nextId(), nodeId: '__run__', role: 'system', content: `恢复被拒：${event.reason}`, eventType: event.type, timestamp: Date.now() };
          return { ...s, bubbles: [...s.bubbles, bubble], paused: null };
        }
        case 'run_paused': {
          const bubble: GraphBubble = { id: nextId(), nodeId: '__run__', role: 'system', content: `${event.question}\nGate: ${event.gateId}`, eventType: event.type, timestamp: Date.now() };
          savePausedResume(s.projectId, event);
          return { ...s, bubbles: [...s.bubbles, bubble], status: 'paused', paused: event, activeNodeIds: [] };
        }
        case 'run_done': {
          const label =
            event.termination === 'completed' ? '完成'
            : event.termination === 'early_complete' ? '智能提前完成'
            : event.termination === 'needs_input' ? '需要补充信息'
            : event.termination === 'best_effort' ? '预算耗尽·best-effort 放行'
            : event.termination === 'edge_limit' ? '达到最大迭代（legacy）'
            : '达到全局执行上限';
          const bubble: GraphBubble = {
            id: nextId(),
            nodeId: '__run__',
            role: 'system',
            content: event.finalText ? `运行${label}\n\n【最终输出】\n${event.finalText}` : `运行${label}`,
            eventType: 'run_done',
            timestamp: Date.now(),
          };
          // run_done 本身就是公开终态；thread_committed 仅刷新 durable Thread revision。
          // 不能依赖后一事件收口 UI：旧服务/旧 JSONL/瞬时断线都可能没有该事件。
          clearPausedResume(s.projectId);
          return { ...s, bubbles: [...s.bubbles, bubble], status: 'done', activeNodeIds: [], paused: null };
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
          clearPausedResume(s.projectId);
          return { ...s, bubbles: [...s.bubbles, bubble], status: 'idle', activeNodeIds: [], paused: null };
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
          clearPausedResume(s.projectId);
          return { ...s, bubbles: [...s.bubbles, bubble], status: 'error', activeNodeIds: [], paused: null };
        }
        default:
          return s;
      }
    }),
}));
