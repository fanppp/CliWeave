/**
 * projects 路由 —— 画布作用域全量接口（M5.7）。
 *
 * - 项目 CRUD（path 不可改；local-path 仅缺失时可绑；default 禁删）。
 * - 图 GET/PUT + 原子 graph-node 创建/删（实例+图节点一次事务，回滚）。
 * - 节点实例 identity/rules 编辑、session、history（transcript）。
 * - 单节点消息（WS room node:<instanceKey>）+ 图运行（WS graph:<runId>），走 RunRegistry。
 * - Gemini provider 禁建/禁跑（installed:false）。
 * - 所有资源请求校验 URL projectId 与实例归属一致。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FastifyPluginCallback } from 'fastify';
import { buildAgent, getActiveSessionCtx, setActiveSessionCtx, clearActiveSessionCtx } from '../agents/AgentServiceFactory.js';
import { abortRun, registerAbort, unregisterAbort } from '../agents/abort-registry.js';
import { formatInstanceKey, parseInstanceKey } from '../agents/instance-key.js';
import { withNodeLock } from '../agents/node-mutex.js';
import { listNodeSessionsCtx, readNodeTranscriptCtx } from '../agents/transcript-router.js';
import {
  bindLocalPath,
  cleanupInstanceDir,
  createProject,
  DEFAULT_PROJECT_ID,
  instantiateNodeInstance,
  listProjectNodeInstances,
  listProjects,
  readProjectLocal,
  readProjectMeta,
  readProjectNodeInstance,
  renameProject,
  resolveProjectPath,
  trashNodeInstance,
  trashProject,
  type ProjectListItem,
} from '../agents/project-storage.js';
import { PROVIDERS } from '../agents/register-providers.js';
import {
  abortRunEntry,
  getRun,
  hasActiveRuns,
  registerRun,
  removeRun,
  transitionRunStatus,
} from '../agents/run-registry.js';
import { resolveInstanceDescriptorPaths } from '../agents/node-instance.js';
import { executeGraph } from '../agents/graph/AgentRouter.js';
import { invokeAgentWithPolicy } from '../agents/invoke-agent.js';
import {
  closeRunStream,
  listRuns,
  readRun,
  recordRunEvent,
  recordRunStart,
} from '../agents/graph/graph-run-store.js';
import {
  createThread,
  readThread,
  listThreads,
  trashThread,
  readThreadEvents,
  openTurn,
  completeTurn,
  failTurn,
  abortPendingTurn,
  writePendingRun,
  readPendingRun,
  deletePendingRun,
  ThreadConflictError,
} from '../agents/thread/thread-store.js';
import {
  GraphV3Schema,
  GraphValidationError,
  readProjectGraph,
  validateGraph,
  validateProjectRun,
  writeProjectGraph,
  type Graph,
  type GraphAgentNode,
} from '../agents/graph/graph.js';
import { resolveGlob } from '../utils/glob.js';
import { getProjectRoot } from '../utils/project-root.js';
import type { SocketManager } from '../infrastructure/websocket/SocketManager.js';

export interface ProjectsRouteOptions {
  socketManager: SocketManager;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

const projectsRoutes: FastifyPluginCallback<ProjectsRouteOptions> = (app, options, done) => {
  const { socketManager } = options;

  // ── 项目 CRUD ────────────────────────────────────────────────
  app.get('/api/projects', async () => listProjects());

  app.post('/api/projects', async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown; path?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const path = typeof body.path === 'string' ? body.path.trim() : '';
    if (!name) return reply.code(400).send({ error: 'name is required' });
    // path 留空 → 与 default 同路径（CliWeave 根）
    try {
      const meta = createProject(name, path || undefined);
      return reply.code(201).send(meta);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
    const { projectId } = request.params;
    try {
      const meta = readProjectMeta(projectId);
      const local = readProjectLocal(projectId);
      const item: ProjectListItem & { createdAt: number } = {
        id: meta.id,
        name: meta.name,
        createdAt: meta.createdAt,
        path: local?.path,
      };
      if (local) {
        try {
          if (!existsSync(local.path)) item.pathMissing = true;
        } catch {
          item.pathMissing = true;
        }
      } else {
        item.pathMissing = true;
      }
      return item;
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.put<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
    const { projectId } = request.params;
    const body = (request.body ?? {}) as { name?: unknown; path?: unknown };
    if ('path' in body) return reply.code(400).send({ error: 'path is immutable in M5 (create a new project or bind local-path)' });
    if (typeof body.name !== 'string' || !body.name.trim()) return reply.code(400).send({ error: 'name required' });
    try {
      return reply.send(renameProject(projectId, body.name));
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
    const { projectId } = request.params;
    if (projectId === DEFAULT_PROJECT_ID) return reply.code(409).send({ error: 'default project cannot be deleted' });
    try {
      readProjectMeta(projectId);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    // 有活跃运行 → 拒绝
    if (hasActiveRuns(projectId)) return reply.code(409).send({ error: 'project has active runs; abort them first' });
    try {
      trashProject(projectId);
      return reply.send({ status: 'ok', projectId });
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.put<{ Params: { projectId: string } }>('/api/projects/:projectId/local-path', async (request, reply) => {
    const { projectId } = request.params;
    const body = (request.body ?? {}) as { path?: unknown };
    const path = typeof body.path === 'string' ? body.path.trim() : '';
    if (!path) return reply.code(400).send({ error: 'path is required' });
    try {
      bindLocalPath(projectId, path);
      return reply.send({ status: 'ok', projectId });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('not found')) return reply.code(404).send({ error: msg });
      if (msg.includes('already bound')) return reply.code(409).send({ error: msg });
      return reply.code(400).send({ error: msg });
    }
  });

  // ── 图 ───────────────────────────────────────────────────────
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/graph', async (request, reply) => {
    try {
      return reply.send(readProjectGraph(request.params.projectId));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.put<{ Params: { projectId: string } }>('/api/projects/:projectId/graph', async (request, reply) => {
    const { projectId } = request.params;
    let graph: Graph;
    try {
      graph = GraphV3Schema.parse(request.body);
      validateGraph(graph);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid graph';
      return reply.code(400).send({ error: msg });
    }
    const missing: string[] = [];
    for (const node of graph.nodes) {
      if (node.type !== 'agent') continue;
      try {
        readProjectNodeInstance(projectId, node.agentNodeKey);
      } catch {
        missing.push(node.agentNodeKey);
      }
    }
    if (missing.length > 0) return reply.code(400).send({ error: `agent nodes not found in project: ${missing.join(', ')}` });
    try {
      writeProjectGraph(projectId, graph);
      return reply.code(200).send({ status: 'ok' });
    } catch (err) {
      return reply.code(500).send({ error: `write graph failed: ${(err as Error).message}` });
    }
  });

  // 原子：创建节点实例 + 加入图（+ 可选 connectFrom 边）。任一步失败回滚实例目录。
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/graph/nodes', async (request, reply) => {
    const { projectId } = request.params;
    const body = (request.body ?? {}) as {
      provider?: unknown; localId?: unknown; name?: unknown; identity?: unknown; model?: unknown;
      graphNodeId?: unknown; position?: unknown; connectFrom?: unknown;
    };
    const provider = typeof body.provider === 'string' ? body.provider : '';
    const localId = typeof body.localId === 'string' ? body.localId.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const graphNodeId = typeof body.graphNodeId === 'string' ? body.graphNodeId.trim() : '';
    if (!provider || !localId || !name || !graphNodeId) {
      return reply.code(400).send({ error: 'provider, localId, name, graphNodeId are required' });
    }
    const meta = PROVIDERS.find((p) => p.id === provider);
    if (!meta) return reply.code(400).send({ error: `unknown provider: ${provider}` });
    if (!meta.installed) return reply.code(409).send({ error: `provider '${provider}' is disabled (not installed)` });

    const nodeKey = `${provider}:${localId}`;
    // 预校验图：graphNodeId 不存在、connectFrom 存在
    let graph: Graph;
    try {
      graph = readProjectGraph(projectId);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    if (graph.nodes.some((n) => n.id === graphNodeId)) {
      return reply.code(409).send({ error: `graph node already exists: ${graphNodeId}` });
    }
    const connectFrom = typeof body.connectFrom === 'string' ? body.connectFrom.trim() : '';
    if (connectFrom && !graph.nodes.some((n) => n.id === connectFrom)) {
      return reply.code(400).send({ error: `connectFrom node not found: ${connectFrom}` });
    }
    if (graph.nodes.some((n) => n.type === 'agent' && 'agentNodeKey' in n && n.agentNodeKey === nodeKey)) {
      return reply.code(409).send({ error: `node instance already in graph: ${nodeKey}` });
    }

    // 1. 实例化（建实例目录）
    try {
      instantiateNodeInstance(projectId, nodeKey, {
        name,
        command: meta.command,
        memoryHome: meta.memoryHome,
        ...(typeof body.model === 'string' && body.model.trim() ? { model: body.model.trim() } : meta.defaultModel ? { model: meta.defaultModel } : {}),
        ...(typeof body.identity === 'string' ? { identity: body.identity } : {}),
      });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    // 2. 改图（加节点 + 可选边）。失败 → 回滚实例目录。
    const position = (body.position && typeof body.position === 'object' ? body.position : { x: 320, y: 80 + graph.nodes.length * 140 }) as { x: number; y: number };
    const newAgentNode: GraphAgentNode = { id: graphNodeId, type: 'agent', agentNodeKey: nodeKey, position };
    const newNodes = [...graph.nodes, newAgentNode];
    const newEdges = connectFrom
      ? [...graph.edges, { id: `${connectFrom}->${graphNodeId}`, source: connectFrom, target: graphNodeId }]
      : graph.edges;
    const newGraph: Graph = { ...graph, nodes: newNodes, edges: newEdges };
    try {
      writeProjectGraph(projectId, newGraph);
    } catch (err) {
      cleanupInstanceDir(projectId, nodeKey);
      return reply.code(500).send({ error: `write graph failed (instance rolled back): ${(err as Error).message}` });
    }
    return reply.code(201).send({ status: 'ok', nodeKey, graphNodeId });
  });

  // 原子：删图节点 + trash 实例（先移图后 trash；若 trash 失败图已无引用，可手动恢复）
  app.delete<{ Params: { projectId: string; graphNodeId: string } }>(
    '/api/projects/:projectId/graph/nodes/:graphNodeId',
    async (request, reply) => {
      const { projectId, graphNodeId } = request.params;
      let graph: Graph;
      try {
        graph = readProjectGraph(projectId);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const target = graph.nodes.find((n) => n.id === graphNodeId);
      if (!target || target.type !== 'agent') return reply.code(404).send({ error: `agent graph node not found: ${graphNodeId}` });
      const nodeKey = target.agentNodeKey;
      const newGraph: Graph = {
        ...graph,
        nodes: graph.nodes.filter((n) => n.id !== graphNodeId),
        edges: graph.edges.filter((e) => e.source !== graphNodeId && e.target !== graphNodeId),
      };
      try {
        writeProjectGraph(projectId, newGraph);
      } catch (err) {
        return reply.code(500).send({ error: `write graph failed: ${(err as Error).message}` });
      }
      trashNodeInstance(projectId, nodeKey);
      return reply.send({ status: 'ok', graphNodeId, nodeKey });
    },
  );

  // ── 节点实例编辑/读取 ────────────────────────────────────────
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/nodes', async (request) => {
    const pid = request.params.projectId;
    const nodes = listProjectNodeInstances(pid).map((n) => ({
      ...n,
      instanceKey: formatInstanceKey(pid, n.nodeKey),
    }));
    return { nodes };
  });

  // 实例-only 创建（不加图节点；node 模式用）。校验 provider enabled + 项目存在 + scaffold 由 instantiateNodeInstance 负责。
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/nodes', async (request, reply) => {
    const { projectId } = request.params;
    const body = (request.body ?? {}) as {
      provider?: unknown; localId?: unknown; name?: unknown; model?: unknown; identity?: unknown;
    };
    const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
    const localId = typeof body.localId === 'string' ? body.localId.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!provider || !localId || !name) {
      return reply.code(400).send({ error: 'provider, localId, name are required' });
    }
    const meta = PROVIDERS.find((p) => p.id === provider);
    if (!meta) return reply.code(400).send({ error: `unknown provider: ${provider}` });
    if (!meta.installed) return reply.code(409).send({ error: `provider '${provider}' is disabled (not installed)` });
    const nodeKey = `${provider}:${localId}`;
    try {
      readProjectNodeInstance(projectId, nodeKey);
      return reply.code(409).send({ error: `node already exists: ${nodeKey}` });
    } catch {
      /* 不存在，继续 */
    }
    try {
      const ctx = instantiateNodeInstance(projectId, nodeKey, {
        name,
        command: meta.command,
        memoryHome: meta.memoryHome,
        ...(typeof body.model === 'string' && body.model.trim() ? { model: body.model.trim() } : meta.defaultModel ? { model: meta.defaultModel } : {}),
        ...(typeof body.identity === 'string' ? { identity: body.identity } : {}),
      });
      return reply.code(201).send({ status: 'ok', nodeKey, localId: ctx.descriptor.localId, instanceKey: formatInstanceKey(projectId, nodeKey) });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { projectId: string; nodeKey: string } }>(
    '/api/projects/:projectId/nodes/:nodeKey',
    async (request, reply) => {
      const { projectId, nodeKey } = request.params;
      // nodeKey 含冒号，Fastify 默认不截断 path 段，但需确认 :nodeKey 匹配整段
      let ctx;
      try {
        ctx = readProjectNodeInstance(projectId, nodeKey);
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
      return {
        nodeKey,
        descriptor: ctx.descriptor,
        provider: ctx.descriptor.provider,
        localId: ctx.descriptor.localId,
        name: ctx.descriptor.name,
        model: ctx.descriptor.model,
        identity,
        rules,
      };
    },
  );

  app.put<{ Params: { projectId: string; nodeKey: string } }>(
    '/api/projects/:projectId/nodes/:nodeKey/identity',
    async (request, reply) => {
      const { projectId, nodeKey } = request.params;
      const { content } = (request.body ?? {}) as { content?: string };
      if (typeof content !== 'string') return reply.code(400).send({ error: 'content required' });
      let ctx;
      try {
        ctx = readProjectNodeInstance(projectId, nodeKey);
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
      const resolved = resolveInstanceDescriptorPaths(ctx);
      const full = resolved.storage.config.identityFile;
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf-8');
      return { status: 'ok' };
    },
  );

  app.put<{ Params: { projectId: string; nodeKey: string } }>(
    '/api/projects/:projectId/nodes/:nodeKey/rules',
    async (request, reply) => {
      const { projectId, nodeKey } = request.params;
      const { file, content } = (request.body ?? {}) as { file?: string; content?: string };
      if (typeof file !== 'string' || !file.trim()) return reply.code(400).send({ error: 'file required' });
      if (typeof content !== 'string') return reply.code(400).send({ error: 'content required' });
      let ctx;
      try {
        ctx = readProjectNodeInstance(projectId, nodeKey);
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
    },
  );

  app.delete<{ Params: { projectId: string; nodeKey: string } }>(
    '/api/projects/:projectId/nodes/:nodeKey',
    async (request, reply) => {
      const { projectId, nodeKey } = request.params;
      // 图引用检查
      let graph: Graph;
      try {
        graph = readProjectGraph(projectId);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      if (graph.nodes.some((n) => n.type === 'agent' && 'agentNodeKey' in n && n.agentNodeKey === nodeKey)) {
        return reply.code(409).send({ error: 'node is referenced by graph; remove it from graph first' });
      }
      try {
        trashNodeInstance(projectId, nodeKey);
        return reply.send({ status: 'ok', nodeKey });
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    },
  );

  // ── session / history ─────────────────────────────────────────
  app.get<{ Params: { projectId: string; nodeKey: string } }>(
    '/api/projects/:projectId/nodes/:nodeKey/sessions',
    async (request, reply) => {
      const { projectId, nodeKey } = request.params;
      try {
        const ctx = readProjectNodeInstance(projectId, nodeKey);
        return { activeSessionId: getActiveSessionCtx(ctx) ?? null, sessions: await listNodeSessionsCtx(ctx) };
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { projectId: string; nodeKey: string } }>(
    '/api/projects/:projectId/nodes/:nodeKey/sessions/activate',
    async (request, reply) => {
      const { projectId, nodeKey } = request.params;
      const { sessionId } = (request.body ?? {}) as { sessionId?: string };
      if (typeof sessionId !== 'string' || !sessionId.trim()) return reply.code(400).send({ error: 'sessionId required' });
      try {
        const ctx = readProjectNodeInstance(projectId, nodeKey);
        setActiveSessionCtx(ctx, sessionId);
        return { status: 'ok', activeSessionId: sessionId };
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { projectId: string; nodeKey: string } }>(
    '/api/projects/:projectId/nodes/:nodeKey/sessions/new',
    async (request, reply) => {
      const { projectId, nodeKey } = request.params;
      try {
        const ctx = readProjectNodeInstance(projectId, nodeKey);
        clearActiveSessionCtx(ctx);
        return { status: 'ok', activeSessionId: null };
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { projectId: string; nodeKey: string } }>(
    '/api/projects/:projectId/nodes/:nodeKey/history',
    async (request, reply) => {
      const { projectId, nodeKey } = request.params;
      try {
        const ctx = readProjectNodeInstance(projectId, nodeKey);
        const sessionId = getActiveSessionCtx(ctx);
        return { history: sessionId ? await readNodeTranscriptCtx(ctx, sessionId) : [], sessionId: sessionId ?? null };
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    },
  );

  // ── 单节点消息 ───────────────────────────────────────────────
  app.post<{ Params: { projectId: string; nodeKey: string } }>(
    '/api/projects/:projectId/nodes/:nodeKey/messages',
    async (request, reply) => {
      const { projectId, nodeKey } = request.params;
      try {
        parseInstanceKey(formatInstanceKey(projectId, nodeKey)); // 校验 projectId+nodeKey 合法
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const { content } = (request.body ?? {}) as { content?: unknown };
      const text = typeof content === 'string' ? content : '';
      if (text.trim().length === 0) return reply.code(400).send({ error: 'content is required' });

      const invocationId = crypto.randomUUID();
      const instanceKey = formatInstanceKey(projectId, nodeKey);
      registerRun({ id: invocationId, projectId, instanceKey, kind: 'message', status: 'pending', createdAt: Date.now() });
      reply.code(202).send({ status: 'ok', instanceKey, invocationId });

      setImmediate(async () => {
        const controller = registerAbort(invocationId);
        transitionRunStatus(invocationId, 'running');
        let aborted = false;
        controller.signal.addEventListener('abort', () => {
          aborted = true;
        });
        try {
          await withNodeLock(instanceKey, async () => {
            const { ctx, service } = await buildAgent(projectId, nodeKey);
            const resumeSid = getActiveSessionCtx(ctx);
            socketManager.broadcast(
              { type: 'system_info', nodeId: nodeKey, content: JSON.stringify({ type: 'invoking', invocationId, resume: !!resumeSid }), timestamp: Date.now() },
              instanceKey,
            );
            const outcome = await invokeAgentWithPolicy({
              service,
              nodeId: nodeKey,
              prompt: text,
              policy: { mode: 'active' },
              workingDirectory: ctx.projectPath,
              invocationId,
              signal: controller.signal,
              onMessage: (msg) => socketManager.broadcast(msg, instanceKey),
              getActiveSession: () => getActiveSessionCtx(ctx),
              setActiveSession: (sid) => setActiveSessionCtx(ctx, sid),
            });
            if (outcome.status === 'aborted' || aborted) {
              socketManager.broadcast({ type: 'system_info', nodeId: nodeKey, content: '已中止', timestamp: Date.now() }, instanceKey);
            } else if (outcome.status === 'error') {
              socketManager.broadcast({ type: 'error', nodeId: nodeKey, error: outcome.error ?? '', timestamp: Date.now() }, instanceKey);
            }
            // 唯一终态 done（helper 吞了 provider 的 done/error，此处统一发一次）
            socketManager.broadcast({ type: 'done', nodeId: nodeKey, timestamp: Date.now() }, instanceKey);
          });
          // 终态由结果决定：aborted 不覆盖成 done
          transitionRunStatus(invocationId, aborted ? 'aborted' : 'done');
        } catch (err) {
          socketManager.broadcast({ type: 'error', nodeId: nodeKey, error: `节点调用失败: ${(err as Error).message}`, timestamp: Date.now() }, instanceKey);
          socketManager.broadcast({ type: 'done', nodeId: nodeKey, timestamp: Date.now() }, instanceKey);
          transitionRunStatus(invocationId, 'error');
        } finally {
          unregisterAbort(invocationId);
          // 终态短暂保留供查询，TTL 清理；此处不移除
        }
      });
    },
  );

  app.post<{ Params: { projectId: string; invocationId: string } }>(
    '/api/projects/:projectId/messages/:invocationId/abort',
    async (request, reply) => {
      const { projectId, invocationId } = request.params;
      const entry = getRun(invocationId);
      if (!entry || entry.projectId !== projectId) return reply.code(404).send({ error: 'run not found in this project' });
      const ok = abortRunEntry(invocationId) || abortRun(invocationId);
      return reply.code(ok ? 202 : 404).send({ status: ok ? 'aborted' : 'not_found', invocationId });
    },
  );

  // ── 图运行 ───────────────────────────────────────────────────
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/run', async (request, reply) => {
    const { projectId } = request.params;
    const body = (request.body ?? {}) as {
      message?: unknown;
      prompt?: unknown; // 兼容旧前端 {prompt}
      threadId?: unknown;
      expectedThreadRevision?: unknown;
    };
    const message =
      typeof body.message === 'string' ? body.message : typeof body.prompt === 'string' ? body.prompt : '';
    if (message.trim().length === 0) return reply.code(400).send({ error: 'message is required' });
    try {
      readProjectMeta(projectId);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }

    // 解析/创建 Thread（新对话省略 threadId；继续对话须 threadId + expectedThreadRevision）
    let threadId: string;
    let expectedRevision: number;
    const bodyThreadId = typeof body.threadId === 'string' ? body.threadId.trim() : '';
    if (bodyThreadId) {
      const thread = readThread(projectId, bodyThreadId);
      if (!thread) return reply.code(404).send({ error: 'thread not found' });
      threadId = thread.id;
      if (typeof body.expectedThreadRevision !== 'number' || !Number.isInteger(body.expectedThreadRevision)) {
        return reply.code(400).send({ error: 'expectedThreadRevision is required to continue a thread' });
      }
      expectedRevision = body.expectedThreadRevision;
    } else {
      threadId = createThread(projectId, message.slice(0, 40).trim() || '新对话').id;
      expectedRevision = 0;
    }

    const runId = crypto.randomUUID();
    try {
      const turn = await openTurn(projectId, threadId, expectedRevision, { runId, userMessage: message });
      // 持久化 pending run（create↔start 之间重启不丢 user turn）
      writePendingRun({
        runId,
        projectId,
        threadId,
        turnId: turn.turnId,
        prompt: message,
        threadRevision: turn.revision,
        createdAt: Date.now(),
      });
      registerRun({
        id: runId,
        projectId,
        kind: 'graph',
        status: 'pending',
        createdAt: Date.now(),
        threadId,
        turnId: turn.turnId,
      });
      return reply.code(202).send({ status: 'created', runId, threadId, turnId: turn.turnId });
    } catch (err) {
      if (err instanceof ThreadConflictError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.post<{ Params: { projectId: string; runId: string } }>(
    '/api/projects/:projectId/run/:runId/start',
    async (request, reply) => {
      const { projectId, runId } = request.params;
      // pending run 落盘（重启不丢）；优先于内存 registry
      const pending = readPendingRun(projectId, runId);
      if (!pending || pending.projectId !== projectId) {
        return reply.code(404).send({ error: 'run prompt not found' });
      }
      const entry = getRun(runId);
      if (entry && entry.status !== 'pending') return reply.code(409).send({ error: 'run already started' });
      // 重启后 registry 可能丢失 entry：按 pending 重建
      if (!entry) {
        registerRun({
          id: runId,
          projectId,
          kind: 'graph',
          status: 'pending',
          createdAt: pending.createdAt,
          threadId: pending.threadId,
          turnId: pending.turnId,
        });
      }

      let graph: Graph;
      try {
        resolveProjectPath(projectId); // 运行前重检项目路径
        graph = readProjectGraph(projectId);
        validateProjectRun(projectId, graph);
      } catch (err) {
        transitionRunStatus(runId, 'error');
        removeRun(runId);
        deletePendingRun(projectId, runId);
        if (pending.threadId && pending.turnId) {
          await failTurn(projectId, pending.threadId, runId, pending.turnId, { status: 'error', reason: 'graph not runnable' });
        }
        const msg = err instanceof Error ? err.message : 'graph not runnable';
        socketManager.broadcastGraph({ type: 'run_error', runId, error: msg });
        return reply.code(400).send({ error: msg });
      }

      const { prompt, threadId, turnId, threadRevision } = pending;
      deletePendingRun(projectId, runId);
      transitionRunStatus(runId, 'running');
      const controller = registerAbort(runId);
      const regEntry = getRun(runId);
      if (regEntry) regEntry.controller = controller;
      recordRunStart(
        projectId,
        runId,
        prompt,
        graph,
        threadId ? { threadId, turnId, threadRevision } : undefined,
      );
      reply.code(202).send({ status: 'started', runId });

      setImmediate(() => {
        executeGraph(prompt, graph, {
          runId,
          projectId,
          emit: (event) => {
            socketManager.broadcastGraph(event);
            // 终态由事件决定（finally 只清理，不得覆盖 done/error/aborted）+ Thread turn 生命周期
            if (event.type === 'run_done') {
              transitionRunStatus(runId, 'done');
              if (threadId && turnId) {
                void completeTurn(projectId, threadId, runId, turnId, {
                  finalArtifact: event.finalText,
                  quality: {
                    status: 'done',
                    termination: event.termination,
                    ...(event.reason ? { reason: event.reason } : {}),
                  },
                });
              }
            } else if (event.type === 'run_error') {
              transitionRunStatus(runId, 'error');
              if (threadId && turnId) void failTurn(projectId, threadId, runId, turnId, { status: 'error', reason: event.error });
            } else if (event.type === 'run_aborted') {
              transitionRunStatus(runId, 'aborted');
              if (threadId && turnId) void failTurn(projectId, threadId, runId, turnId, { status: 'aborted' });
            }
          },
          record: (event) => {
            recordRunEvent(projectId, runId, event);
          },
          signal: controller.signal,
        })
          .catch((err) => {
            const msg = `graph execution crashed: ${(err as Error).message}`;
            socketManager.broadcastGraph({ type: 'run_error', runId, error: msg });
            transitionRunStatus(runId, 'error');
            if (threadId && turnId) void failTurn(projectId, threadId, runId, turnId, { status: 'error', reason: msg });
          })
          .finally(() => {
            unregisterAbort(runId);
            closeRunStream(projectId, runId);
          });
      });
    },
  );

  app.post<{ Params: { projectId: string; runId: string } }>(
    '/api/projects/:projectId/run/:runId/abort',
    async (request, reply) => {
      const { projectId, runId } = request.params;
      const entry = getRun(runId);
      // pending（未 start）：清 activeRunId + turn_failed aborted + 删 pending
      if (entry && entry.projectId === projectId && entry.status === 'pending') {
        if (entry.threadId && entry.turnId) await abortPendingTurn(projectId, entry.threadId, runId, entry.turnId);
        deletePendingRun(projectId, runId);
        transitionRunStatus(runId, 'aborted');
        removeRun(runId);
        socketManager.broadcastGraph({ type: 'run_aborted', runId });
        return reply.code(202).send({ status: 'aborted', runId });
      }
      // 重启后 entry 丢失但 pending 文件在：按 pending abort
      if (!entry) {
        const pending = readPendingRun(projectId, runId);
        if (pending && pending.threadId && pending.turnId) {
          await abortPendingTurn(projectId, pending.threadId, runId, pending.turnId);
          deletePendingRun(projectId, runId);
          return reply.code(202).send({ status: 'aborted', runId });
        }
        return reply.code(404).send({ error: 'run not found in this project' });
      }
      if (entry.projectId !== projectId) return reply.code(404).send({ error: 'run not found in this project' });
      // running：abort controller；emit 回调发 run_aborted → failTurn
      const ok = abortRunEntry(runId) || abortRun(runId);
      return reply.code(ok ? 202 : 404).send({ status: ok ? 'aborted' : 'not_found', runId });
    },
  );

  // ── Thread（跨轮对话）──────────────────────────────────────
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/threads', async (request) => {
    return { threads: listThreads(request.params.projectId) };
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/threads', async (request, reply) => {
    const { projectId } = request.params;
    const { title } = (request.body ?? {}) as { title?: unknown };
    try {
      readProjectMeta(projectId);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    const thread = createThread(projectId, typeof title === 'string' ? title : '新对话');
    return reply.code(201).send(thread);
  });

  app.get<{ Params: { projectId: string; threadId: string } }>(
    '/api/projects/:projectId/threads/:threadId',
    async (request, reply) => {
      const { projectId, threadId } = request.params;
      const thread = readThread(projectId, threadId);
      if (!thread) return reply.code(404).send({ error: 'thread not found' });
      return { thread, events: readThreadEvents(projectId, threadId) };
    },
  );

  app.delete<{ Params: { projectId: string; threadId: string } }>(
    '/api/projects/:projectId/threads/:threadId',
    async (request, reply) => {
      const { projectId, threadId } = request.params;
      try {
        trashThread(projectId, threadId);
        return reply.send({ status: 'ok', threadId });
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/runs', async (request) => {
    return { runs: listRuns(request.params.projectId) };
  });

  app.get<{ Params: { projectId: string; runId: string } }>(
    '/api/projects/:projectId/runs/:runId',
    async (request, reply) => {
      const { projectId, runId } = request.params;
      const data = readRun(projectId, runId);
      if (!data.meta) return reply.code(404).send({ error: 'run not found' });
      if (data.meta.projectId !== projectId) return reply.code(404).send({ error: 'run not found in this project' });
      return data;
    },
  );

  done();
};

void getProjectRoot;
void GraphValidationError;

export default projectsRoutes;
