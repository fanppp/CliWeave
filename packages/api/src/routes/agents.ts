/**
 * GET  /api/agents            列出所有节点（id/name/provider）
 * GET  /api/agents/:id        节点详情（descriptor + identity 文本 + rules 文本）
 * POST /api/agents/:id        写入/更新节点 descriptor（codex 自增节点走这）
 * PUT  /api/agents/:id/identity  更新 identity.md
 * PUT  /api/agents/:id/rules   追加一条 rule 文件
 */
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import {
  type NodeDescriptor,
  NodeDescriptorSchema,
  listNodeDescriptors,
  readNodeDescriptor,
  writeNodeDescriptor,
} from '../agents/NodeDescriptor.js';
import { clearActiveSession, getActiveSession, setActiveSession } from '../agents/SessionChain.js';
import { PROVIDERS } from '../agents/register-providers.js';
import { listNodeSessions, readNodeTranscript } from '../agents/transcript-router.js';
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
    const identity = readText(resolve(root, descriptor.storage.config.identityFile));
    const rules: { file: string; content: string }[] = [];
    for (const pattern of descriptor.storage.config.rulesFiles) {
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
    // 直接读 CLI 自己的会话 transcript（单一真相源 = CLI 记忆，存本项目）
    const sessionId = getActiveSession(descriptor);
    const history = sessionId ? await readNodeTranscript(descriptor, sessionId) : [];
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
    return { activeSessionId: active ?? null, sessions: await listNodeSessions(descriptor) };
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

  app.get('/api/agents/providers', async () => PROVIDERS);

  app.post('/api/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    // 补默认 v2 storage（按 provider）
    const provider = typeof body.provider === 'string' ? body.provider : 'codex';
    const meta = PROVIDERS.find((p) => p.id === provider);
    const memoryHome = meta?.memoryHome ?? `.${provider}`;
    const descriptorDefaults = {
      schemaVersion: 2 as const,
      cli: { command: meta?.command ?? provider },
      storage: {
        config: {
          identityFile: `agents/${id}/config/identity.md`,
          rulesFiles: [`agents/${id}/config/rules/*.md`],
        },
        runtime: {
          activeSessionFile: `agents/${id}/runtime/active-session.json`,
          resume: true,
        },
        data: { cliHome: `agents/${id}/data/cli/${memoryHome}` },
      },
      ...(meta?.defaultModel ? { model: meta.defaultModel } : {}),
    };
    const bodyStorage = typeof body.storage === 'object' && body.storage !== null
      ? body.storage as Record<string, unknown>
      : {};
    const bodyConfig = typeof bodyStorage.config === 'object' && bodyStorage.config !== null
      ? bodyStorage.config as Record<string, unknown>
      : {};
    const bodyRuntime = typeof bodyStorage.runtime === 'object' && bodyStorage.runtime !== null
      ? bodyStorage.runtime as Record<string, unknown>
      : {};
    const bodyData = typeof bodyStorage.data === 'object' && bodyStorage.data !== null
      ? bodyStorage.data as Record<string, unknown>
      : {};
    const parsed = NodeDescriptorSchema.safeParse({
      ...descriptorDefaults,
      ...body,
      id,
      model: typeof body.model === 'string' && body.model.trim().length > 0
        ? body.model.trim()
        : meta?.defaultModel ?? '',
      storage: {
        ...descriptorDefaults.storage,
        ...bodyStorage,
        config: { ...descriptorDefaults.storage.config, ...bodyConfig },
        runtime: { ...descriptorDefaults.storage.runtime, ...bodyRuntime },
        data: { ...descriptorDefaults.storage.data, ...bodyData },
      },
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid descriptor', issues: parsed.error.issues });
    }
    const isNew = !existsSync(join(getProjectRoot(), 'agents', `${id}.json`));
    try {
      writeNodeDescriptor(id, parsed.data);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : 'invalid node storage paths',
      });
    }

    // 新节点：脚手架 config；runtime/data 在首次使用时创建。
    if (isNew) {
      const root = getProjectRoot();
      const nodeDir = join(root, 'agents', id);
      mkdirSync(join(nodeDir, 'config', 'rules'), { recursive: true });
      const identityPath = parsed.data.storage.config.identityFile;
      const identityFull = resolve(root, identityPath);
      if (!existsSync(identityFull)) {
        writeFileSync(
          identityFull,
          `# ${parsed.data.name} 节点身份\n\n你是 0AgentTeams 平台中的一个 Agent 节点，由 ${parsed.data.provider} CLI 驱动。\n\n## 你的能力\n- 你可以直接读写当前项目的源码文件（工作目录 = 项目根）。\n- 你能编辑 agents/${id}/config/ 下的 identity.md 与 rules/*.md 改变自己的行为。\n\n## 工作方式\n- 收到需求后先理解意图，再用工具落地。改动小而精准，改完简要说明。\n`,
          'utf-8',
        );
      }
      const rulesPath = join(nodeDir, 'config', 'rules', 'general.md');
      if (!existsSync(rulesPath)) {
        writeFileSync(rulesPath, `# ${parsed.data.name} 通用规则\n\n## 沟通\n- 用中文回答，除非用户用其它语言提问。\n- 回答简洁直接。\n`, 'utf-8');
      }
    }
    return { status: 'ok', id, created: isNew };
  });

  app.delete('/api/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const root = getProjectRoot();
    const jsonFile = join(root, 'agents', `${id}.json`);
    const nodeDir = join(root, 'agents', id);
    if (!existsSync(jsonFile)) {
      return reply.code(404).send({ error: `node not found: ${id}` });
    }
    rmSync(jsonFile, { force: true });
    rmSync(nodeDir, { recursive: true, force: true });
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
    const identityPath = descriptor.storage.config.identityFile;
    const full = resolve(getProjectRoot(), identityPath);
    mkdirSync(resolve(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
    return { status: 'ok' };
  });

  done();
};

export default agentsRoutes;
