/**
 * POST /api/messages  { content, nodeId }
 * 立即返回 202，后台调用 AgentService 并把 AgentMessage 流式推给 WebSocket。
 * 借鉴 clowder-ai messages.ts（精简：去幂等/whisper/mentions/queue/deliveryMode）。
 */
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { buildAgent, getActiveSession, setActiveSession } from '../agents/AgentServiceFactory.js';
import { abortRun, registerAbort, unregisterAbort } from '../agents/abort-registry.js';
import { withNodeLock } from '../agents/node-mutex.js';
import type { SocketManager } from '../infrastructure/websocket/SocketManager.js';

export interface MessagesRouteOptions {
  socketManager: SocketManager;
}

const messagesRoutes: FastifyPluginCallback<MessagesRouteOptions> = (app, options, done) => {
  const { socketManager } = options;

  app.post('/api/messages', async (request, reply) => {
    const body = (request.body ?? {}) as { content?: unknown; nodeId?: unknown };
    const content = typeof body.content === 'string' ? body.content : '';
    const nodeId = typeof body.nodeId === 'string' ? body.nodeId : 'codex:codex-node';

    if (content.trim().length === 0) {
      return reply.code(400).send({ error: 'content is required' });
    }

    const invocationId = crypto.randomUUID();

    // 先回 202，流式回复走 WebSocket
    reply.code(202).send({ status: 'ok', nodeId, invocationId });

    // 后台执行，不阻塞 HTTP 响应
    setImmediate(async () => {
      const controller = registerAbort(invocationId);
      let aborted = false;
      controller.signal.addEventListener('abort', () => {
        aborted = true;
      });
      try {
        await withNodeLock(nodeId, async () => {
          const { descriptor, service } = await buildAgent(nodeId);
          const sessionId = getActiveSession(descriptor);

          // 历史直接来自 codex 自己的 transcript（resume 会话），不另存
          socketManager.broadcast(
            {
              type: 'system_info',
              nodeId,
              content: JSON.stringify({ type: 'invoking', invocationId, resume: !!sessionId }),
              timestamp: Date.now(),
            },
            nodeId,
          );

          for await (const msg of service.invoke(content, {
            sessionId,
            workingDirectory: descriptor.cli.cwd,
            invocationId,
            signal: controller.signal,
          })) {
            if (msg.type === 'session_init') {
              setActiveSession(descriptor, msg.sessionId);
              continue; // session_init 不广播
            }
            // 广播到前端（历史由 codex transcript 提供）
            socketManager.broadcast(msg, nodeId);
          }
          // 用户中止：CLI 被 signal 杀掉，流正常结束但不会有 done → 补一个
          if (aborted) {
            socketManager.broadcast(
              { type: 'system_info', nodeId, content: '已中止', timestamp: Date.now() },
              nodeId,
            );
            socketManager.broadcast({ type: 'done', nodeId, timestamp: Date.now() }, nodeId);
          }
        });
      } catch (err) {
        console.error('[messages] invoke error for', nodeId, ':', err);
        socketManager.broadcast(
          {
            type: 'error',
            nodeId,
            error: `节点调用失败: ${(err as Error).message}`,
            timestamp: Date.now(),
          },
          nodeId,
        );
        socketManager.broadcast(
          {
            type: 'done',
            nodeId,
            timestamp: Date.now(),
          },
          nodeId,
        );
      } finally {
        unregisterAbort(invocationId);
      }
    });
  });

  // 中止单节点调用
  app.post<{ Params: { invocationId: string } }>(
    '/api/messages/:invocationId/abort',
    async (request, reply) => {
      const { invocationId } = request.params;
      const ok = abortRun(invocationId);
      return reply.code(ok ? 202 : 404).send({ status: ok ? 'aborted' : 'not_found', invocationId });
    },
  );

  done();
};

export default messagesRoutes;
