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

/** 图运行向前端广播的 envelope（不与单节点 bare done 混淆）。 */
export type GraphEvent =
  | { type: 'node_started'; runId: string; nodeId: string; instanceKey?: string; cached?: boolean }
  | { type: 'node_iteration'; runId: string; nodeId: string; iteration: number; instanceKey?: string }
  | { type: 'node_message'; runId: string; nodeId: string; message: AgentMessage; instanceKey?: string; cached?: boolean }
  | { type: 'node_done'; runId: string; nodeId: string; instanceKey?: string; cached?: boolean }
  | { type: 'node_error'; runId: string; nodeId: string; error: string; instanceKey?: string }
  | {
      type: 'run_done';
      runId: string;
      finalText: string;
      termination: 'completed' | 'edge_limit' | 'global_limit';
      reason?: string;
    }
  | { type: 'run_aborted'; runId: string }
  | { type: 'run_error'; runId: string; error: string };

export class SocketManager {
  private readonly io: SocketIOServer;

  constructor(server: HttpServer, opts?: { corsOrigin?: string[] }) {
    const allowed = opts?.corsOrigin ?? ['http://localhost:3000', 'http://127.0.0.1:3000'];
    this.io = new SocketIOServer(server, {
      // 与 Fastify 共用同一 origin 列表；拒绝任意来源（防 danger-full-access 被 CSRF 利用）
      cors: { origin: (origin, cb) => { cb(null, !origin || allowed.includes(origin)); }, credentials: true },
    });
    this.io.on('connection', (socket: Socket) => {
      socket.on('join_node', (nodeId: unknown) => {
        // instanceKey 校验：拒任意字符串入 room
        if (typeof nodeId === 'string' && isInstanceKey(nodeId)) socket.join(`node:${nodeId}`);
      });
      socket.on('leave_node', (nodeId: unknown) => {
        if (typeof nodeId === 'string' && isInstanceKey(nodeId)) socket.leave(`node:${nodeId}`);
      });
      socket.on('join_graph', (runId: unknown, cb?: () => void) => {
        if (typeof runId === 'string') socket.join(`graph:${runId}`);
        cb?.();
      });
      socket.on('leave_graph', (runId: unknown) => {
        if (typeof runId === 'string') socket.leave(`graph:${runId}`);
      });
    });
  }

  /** 向订阅了某节点的所有客户端广播一条 AgentMessage */
  broadcast(msg: AgentMessage, nodeId: string): void {
    this.io.to(`node:${nodeId}`).emit('agent_message', msg);
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
