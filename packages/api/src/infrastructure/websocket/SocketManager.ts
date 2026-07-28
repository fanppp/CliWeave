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
  | {
      type: 'run_done';
      runId: string;
      finalText: string;
      /** completed=自然结束；best_effort=回边预算耗尽后 best-effort 放行；edge_limit=旧 V3 历史回放兼容；global_limit=全局执行上限。 */
      termination: 'completed' | 'best_effort' | 'edge_limit' | 'global_limit';
      reason?: string;
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
