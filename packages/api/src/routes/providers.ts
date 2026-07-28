/**
 * providers 路由 —— 全局 CLI 能力（非项目作用域）。
 *
 * GET /api/providers：列出已注册 provider 元数据（command/installed/defaultModel）。
 * 与 /api/agents/providers（legacy 别名 → default 画布兼容层）区分：本路由是规范接口，
 * 新前端应只用 /api/providers；legacy 端点带 Deprecation/Sunset 仅作过渡。
 */
import type { FastifyPluginCallback } from 'fastify';
import { PROVIDERS } from '../agents/register-providers.js';

const providersRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get('/api/providers', async () => PROVIDERS);
  done();
};

export default providersRoutes;
