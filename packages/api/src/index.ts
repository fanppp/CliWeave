/**
 * 0AgentTeams API Server 入口
 * Fastify + socket.io 同一 server。
 */
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { registerAllProviders } from './agents/register-providers.js';
import { migrateAllNodeStorageLayouts } from './agents/NodeDescriptor.js';
import { SocketManager } from './infrastructure/websocket/SocketManager.js';
import agentsRoutes from './routes/agents.js';
import graphRoutes from './routes/graph.js';
import messagesRoutes from './routes/messages.js';

const PORT = parseInt(process.env.API_SERVER_PORT ?? '3004', 10);
const HOST = process.env.API_SERVER_HOST ?? '127.0.0.1';
const WEB_ORIGINS = (process.env.WEB_ORIGIN ?? 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let socketManager: SocketManager | null = null;

async function main(): Promise<void> {
  // Migrate v1 node directories before any CLI can open its private data.
  const migrationFailures = migrateAllNodeStorageLayouts();
  for (const failure of migrationFailures) console.error(`[storage] node migration deferred: ${failure}`);
  // 注册所有 provider（codex / claude / opencode / gemini…）
  registerAllProviders();

  const app = Fastify({ logger: true });

  // CORS: 本地开发工具，允许所有来源（localhost / 127.0.0.1 / LAN IP 都行）
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  // SocketManager（封装 socket.io，提供 broadcast）
  socketManager = new SocketManager(app.server, { corsOrigin: ['*'] });

  // 让 Fastify 不要拦截 socket.io 路径，交给 socket.io 自己处理（含 ws 升级）
  app.addHook('onRequest', (request, reply, done) => {
    if (request.url.startsWith('/socket.io/')) {
      reply.hijack();
    }
    done();
  });

  // 健康检查
  app.get('/health', async () => ({ status: 'ok' as const, timestamp: Date.now() }));
  app.get('/api/health', async () => ({ status: 'ok' as const, timestamp: Date.now() }));

  // 路由
  await app.register(messagesRoutes, { socketManager });
  await app.register(graphRoutes, { socketManager });
  await app.register(agentsRoutes);

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`[api] listening on http://${HOST}:${PORT} (socket.io + routes attached)`);
  } catch (err) {
    app.log.error(err, '[api] failed to start');
    process.exit(1);
  }

  // 优雅关闭
  const shutdown = async (): Promise<void> => {
    app.log.info('[api] shutting down...');
    socketManager?.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[api] fatal', err);
  process.exit(1);
});
