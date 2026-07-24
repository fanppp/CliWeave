/**
 * SocketManager —— 把 AgentMessage 流式推给前端
 * 客户端 join_node(nodeId) 后，收到该节点的 agent_message 事件。
 * 借鉴 clowder-ai SocketManager（精简：去 seq/seqEpoch catch-up/用户鉴权）。
 */
import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import type { AgentMessage } from '../../agents/types.js';

export class SocketManager {
  private readonly io: SocketIOServer;

  constructor(server: HttpServer, _opts?: { corsOrigin?: string[] }) {
    this.io = new SocketIOServer(server, {
      // 本地开发工具：反射任意来源，兼容 credentials
      cors: { origin: true, credentials: true },
    });
    this.io.on('connection', (socket: Socket) => {
      socket.on('join_node', (nodeId: unknown) => {
        if (typeof nodeId === 'string') socket.join(`node:${nodeId}`);
      });
      socket.on('leave_node', (nodeId: unknown) => {
        if (typeof nodeId === 'string') socket.leave(`node:${nodeId}`);
      });
    });
  }

  /** 向订阅了某节点的所有客户端广播一条 AgentMessage */
  broadcast(msg: AgentMessage, nodeId: string): void {
    this.io.to(`node:${nodeId}`).emit('agent_message', msg);
  }

  getIO(): SocketIOServer {
    return this.io;
  }

  close(): void {
    this.io.close();
  }
}
