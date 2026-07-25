import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FastifyPluginCallback } from 'fastify';
import {
  formatNodeKey,
  listNodeDescriptors,
  nodeKeyOf,
  nodeRoot,
  NodeDescriptorSchema,
  readNodeDescriptor,
  type NodeDescriptor,
  writeNodeDescriptor,
} from '../agents/NodeDescriptor.js';
import { clearActiveSession, getActiveSession, setActiveSession } from '../agents/SessionChain.js';
import { PROVIDERS } from '../agents/register-providers.js';
import { listNodeSessions, readNodeTranscript } from '../agents/transcript-router.js';
import { resolveGlob } from '../utils/glob.js';
import { getProjectRoot } from '../utils/project-root.js';

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

function findDescriptor(nodeKey: string): NodeDescriptor | undefined {
  try {
    return readNodeDescriptor(nodeKey);
  } catch {
    return undefined;
  }
}

function scaffoldNode(descriptor: NodeDescriptor): void {
  const root = getProjectRoot();
  const configRoot = join(nodeRoot(descriptor), 'config');
  mkdirSync(join(configRoot, 'rules'), { recursive: true });

  const identityFull = resolve(root, descriptor.storage.config.identityFile);
  if (!existsSync(identityFull)) {
    mkdirSync(dirname(identityFull), { recursive: true });
    writeFileSync(
      identityFull,
      `# ${descriptor.name} 节点身份\n\n你是 0AgentTeams 平台中的一个 Agent 节点，由 ${descriptor.provider} CLI 驱动。\n\n## 你的能力\n- 你可以直接读写当前项目的源码文件（工作目录 = 项目根）。\n- 你能编辑 agents/${descriptor.provider}/${descriptor.localId}/config/ 下的 identity.md 与 rules/*.md 改变自己的行为。\n\n## 工作方式\n- 收到需求后先理解意图，再用工具落地。改动小而精准，改完简要说明。\n`,
      'utf-8',
    );
  }

  const rulesPath = join(configRoot, 'rules', 'general.md');
  if (!existsSync(rulesPath)) {
    writeFileSync(rulesPath, `# ${descriptor.name} 通用规则\n\n## 沟通\n- 用中文回答，除非用户用其它语言提问。\n- 回答简洁直接。\n`, 'utf-8');
  }
}

const agentsRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get('/api/agents', async () => listNodeDescriptors().map((descriptor) => ({
    nodeKey: nodeKeyOf(descriptor),
    localId: descriptor.localId,
    name: descriptor.name,
    provider: descriptor.provider,
    model: descriptor.model,
  })));

  app.get('/api/agents/providers', async () => PROVIDERS);

  app.post('/api/providers/:provider/agents', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const meta = PROVIDERS.find((item) => item.id === provider);
    if (!meta) return reply.code(400).send({ error: `unknown provider: ${provider}` });

    const localId = typeof body.localId === 'string' ? body.localId.trim() : '';
    let nodeKey: string;
    try {
      nodeKey = formatNodeKey(provider, localId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid localId' });
    }

    if (findDescriptor(nodeKey)) {
      return reply.code(409).send({ error: `node already exists: ${nodeKey}` });
    }
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : localId;
    const duplicateName = listNodeDescriptors().find((descriptor) =>
      descriptor.provider === provider && descriptor.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (duplicateName) {
      return reply.code(409).send({ error: `node name already exists in ${provider}: ${name}` });
    }

    const base = `agents/${provider}/${localId}`;
    const parsed = NodeDescriptorSchema.safeParse({
      schemaVersion: 3,
      localId,
      name,
      provider,
      cli: {
        command: meta.command,
        sandboxMode: 'danger-full-access',
        extraArgs: [],
        promptVia: 'stdin',
        cwd: '${PROJECT_ROOT}',
      },
      ...(typeof body.model === 'string' && body.model.trim()
        ? { model: body.model.trim() }
        : meta.defaultModel ? { model: meta.defaultModel } : {}),
      storage: {
        config: {
          identityFile: `${base}/config/identity.md`,
          rulesFiles: [`${base}/config/rules/*.md`],
        },
        runtime: {
          activeSessionFile: `${base}/runtime/active-session.json`,
          resume: true,
        },
        data: { cliHome: `${base}/data/cli/${meta.memoryHome}` },
      },
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid descriptor', issues: parsed.error.issues });
    }

    try {
      writeNodeDescriptor(nodeKey, parsed.data);
      scaffoldNode(parsed.data);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'node creation failed' });
    }
    return reply.code(201).send({ status: 'ok', nodeKey, localId, created: true });
  });

  app.get('/api/agents/:nodeKey', async (request, reply) => {
    const { nodeKey } = request.params as { nodeKey: string };
    const descriptor = findDescriptor(nodeKey);
    if (!descriptor) return reply.code(404).send({ error: `node not found: ${nodeKey}` });
    const root = getProjectRoot();
    const identity = readText(resolve(root, descriptor.storage.config.identityFile));
    const rules: { file: string; content: string }[] = [];
    for (const pattern of descriptor.storage.config.rulesFiles) {
      for (const file of resolveGlob(pattern, root)) {
        const content = readText(file);
        if (content !== undefined) rules.push({ file, content });
      }
    }
    return { nodeKey, descriptor, identity, rules };
  });

  app.put('/api/agents/:nodeKey', async (request, reply) => {
    const { nodeKey } = request.params as { nodeKey: string };
    const descriptor = findDescriptor(nodeKey);
    if (!descriptor) return reply.code(404).send({ error: `node not found: ${nodeKey}` });
    const body = (request.body ?? {}) as Record<string, unknown>;
    if ('provider' in body || 'localId' in body || 'schemaVersion' in body || 'storage' in body) {
      return reply.code(400).send({ error: 'provider, localId, schemaVersion, and storage are immutable' });
    }

    const updated = NodeDescriptorSchema.safeParse({
      ...descriptor,
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.model === 'string' ? { model: body.model.trim() || undefined } : {}),
      ...(typeof body.cli === 'object' && body.cli !== null
        ? { cli: { ...descriptor.cli, ...(body.cli as Record<string, unknown>) } }
        : {}),
    });
    if (!updated.success) return reply.code(400).send({ error: 'invalid descriptor', issues: updated.error.issues });
    const duplicateName = listNodeDescriptors().find((item) =>
      nodeKeyOf(item) !== nodeKey
      && item.provider === descriptor.provider
      && item.name.toLocaleLowerCase() === updated.data.name.toLocaleLowerCase());
    if (duplicateName) return reply.code(409).send({ error: `node name already exists in ${descriptor.provider}: ${updated.data.name}` });
    writeNodeDescriptor(nodeKey, updated.data);
    return { status: 'ok', nodeKey };
  });

  app.delete('/api/agents/:nodeKey', async (request, reply) => {
    const { nodeKey } = request.params as { nodeKey: string };
    const descriptor = findDescriptor(nodeKey);
    if (!descriptor) return reply.code(404).send({ error: `node not found: ${nodeKey}` });
    const target = descriptor.migrationPending
      ? join(getProjectRoot(), 'agents', descriptor.localId)
      : nodeRoot(descriptor);
    rmSync(target, { recursive: true, force: true });
    if (descriptor.migrationPending) rmSync(join(getProjectRoot(), 'agents', `${descriptor.localId}.json`), { force: true });
    return { status: 'ok', nodeKey };
  });

  app.get('/api/agents/:nodeKey/history', async (request, reply) => {
    const { nodeKey } = request.params as { nodeKey: string };
    const descriptor = findDescriptor(nodeKey);
    if (!descriptor) return reply.code(404).send({ error: `node not found: ${nodeKey}` });
    const sessionId = getActiveSession(descriptor);
    return { history: sessionId ? await readNodeTranscript(descriptor, sessionId) : [], sessionId: sessionId ?? null };
  });

  app.get('/api/agents/:nodeKey/sessions', async (request, reply) => {
    const { nodeKey } = request.params as { nodeKey: string };
    const descriptor = findDescriptor(nodeKey);
    if (!descriptor) return reply.code(404).send({ error: `node not found: ${nodeKey}` });
    return { activeSessionId: getActiveSession(descriptor) ?? null, sessions: await listNodeSessions(descriptor) };
  });

  app.post('/api/agents/:nodeKey/sessions/activate', async (request, reply) => {
    const { nodeKey } = request.params as { nodeKey: string };
    const { sessionId } = (request.body ?? {}) as { sessionId?: string };
    if (typeof sessionId !== 'string' || !sessionId.trim()) return reply.code(400).send({ error: 'sessionId required' });
    const descriptor = findDescriptor(nodeKey);
    if (!descriptor) return reply.code(404).send({ error: `node not found: ${nodeKey}` });
    setActiveSession(descriptor, sessionId);
    return { status: 'ok', activeSessionId: sessionId };
  });

  app.post('/api/agents/:nodeKey/sessions/new', async (request, reply) => {
    const { nodeKey } = request.params as { nodeKey: string };
    const descriptor = findDescriptor(nodeKey);
    if (!descriptor) return reply.code(404).send({ error: `node not found: ${nodeKey}` });
    clearActiveSession(descriptor);
    return { status: 'ok', activeSessionId: null };
  });

  app.put('/api/agents/:nodeKey/identity', async (request, reply) => {
    const { nodeKey } = request.params as { nodeKey: string };
    const { content } = (request.body ?? {}) as { content?: string };
    if (typeof content !== 'string') return reply.code(400).send({ error: 'content required' });
    const descriptor = findDescriptor(nodeKey);
    if (!descriptor) return reply.code(404).send({ error: `node not found: ${nodeKey}` });
    const full = resolve(getProjectRoot(), descriptor.storage.config.identityFile);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
    return { status: 'ok' };
  });

  app.put('/api/agents/:nodeKey/rules', async (request, reply) => {
    const { nodeKey } = request.params as { nodeKey: string };
    const { file, content } = (request.body ?? {}) as { file?: string; content?: string };
    if (typeof file !== 'string' || !file.trim()) return reply.code(400).send({ error: 'file required' });
    if (typeof content !== 'string') return reply.code(400).send({ error: 'content required' });
    const descriptor = findDescriptor(nodeKey);
    if (!descriptor) return reply.code(404).send({ error: `node not found: ${nodeKey}` });
    const root = getProjectRoot();
    const configRoot = dirname(resolve(root, descriptor.storage.config.identityFile));
    const rulesRoot = join(configRoot, 'rules');
    const target = resolve(root, file);
    const rel = relative(rulesRoot, target);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return reply.code(400).send({ error: 'file must be inside this node\'s config/rules directory' });
    }
    if (!target.toLowerCase().endsWith('.md')) {
      return reply.code(400).send({ error: 'only .md files are allowed' });
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
    return { status: 'ok', file: relative(root, target).replace(/\\/g, '/') };
  });

  done();
};

export default agentsRoutes;
