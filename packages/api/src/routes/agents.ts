/**
 * agents 路由（legacy 别名 → default 画布实例）。
 *
 * M5 后节点只在画布内存在；旧 /api/agents/:nodeKey 全部委托 default 画布实例，
 * 供前端未迁移组件（NodeConfigPanel/SessionPicker/useNodeHistory）继续工作。
 * 响应带 Deprecation:true + Sunset，下一版切到 /api/projects/:id/nodes/* 后移除。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FastifyPluginCallback } from 'fastify';
import {
  DEFAULT_PROJECT_ID,
  instantiateNodeInstance,
  listProjectNodeInstances,
  readProjectNodeInstance,
  trashNodeInstance,
} from '../agents/project-storage.js';
import { formatInstanceKey, parseInstanceKey } from '../agents/instance-key.js';
import { resolveInstanceDescriptorPaths } from '../agents/node-instance.js';
import { clearActiveSessionCtx, getActiveSessionCtx, setActiveSessionCtx } from '../agents/SessionChain.js';
import { listNodeSessionsCtx, readNodeTranscriptCtx } from '../agents/transcript-router.js';
import { PROVIDERS } from '../agents/register-providers.js';
import { resolveGlob } from '../utils/glob.js';
import { formatNodeKey, parseNodeKey } from '../agents/NodeDescriptor.js';
import { readProjectGraph } from '../agents/graph/graph.js';

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

function deprecate(reply: import('fastify').FastifyReply, successor = '/api/projects/default/nodes'): void {
  reply.header('Deprecation', 'true');
  reply.header('Sunset', 'Wed, 31 Dec 2026 00:00:00 GMT');
  reply.header('Link', `<${successor}>; rel="successor-version"`);
}

const agentsRoutes: FastifyPluginCallback = (app, _options, done) => {
  // 列 default 画布的节点实例
  app.get('/api/agents', async (request, reply) => {
    deprecate(reply);
    return listProjectNodeInstances(DEFAULT_PROJECT_ID).map((n) => ({
      nodeKey: n.nodeKey,
      localId: n.localId,
      name: n.name,
      provider: n.provider,
      ...(n.model ? { model: n.model } : {}),
    }));
  });

  app.get('/api/agents/providers', async (_request, reply) => {
    deprecate(reply, '/api/providers');
    return PROVIDERS;
  });

  // 在 default 画布内新建实例（legacy 创建别名）
  app.post('/api/providers/:provider/agents', async (request, reply) => {
    deprecate(reply);
    const { provider } = request.params as { provider: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const meta = PROVIDERS.find((item) => item.id === provider);
    if (!meta) return reply.code(400).send({ error: `unknown provider: ${provider}` });
    if (!meta.installed) return reply.code(409).send({ error: `provider '${provider}' is disabled (not installed)` });

    const localId = typeof body.localId === 'string' ? body.localId.trim() : '';
    let nodeKey: string;
    try {
      nodeKey = formatNodeKey(provider, localId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid localId' });
    }
    // 已存在校验
    try {
      readProjectNodeInstance(DEFAULT_PROJECT_ID, nodeKey);
      return reply.code(409).send({ error: `node already exists: ${nodeKey}` });
    } catch {
      /* 不存在，继续 */
    }
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : localId;
    try {
      const ctx = instantiateNodeInstance(DEFAULT_PROJECT_ID, nodeKey, {
        name,
        command: meta.command,
        memoryHome: meta.memoryHome,
        ...(typeof body.model === 'string' && body.model.trim() ? { model: body.model.trim() } : meta.defaultModel ? { model: meta.defaultModel } : {}),
        ...(typeof body.identity === 'string' ? { identity: body.identity } : {}),
      });
      return reply.code(201).send({ status: 'ok', nodeKey, localId: ctx.descriptor.localId, created: true });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'node creation failed' });
    }
  });

  app.get<{ Params: { nodeKey: string } }>('/api/agents/:nodeKey', async (request, reply) => {
    deprecate(reply);
    const { nodeKey } = request.params;
    let ctx;
    try {
      ctx = readProjectNodeInstance(DEFAULT_PROJECT_ID, nodeKey);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    const resolved = resolveInstanceDescriptorPaths(ctx);
    const identity = readText(resolved.storage.config.identityFile);
    const rules: { file: string; content: string }[] = [];
    for (const pattern of resolved.storage.config.rulesFiles) {
      for (const file of resolveGlob(pattern, ctx.nodeDir)) {
        const content = readText(file);
        if (content !== undefined) rules.push({ file, content });
      }
    }
    return { nodeKey, descriptor: ctx.descriptor, identity, rules };
  });

  app.put<{ Params: { nodeKey: string } }>('/api/agents/:nodeKey', async (request, reply) => {
    deprecate(reply);
    const { nodeKey } = request.params;
    const body = (request.body ?? {}) as Record<string, unknown>;
    if ('provider' in body || 'localId' in body || 'schemaVersion' in body || 'storage' in body) {
      return reply.code(400).send({ error: 'provider, localId, schemaVersion, and storage are immutable' });
    }
    let ctx;
    try {
      ctx = readProjectNodeInstance(DEFAULT_PROJECT_ID, nodeKey);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    // 改 name/model → 重写 node.json（V4）
    const d = ctx.descriptor;
    const updated = {
      ...d,
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.model === 'string' ? { model: body.model.trim() || undefined } : {}),
    };
    const file = join(ctx.nodeDir, 'node.json');
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
    renameSync(tmp, file);
    return { status: 'ok', nodeKey };
  });

  app.delete<{ Params: { nodeKey: string } }>('/api/agents/:nodeKey', async (request, reply) => {
    deprecate(reply);
    const { nodeKey } = request.params;
    // 图引用检查
    try {
      const graph = readProjectGraph(DEFAULT_PROJECT_ID);
      if (graph.nodes.some((n) => n.type === 'agent' && 'agentNodeKey' in n && n.agentNodeKey === nodeKey)) {
        return reply.code(409).send({ error: 'node is referenced by graph; remove it from graph first' });
      }
    } catch {
      /* 图读失败不阻塞删除 */
    }
    try {
      trashNodeInstance(DEFAULT_PROJECT_ID, nodeKey);
      return { status: 'ok', nodeKey };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { nodeKey: string } }>('/api/agents/:nodeKey/history', async (request, reply) => {
    deprecate(reply);
    const { nodeKey } = request.params;
    try {
      const ctx = readProjectNodeInstance(DEFAULT_PROJECT_ID, nodeKey);
      const sessionId = getActiveSessionCtx(ctx);
      return { history: sessionId ? await readNodeTranscriptCtx(ctx, sessionId) : [], sessionId: sessionId ?? null };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { nodeKey: string } }>('/api/agents/:nodeKey/sessions', async (request, reply) => {
    deprecate(reply);
    const { nodeKey } = request.params;
    try {
      const ctx = readProjectNodeInstance(DEFAULT_PROJECT_ID, nodeKey);
      return { activeSessionId: getActiveSessionCtx(ctx) ?? null, sessions: await listNodeSessionsCtx(ctx) };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { nodeKey: string } }>('/api/agents/:nodeKey/sessions/activate', async (request, reply) => {
    deprecate(reply);
    const { nodeKey } = request.params;
    const { sessionId } = (request.body ?? {}) as { sessionId?: string };
    if (typeof sessionId !== 'string' || !sessionId.trim()) return reply.code(400).send({ error: 'sessionId required' });
    try {
      const ctx = readProjectNodeInstance(DEFAULT_PROJECT_ID, nodeKey);
      setActiveSessionCtx(ctx, sessionId);
      return { status: 'ok', activeSessionId: sessionId };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { nodeKey: string } }>('/api/agents/:nodeKey/sessions/new', async (request, reply) => {
    deprecate(reply);
    const { nodeKey } = request.params;
    try {
      const ctx = readProjectNodeInstance(DEFAULT_PROJECT_ID, nodeKey);
      clearActiveSessionCtx(ctx);
      return { status: 'ok', activeSessionId: null };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.put<{ Params: { nodeKey: string } }>('/api/agents/:nodeKey/identity', async (request, reply) => {
    deprecate(reply);
    const { nodeKey } = request.params;
    const { content } = (request.body ?? {}) as { content?: string };
    if (typeof content !== 'string') return reply.code(400).send({ error: 'content required' });
    try {
      const ctx = readProjectNodeInstance(DEFAULT_PROJECT_ID, nodeKey);
      const resolved = resolveInstanceDescriptorPaths(ctx);
      const full = resolved.storage.config.identityFile;
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf-8');
      return { status: 'ok' };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.put<{ Params: { nodeKey: string } }>('/api/agents/:nodeKey/rules', async (request, reply) => {
    deprecate(reply);
    const { nodeKey } = request.params;
    const { file, content } = (request.body ?? {}) as { file?: string; content?: string };
    if (typeof file !== 'string' || !file.trim()) return reply.code(400).send({ error: 'file required' });
    if (typeof content !== 'string') return reply.code(400).send({ error: 'content required' });
    let ctx;
    try {
      ctx = readProjectNodeInstance(DEFAULT_PROJECT_ID, nodeKey);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    const resolved = resolveInstanceDescriptorPaths(ctx);
    const configRoot = dirname(resolved.storage.config.identityFile);
    const rulesRoot = join(configRoot, 'rules');
    const target = resolve(ctx.nodeDir, file);
    const rel = relative(rulesRoot, target);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return reply.code(400).send({ error: 'file must be inside this node\'s config/rules directory' });
    }
    if (!target.toLowerCase().endsWith('.md')) return reply.code(400).send({ error: 'only .md files are allowed' });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
    return { status: 'ok', file: relative(ctx.nodeDir, target).replace(/\\/g, '/') };
  });

  done();
};

void parseNodeKey;
void parseInstanceKey;
void formatInstanceKey;
void existsSync;

export default agentsRoutes;
