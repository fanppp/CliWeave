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
import {
  closeRunStream,
  listRuns,
  readRun,
  recordRunEvent,
  recordRunStart,
} from '../agents/graph/graph-run-store.js';
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

/** 项目图运行的待启动 prompt（runId → {prompt, projectId}），start 时取走。 */
const pendingPrompts = new Map<string, { prompt: string; projectId: string; createdAt: number }>();

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
    try {
      const meta = createProject(name, path);
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
    return { nodes: listProjectNodeInstances(request.params.projectId) };
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
            const sessionId = getActiveSessionCtx(ctx);
            socketManager.broadcast(
              { type: 'system_info', nodeId: nodeKey, content: JSON.stringify({ type: 'invoking', invocationId, resume: !!sessionId }), timestamp: Date.now() },
              instanceKey,
            );
            for await (const msg of service.invoke(text, {
              sessionId,
              workingDirectory: ctx.projectPath,
              invocationId,
              signal: controller.signal,
            })) {
              if (msg.type === 'session_init') {
                setActiveSessionCtx(ctx, msg.sessionId);
                continue;
              }
              socketManager.broadcast(msg, instanceKey);
            }
            if (aborted) {
              socketManager.broadcast({ type: 'system_info', nodeId: nodeKey, content: '已中止', timestamp: Date.now() }, instanceKey);
              socketManager.broadcast({ type: 'done', nodeId: nodeKey, timestamp: Date.now() }, instanceKey);
            }
          });
          transitionRunStatus(invocationId, 'done');
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
    const body = (request.body ?? {}) as { prompt?: unknown };
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (prompt.trim().length === 0) return reply.code(400).send({ error: 'prompt is required' });
    try {
      readProjectMeta(projectId);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
    const runId = crypto.randomUUID();
    pendingPrompts.set(runId, { prompt, projectId, createdAt: Date.now() });
    registerRun({ id: runId, projectId, kind: 'graph', status: 'pending', createdAt: Date.now() });
    return reply.code(202).send({ status: 'created', runId });
  });

  app.post<{ Params: { projectId: string; runId: string } }>(
    '/api/projects/:projectId/run/:runId/start',
    async (request, reply) => {
      const { projectId, runId } = request.params;
      const entry = getRun(runId);
      if (!entry || entry.projectId !== projectId) return reply.code(404).send({ error: 'run not found in this project' });
      if (entry.status !== 'pending') return reply.code(409).send({ error: 'run already started' });
      const pending = pendingPrompts.get(runId);
      if (!pending || pending.projectId !== projectId) return reply.code(404).send({ error: 'run prompt not found' });

      let graph: Graph;
      try {
        resolveProjectPath(projectId); // 运行前重检项目路径
        graph = readProjectGraph(projectId);
        validateProjectRun(projectId, graph);
      } catch (err) {
        transitionRunStatus(runId, 'error');
        removeRun(runId);
        pendingPrompts.delete(runId);
        const msg = err instanceof Error ? err.message : 'graph not runnable';
        socketManager.broadcastGraph({ type: 'run_error', runId, error: msg });
        return reply.code(400).send({ error: msg });
      }

      const prompt = pending.prompt;
      pendingPrompts.delete(runId);
      transitionRunStatus(runId, 'running');
      const controller = registerAbort(runId);
      entry.controller = controller;
      recordRunStart(projectId, runId, prompt, graph);
      reply.code(202).send({ status: 'started', runId });

      setImmediate(() => {
        executeGraph(prompt, graph, {
          runId,
          projectId,
          emit: (event) => {
            socketManager.broadcastGraph(event);
          },
          record: (event) => {
            recordRunEvent(projectId, runId, event);
          },
          signal: controller.signal,
        })
          .catch((err) => {
            socketManager.broadcastGraph({ type: 'run_error', runId, error: `graph execution crashed: ${(err as Error).message}` });
          })
          .finally(() => {
            unregisterAbort(runId);
            transitionRunStatus(runId, 'done');
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
      if (!entry || entry.projectId !== projectId) return reply.code(404).send({ error: 'run not found in this project' });
      const ok = abortRunEntry(runId) || abortRun(runId);
      return reply.code(ok ? 202 : 404).send({ status: ok ? 'aborted' : 'not_found', runId });
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
