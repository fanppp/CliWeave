/**
 * GET  /api/agents            列出所有节点（id/name/provider）
 * GET  /api/agents/:id        节点详情（descriptor + identity 文本 + rules 文本）
 * POST /api/agents/:id        写入/更新节点 descriptor（codex 自增节点走这）
 * PUT  /api/agents/:id/identity  更新 identity.md
 * PUT  /api/agents/:id/rules   追加一条 rule 文件
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import {
  type NodeDescriptor,
  NodeDescriptorSchema,
  listNodeDescriptors,
  readNodeDescriptor,
  writeNodeDescriptor,
} from '../agents/NodeDescriptor.js';
import { clearActiveSession, getActiveSession, setActiveSession } from '../agents/SessionChain.js';
import { resolveCodexHome } from '../agents/codex-home.js';
import { listCodexSessions, readCodexTranscript } from '../agents/providers/codex-transcript.js';
import { getProjectRoot } from '../utils/project-root.js';
import { resolveGlob } from '../utils/glob.js';

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

const agentsRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get('/api/agents', async () => {
    return listNodeDescriptors().map((d) => ({
      id: d.id,
      name: d.name,
      provider: d.provider,
      model: d.model,
    }));
  });

  app.get('/api/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    let descriptor: NodeDescriptor;
    try {
      descriptor = readNodeDescriptor(id);
    } catch {
      return reply.code(404).send({ error: `node not found: ${id}` });
    }
    const root = getProjectRoot();
    const identity = descriptor.prompt?.identity ? readText(resolve(root, descriptor.prompt.identity)) : undefined;
    const rules: { file: string; content: string }[] = [];
    for (const pattern of descriptor.rules?.files ?? []) {
      for (const file of resolveGlob(pattern, root)) {
        const content = readText(file);
        if (content !== undefined) rules.push({ file, content });
      }
    }
    return { descriptor, identity, rules };
  });

  app.get('/api/agents/:id/history', async (request, reply) => {
    const { id } = request.params as { id: string };
    let descriptor: NodeDescriptor;
    try {
      descriptor = readNodeDescriptor(id);
    } catch {
      return reply.code(404).send({ error: `node not found: ${id}` });
    }
    // 直接读 codex 自己的会话 transcript（单一真相源 = CLI 记忆，存本项目）
    const sessionId = getActiveSession(descriptor);
    const codexHome = resolveCodexHome(descriptor);
    const history = sessionId ? readCodexTranscript(sessionId, codexHome) : [];
    return { history, sessionId: sessionId ?? null };
  });

  app.get('/api/agents/:id/sessions', async (request, reply) => {
    const { id } = request.params as { id: string };
    let descriptor: NodeDescriptor;
    try {
      descriptor = readNodeDescriptor(id);
    } catch {
      return reply.code(404).send({ error: `node not found: ${id}` });
    }
    const active = getActiveSession(descriptor);
    return { activeSessionId: active ?? null, sessions: listCodexSessions(resolveCodexHome(descriptor)) };
  });

  app.post('/api/agents/:id/sessions/activate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { sessionId } = request.body as { sessionId?: string };
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      return reply.code(400).send({ error: 'sessionId required' });
    }
    let descriptor: NodeDescriptor;
    try {
      descriptor = readNodeDescriptor(id);
    } catch {
      return reply.code(404).send({ error: `node not found: ${id}` });
    }
    setActiveSession(descriptor, sessionId);
    return { status: 'ok', activeSessionId: sessionId };
  });

  app.post('/api/agents/:id/sessions/new', async (request, reply) => {
    const { id } = request.params as { id: string };
    let descriptor: NodeDescriptor;
    try {
      descriptor = readNodeDescriptor(id);
    } catch {
      return reply.code(404).send({ error: `node not found: ${id}` });
    }
    clearActiveSession(descriptor);
    return { status: 'ok', activeSessionId: null };
  });

  app.post('/api/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const parsed = NodeDescriptorSchema.safeParse({ ...body, id });
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid descriptor', issues: parsed.error.issues });
    }
    writeNodeDescriptor(id, parsed.data);
    return { status: 'ok', id };
  });

  app.put('/api/agents/:id/identity', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { content } = request.body as { content?: string };
    if (typeof content !== 'string') return reply.code(400).send({ error: 'content required' });
    let descriptor: NodeDescriptor;
    try {
      descriptor = readNodeDescriptor(id);
    } catch {
      return reply.code(404).send({ error: `node not found: ${id}` });
    }
    const identityPath = descriptor.prompt?.identity;
    if (!identityPath) return reply.code(400).send({ error: 'node has no identity file' });
    const full = resolve(getProjectRoot(), identityPath);
    mkdirSync(resolve(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
    return { status: 'ok' };
  });

  done();
};

export default agentsRoutes;
