/**
 * 0AgentTeams API Server 入口
 * Fastify + socket.io 同一 server。
 */
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { registerAllProviders } from './agents/register-providers.js';
import { migrateAllNodeStorageLayouts } from './agents/NodeDescriptor.js';
import { migrateProjectScoped } from './agents/project-migration.js';
import { SocketManager } from './infrastructure/websocket/SocketManager.js';
import agentsRoutes from './routes/agents.js';
import graphRoutes from './routes/graph.js';
import messagesRoutes from './routes/messages.js';
import projectsRoutes from './routes/projects.js';

const PORT = parseInt(process.env.API_SERVER_PORT ?? '3004', 10);
const HOST = process.env.API_SERVER_HOST ?? '127.0.0.1';
const WEB_ORIGINS = (process.env.WEB_ORIGIN ?? 'http://localhost:3000,http://127.0.0.1:3000')
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

  // 画布作用域迁移（事务式、幂等）：verified→跳过；git-bootstrap→标记；needs-migration→迁移。
  // 不活跃运行/子进程时执行；失败保留 staging + 报告，不阻塞启动。
  const mig = migrateProjectScoped();
  if (mig.status === 'migrated' || mig.status === 'git-bootstrap' || mig.status === 'fresh') {
    console.log(`[migration] ${mig.status}${mig.reason ? `: ${mig.reason}` : ''}${mig.movedNodes ? ` (${mig.movedNodes} nodes)` : ''}`);
  } else if (mig.status === 'blocked') {
    console.warn(`[migration] blocked: ${mig.reason ?? 'unknown'}`);
  }

  const app = Fastify({ logger: true });

  // CORS: 严格使用已声明的 WEB_ORIGINS（loopback 本地工具；开放任意 origin 会与 danger-full-access 叠加成漏洞）
  const isAllowedOrigin = (origin: string | undefined): boolean => {
    if (!origin) return true; // 同源/无 Origin（curl、server-to-server）
    return WEB_ORIGINS.includes(origin);
  };
  await app.register(cors, {
    origin: (origin, cb) => { cb(null, isAllowedOrigin(origin)); },
    credentials: true,
  });

  // SocketManager（封装 socket.io，提供 broadcast；CORS 与 Fastify 共用同一 origin 判断）
  socketManager = new SocketManager(app.server, { corsOrigin: WEB_ORIGINS });

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
  await app.register(projectsRoutes, { socketManager });
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
