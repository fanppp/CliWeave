/**
 * SocketManager —— 把 AgentMessage 流式推给前端
 * - 单节点：join_node(nodeId) 后收到 agent_message 事件。
 * - 图运行：join_graph(runId) 后收到 graph_message 事件（带 nodeKey 的 Graph envelope）。
 * 借鉴 clowder-ai SocketManager（精简：去 seq/seqEpoch catch-up/用户鉴权）。
 */
import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { isInstanceKey } from '../../agents/instance-key.js';
import type { AgentMessage } from '../../agents/types.js';
import type { CompletionClaim } from '../../agents/graph/completion.js';
import type { Candidate, Evaluation } from '../../agents/graph/evaluation.js';
import type { RouteLane, Risk } from '../../agents/graph/graph.js';

/**
 * V4.3 完成质量摘要：与 run_done/Thread turn 绑定。payload 是下游唯一可见主体；quality 是独立元数据。
 * - status: approved=所有 gate 通过；best_effort=有 gate 经 continue_best 放行。
 * - exhausted: 是否有 gate 耗尽预算。
 * - unresolvedGateIds: 经 continue_best 跳过、未获 approve 的 gate。
 */
export interface RunQuality {
  status: 'approved' | 'best_effort';
  exhausted: boolean;
  bestCandidateId?: string;
  unresolvedGateIds: string[];
}

/**
 * 图运行事件类型（分型，防 Phase 2a 的 run_state/branch_checkpoint 被误广播）。
 * - PublicGraphEvent：可经 SocketManager.broadcastGraph 广播给前端。
 * - PersistedRunEvent：可经 record 落盘 JSONL = 公开事件 + 内部事件（run_state/branch_checkpoint 仅落盘，不广播）。
 */
export type PublicGraphEvent =
  | { type: 'node_started'; runId: string; nodeId: string; instanceKey?: string; cached?: boolean }
  | { type: 'node_iteration'; runId: string; nodeId: string; iteration: number; instanceKey?: string }
  | { type: 'node_message'; runId: string; nodeId: string; message: AgentMessage; instanceKey?: string; cached?: boolean }
  | { type: 'node_done'; runId: string; nodeId: string; instanceKey?: string; cached?: boolean }
  | { type: 'node_error'; runId: string; nodeId: string; error: string; instanceKey?: string }
  | {
      /** 回边预算耗尽：best-effort 放行（仍产出最后审核+producer artifact 作质量报告）。 */
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
  | { type: 'route_decided'; runId: string; branchId: string; nodeId: string; claim: CompletionClaim | null; decision: 'finish' | 'forward' | 'clarify'; reason: string; timestamp: number }
  | { type: 'run_plan_created'; runId: string; lane: RouteLane; entryNodeId: string; gateNodeIds: string[]; rerouted: boolean; confidence: number; risk: Risk; reason: string; timestamp: number }
  | { type: 'branch_done'; runId: string; branchId: string; cause: 'early_complete' | 'needs_input' | 'end'; finalArtifact: string; timestamp: number }
  | { type: 'candidate_produced'; runId: string; branchId: string; gateId?: string; candidate: Candidate; timestamp: number }
  | { type: 'evaluation_done'; runId: string; branchId: string; gateId: string; decisionNodeId: string; evaluation: Evaluation; timestamp: number }
  | { type: 'best_candidate_selected'; runId: string; branchId: string; gateId: string; candidateId: string; timestamp: number }
  | { type: 'gate_status'; runId: string; branchId: string; gateId: string; status: 'running' | 'approved' | 'exhausted' | 'blocked'; timestamp: number }
  | { type: 'gate_blocked'; runId: string; branchId: string; gateId: string; candidateId: string; reason: string; timestamp: number }
  | { type: 'candidate_rejected'; runId: string; branchId: string; gateId: string; candidateId: string; verdict: 'revise' | 'blocked'; timestamp: number }
  | { type: 'run_paused'; runId: string; projectId: string; branchId: string; pauseKind: 'gate'; gateId: string; question: string; options: ('continue_best' | 'revise_once' | 'fail')[]; resumeToken: string; expiresAt: number }
  | { type: 'run_paused'; runId: string; projectId: string; branchId: string; pauseKind: 'clarify'; question: string; missingRequirements: string[]; resumeToken: string; expiresAt: number }
  | { type: 'run_resumed'; runId: string; branchId: string; gateId: string }
  | { type: 'resume_rejected'; runId: string; branchId: string; reason: string; timestamp: number }
  | { type: 'thread_committed'; runId: string; threadId: string; turnId: string; revision: number; status: 'completed' | 'failed' }
  | {
      type: 'run_done';
      runId: string;
      finalText: string;
      /** completed=自然结束；best_effort=回边预算耗尽后 best-effort 放行；edge_limit=旧 V3 历史回放兼容；global_limit=全局执行上限。 */
      termination: 'completed' | 'early_complete' | 'needs_input' | 'best_effort' | 'edge_limit' | 'global_limit';
      reason?: string;
      /** V4.3: 完成质量摘要（V4 runner 填充；V3 legacy 缺省）。Thread turn 同时保存。 */
      quality?: RunQuality;
    }
  | { type: 'run_aborted'; runId: string }
  | { type: 'run_error'; runId: string; error: string };

/** 内部持久化事件（Phase 2a 起用：durable pause/resume 的检查点，仅落盘不广播）。 */
export type PersistedRunEvent =
  | PublicGraphEvent
  | { type: 'run_state'; runId: string; phase: string; payload: unknown }
  | { type: 'branch_checkpoint'; runId: string; branchId: string; payload: unknown };

/** @deprecated 用 PublicGraphEvent（保留别名供过渡）。 */
export type GraphEvent = PublicGraphEvent;

/** 单节点广播信封：按 instanceKey 路由 + 前端按 instanceKey 过滤（防 projA/projB 同 nodeKey 串台）。 */
export interface NodeMessageEnvelope {
  instanceKey: string;
  message: AgentMessage;
}

export class SocketManager {
  private readonly io: SocketIOServer;

  constructor(server: HttpServer, opts?: { corsOrigin?: string[] }) {
    const allowed = opts?.corsOrigin ?? ['http://localhost:3000', 'http://127.0.0.1:3000'];
    this.io = new SocketIOServer(server, {
      // 与 Fastify 共用同一 origin 列表；拒绝任意来源（防 danger-full-access 被 CSRF 利用）
      cors: { origin: (origin, cb) => { cb(null, !origin || allowed.includes(origin)); }, credentials: true },
    });
    this.io.on('connection', (socket: Socket) => {
      socket.on('join_node', (key: unknown, cb?: (ok: boolean) => void) => {
        // instanceKey 校验：拒任意字符串入 room；ack 回传是否成功（防 HTTP 早于入 room 丢首批事件）
        if (typeof key === 'string' && isInstanceKey(key)) {
          socket.join(`node:${key}`);
          cb?.(true);
        } else {
          cb?.(false);
        }
      });
      socket.on('leave_node', (key: unknown) => {
        if (typeof key === 'string' && isInstanceKey(key)) socket.leave(`node:${key}`);
      });
      socket.on('join_graph', (runId: unknown, cback?: () => void) => {
        if (typeof runId === 'string') socket.join(`graph:${runId}`);
        cback?.();
      });
      socket.on('leave_graph', (runId: unknown) => {
        if (typeof runId === 'string') socket.leave(`graph:${runId}`);
      });
    });
  }

  /** 向订阅了某节点(instanceKey)的所有客户端广播一条 AgentMessage（信封含 instanceKey 供前端过滤）。 */
  broadcast(msg: AgentMessage, instanceKey: string): void {
    this.io.to(`node:${instanceKey}`).emit('agent_message', { instanceKey, message: msg } satisfies NodeMessageEnvelope);
  }

  /** 向订阅了某图运行的所有客户端广播一个 Graph envelope 事件 */
  broadcastGraph(event: GraphEvent): void {
    this.io.to(`graph:${event.runId}`).emit('graph_message', event);
  }

  getIO(): SocketIOServer {
    return this.io;
  }

  close(): void {
    this.io.close();
  }
}
