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
import { executeGraph, runAgentNode } from '../agents/graph/AgentRouter.js';
import { resumeEvaluatorOptimizerGraph, verifyCheckpointToken, isAllowedResumeAction, type HarnessCheckpoint, type ResumeAction } from '../agents/graph/EvaluatorOptimizerRouter.js';
import { invokeAgentWithPolicy } from '../agents/invoke-agent.js';
import { buildThreadContext, buildServerContext } from '../agents/context-builder.js';
import { snapshotRubrics } from '../agents/graph/evaluation.js';
import { scaffoldV5Workspace } from '../agents/graph/v5-workspace.js';
import { listIssues, recordFinding, confirmIssue, resolveIssue, acceptIssue, reopenIssue, IssueError } from '../agents/knowledge/issue-store.js';
import { publishIssues, PublishError } from '../agents/knowledge/publish.js';
import {
  closeRunStream,
  listRuns,
  readRun,
  readPersistedRun,
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
  GraphSchema,
  GraphValidationError,
  readProjectGraph,
  validateGraph,
  validateProjectRun,
  writeProjectGraph,
  type AnyGraph,
  type AnyGraphNode,
  type Graph,
} from '../agents/graph/graph.js';
import { resolveGlob } from '../utils/glob.js';
import { getProjectRoot } from '../utils/project-root.js';
import type { PublicGraphEvent, PersistedRunEvent, SocketManager } from '../infrastructure/websocket/SocketManager.js';

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

/**
 * Knowledge 观察者：把运行事件投影为 observed finding（不确证，除非 run_error/Verifier 证据）。
 * 来源：node_error / run_error / gate 阻塞·耗尽 / evaluation blocked / run_done best_effort 遗留风险。
 * 单次 reviewer revise 只产生 observed；run 完成/abort 不自动关闭。
 */
function observeFinding(projectId: string, runId: string, event: PersistedRunEvent): void {
  switch (event.type) {
    case 'node_error':
      recordFinding(projectId, { source: { runId, nodeId: event.nodeId }, title: `节点错误: ${event.nodeId}`, detail: event.error, severity: 'warning', evidence: event.error });
      break;
    case 'run_error':
      recordFinding(projectId, { source: { runId }, title: '运行失败', detail: event.error, severity: 'blocking', evidence: event.error, confirmed: true });
      break;
    case 'gate_status':
      if (event.status === 'blocked') recordFinding(projectId, { source: { runId, gateId: event.gateId }, title: `Gate 阻塞: ${event.gateId}`, detail: `branch ${event.branchId}`, severity: 'blocking' });
      else if (event.status === 'exhausted') recordFinding(projectId, { source: { runId, gateId: event.gateId }, title: `Gate 耗尽: ${event.gateId}`, detail: `branch ${event.branchId}`, severity: 'warning' });
      break;
    case 'gate_blocked':
      recordFinding(projectId, { source: { runId, gateId: event.gateId }, title: `评估阻塞: ${event.gateId}`, detail: event.reason, severity: 'blocking', evidence: event.reason });
      break;
    case 'evaluation_done':
      if (event.evaluation.verdict === 'blocked') recordFinding(projectId, { source: { runId, gateId: event.gateId }, title: `评估阻塞: ${event.gateId}`, detail: event.evaluation.reason ?? 'blocked', severity: 'blocking' });
      break;
    case 'run_done':
      // continue_best 遗留风险：未解决 gate 各记一条 observed。
      if (event.termination === 'best_effort' && event.quality?.unresolvedGateIds) {
        for (const gid of event.quality.unresolvedGateIds) recordFinding(projectId, { source: { runId, gateId: gid }, title: `best-effort 遗留风险: ${gid}`, detail: 'continue_best 放行了未解决的 gate', severity: 'warning' });
      }
      break;
    default:
      break;
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
      // 新项目默认脚手架 V5 Project Workspace（角色节点 + 7 通道图）。既有项目/test 不自动升级。
      const scaffold = scaffoldV5Workspace(meta.id);
      return reply.code(201).send({ ...meta, scaffold });
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
    let graph: AnyGraph;
    try {
      graph = GraphSchema.parse(request.body);
      validateGraph(graph);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid graph';
      return reply.code(400).send({ error: msg });
    }
    try {
      const existing = readProjectGraph(projectId);
      if (existing.schemaVersion === 4 && graph.schemaVersion !== 4) {
        return reply.code(409).send({ error: 'refusing implicit graph schema downgrade from V4; use an explicit migration tool' });
      }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const missing: string[] = [];
    for (const node of graph.nodes) {
      if (node.type !== 'agent' && node.type !== 'decision') continue;
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
      graphNodeId?: unknown; position?: unknown; connectFrom?: unknown; nodeType?: unknown; rubricRef?: unknown;
    };
    const provider = typeof body.provider === 'string' ? body.provider : '';
    const localId = typeof body.localId === 'string' ? body.localId.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const graphNodeId = typeof body.graphNodeId === 'string' ? body.graphNodeId.trim() : '';
    if (!provider || !localId || !name || !graphNodeId) {
      return reply.code(400).send({ error: 'provider, localId, name, graphNodeId are required' });
    }
    const requestedType = body.nodeType == null ? 'agent' : body.nodeType;
    if (requestedType !== 'agent' && requestedType !== 'decision') {
      return reply.code(400).send({ error: "nodeType must be 'agent' or 'decision'" });
    }
    const rubricRef = typeof body.rubricRef === 'string' && body.rubricRef.trim() ? body.rubricRef.trim() : 'rubric.json';
    if (requestedType === 'decision' && (!/^[a-zA-Z0-9._/-]+$/.test(rubricRef) || isAbsolute(rubricRef) || rubricRef.split(/[\\/]/).includes('..'))) {
      return reply.code(400).send({ error: 'rubricRef must be a relative tail within node config' });
    }
    const meta = PROVIDERS.find((p) => p.id === provider);
    if (!meta) return reply.code(400).send({ error: `unknown provider: ${provider}` });
    if (!meta.installed) return reply.code(409).send({ error: `provider '${provider}' is disabled (not installed)` });

    const nodeKey = `${provider}:${localId}`;
    // 预校验图：graphNodeId 不存在、connectFrom 存在
    let graph: AnyGraph;
    try {
      graph = readProjectGraph(projectId);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    if (requestedType === 'decision' && graph.schemaVersion !== 4) {
      return reply.code(409).send({ error: 'decision nodes require a V4 graph' });
    }
    if (graph.nodes.some((n) => n.id === graphNodeId)) {
      return reply.code(409).send({ error: `graph node already exists: ${graphNodeId}` });
    }
    const connectFrom = typeof body.connectFrom === 'string' ? body.connectFrom.trim() : '';
    if (connectFrom && !graph.nodes.some((n) => n.id === connectFrom)) {
      return reply.code(400).send({ error: `connectFrom node not found: ${connectFrom}` });
    }
    if (graph.nodes.some((n) => (n.type === 'agent' || n.type === 'decision') && n.agentNodeKey === nodeKey)) {
      return reply.code(409).send({ error: `node instance already in graph: ${nodeKey}` });
    }

    // 1. 实例化（建实例目录）
    try {
      const instance = instantiateNodeInstance(projectId, nodeKey, {
        name,
        command: meta.command,
        memoryHome: meta.memoryHome,
        ...(typeof body.model === 'string' && body.model.trim() ? { model: body.model.trim() } : meta.defaultModel ? { model: meta.defaultModel } : {}),
        ...(typeof body.identity === 'string' ? { identity: body.identity } : {}),
      });
      if (requestedType === 'decision') {
        const rubricFile = join(instance.nodeDir, 'config', rubricRef);
        if (!existsSync(rubricFile)) {
          mkdirSync(dirname(rubricFile), { recursive: true });
          writeFileSync(rubricFile, JSON.stringify({ schemaVersion: 1, name: `${name} rubric`, criteria: [{ id: 'correctness', description: '产物正确、完整并满足原始需求', required: true, weight: 1 }] }, null, 2) + '\n', 'utf-8');
        }
      }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    // 2. 改图（加节点 + 可选边）。失败 → 回滚实例目录。
    const position = (body.position && typeof body.position === 'object' ? body.position : { x: 320, y: 80 + graph.nodes.length * 140 }) as { x: number; y: number };
    const newAgentNode = (requestedType === 'decision'
      ? { id: graphNodeId, type: 'decision', agentNodeKey: nodeKey, rubricRef, position }
      : { id: graphNodeId, type: 'agent', agentNodeKey: nodeKey, position }) as AnyGraphNode;
    const newNodes = [...graph.nodes, newAgentNode];
    const newEdges = connectFrom
      ? [...graph.edges, graph.schemaVersion === 4
          ? { id: `${connectFrom}->${graphNodeId}`, source: connectFrom, target: graphNodeId, kind: requestedType === 'decision' ? 'gate' : 'forward', ...(requestedType === 'decision' ? { order: 1, maxRevisions: 1, onExhausted: 'ask_user', onBlocked: 'ask_user' } : {}) }
          : { id: `${connectFrom}->${graphNodeId}`, source: connectFrom, target: graphNodeId }]
      : graph.edges;
    const newGraph = { ...graph, nodes: newNodes, edges: newEdges } as AnyGraph;
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
      let graph: AnyGraph;
      try {
        graph = readProjectGraph(projectId);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const target = graph.nodes.find((n) => n.id === graphNodeId);
      if (!target || target.type !== 'agent') return reply.code(404).send({ error: `agent graph node not found: ${graphNodeId}` });
      const nodeKey = target.agentNodeKey;
      const newGraph = {
        ...graph,
        nodes: graph.nodes.filter((n) => n.id !== graphNodeId),
        edges: graph.edges.filter((e) => e.source !== graphNodeId && e.target !== graphNodeId),
      } as AnyGraph;
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
      let graph: AnyGraph;
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
      runMode?: unknown;
      gatePolicyOverrides?: unknown;
    };
    const message =
      typeof body.message === 'string' ? body.message : typeof body.prompt === 'string' ? body.prompt : '';
    if (message.trim().length === 0) return reply.code(400).send({ error: 'message is required' });
    // 旧客户端不传时保持 full；quick 属 Step 5 RunEntry，当前明确拒绝，避免伪实现。
    const runMode = body.runMode == null ? 'full' : body.runMode;
    if (runMode !== 'auto' && runMode !== 'full' && runMode !== 'quick') {
      return reply.code(400).send({ error: 'runMode must be auto, full, or quick' });
    }
    if (runMode === 'quick') return reply.code(409).send({ error: 'quick mode is not available yet' });
    const gatePolicyOverrides: Record<string, 'ask_user' | 'continue_best' | 'fail'> = {};
    if (body.gatePolicyOverrides != null) {
      if (typeof body.gatePolicyOverrides !== 'object' || Array.isArray(body.gatePolicyOverrides)) return reply.code(400).send({ error: 'gatePolicyOverrides must be an object' });
      for (const [gateId, policy] of Object.entries(body.gatePolicyOverrides as Record<string, unknown>)) {
        if (policy !== 'ask_user' && policy !== 'continue_best' && policy !== 'fail') return reply.code(400).send({ error: `invalid gate policy for ${gateId}` });
        gatePolicyOverrides[gateId] = policy;
      }
    }
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
        runMode,
        ...(Object.keys(gatePolicyOverrides).length ? { gatePolicyOverrides } : {}),
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
      return reply.code(202).send({ status: 'created', runId, threadId, turnId: turn.turnId, threadRevision: turn.revision });
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

      let graph: AnyGraph;
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

      const { prompt, threadId, turnId, threadRevision, runMode = 'full', gatePolicyOverrides = {} } = pending;
      if (graph.schemaVersion === 4) {
        const gateIds = new Set(graph.edges.filter((e) => e.kind === 'gate').map((e) => e.id));
        const unknown = Object.keys(gatePolicyOverrides).find((id) => !gateIds.has(id));
        if (unknown) {
          await failTurn(projectId, threadId, runId, turnId, { status: 'error', reason: `unknown gate override '${unknown}'` });
          deletePendingRun(projectId, runId); transitionRunStatus(runId, 'error');
          return reply.code(400).send({ error: `gatePolicyOverrides references unknown gate '${unknown}'` });
        }
      } else if (Object.keys(gatePolicyOverrides).length) {
        await failTurn(projectId, threadId, runId, turnId, { status: 'error', reason: 'gate overrides require V4' });
        deletePendingRun(projectId, runId); transitionRunStatus(runId, 'error');
        return reply.code(400).send({ error: 'gatePolicyOverrides require a V4 graph' });
      }
      deletePendingRun(projectId, runId);
      transitionRunStatus(runId, 'running');
      const controller = registerAbort(runId);
      const regEntry = getRun(runId);
      if (regEntry) regEntry.controller = controller;
      // Step 3: 构造 Thread 跨轮上下文前缀（serverContext + 历史 turns）注入每个节点 prompt；快照入 run_meta
      const local = readProjectLocal(projectId);
      const serverContext = buildServerContext(local?.location);
      const { prefix: contextPrefix, snapshot: contextSnapshot } = buildThreadContext(projectId, threadId, { serverContext });
      const rubrics = (graph.schemaVersion === 4 || graph.schemaVersion === 5) ? snapshotRubrics(projectId, graph) : undefined;
      recordRunStart(
        projectId,
        runId,
        prompt,
        graph,
        { threadId, turnId, threadRevision },
        contextSnapshot,
        runMode,
        rubrics,
        gatePolicyOverrides,
      );
      reply.code(202).send({ status: 'started', runId });

      setImmediate(() => {
        let terminalEvent: Extract<PublicGraphEvent, { type: 'run_done' | 'run_error' | 'run_aborted' }> | null = null;
        executeGraph(prompt, graph, {
          runId,
          projectId,
          contextPrefix,
          runMode,
          gatePolicyOverrides,
          rubrics,
          emit: (event) => {
            socketManager.broadcastGraph(event);
            // 先广播图终态；Thread durable commit 在 executeGraph resolve 后顺序执行。
            if (event.type === 'run_done') {
              terminalEvent = event;
            } else if (event.type === 'run_error') {
              terminalEvent = event;
            } else if (event.type === 'run_aborted') {
              terminalEvent = event;
            } else if (event.type === 'run_paused') {
              transitionRunStatus(runId, 'paused');
            }
          },
          record: (event) => {
            recordRunEvent(projectId, runId, event);
            observeFinding(projectId, runId, event);
          },
          signal: controller.signal,
        }).then(async () => {
            if (!terminalEvent) return;
            const terminal: Extract<PublicGraphEvent, { type: 'run_done' | 'run_error' | 'run_aborted' }> = terminalEvent;
            const updated = terminal.type === 'run_done'
              ? await completeTurn(projectId, threadId, runId, turnId, {
                  finalArtifact: terminal.finalText,
                  quality: {
                    status: 'done', termination: terminal.termination,
                    ...(terminal.reason ? { reason: terminal.reason } : {}),
                    ...(terminal.quality ? {
                      runQualityStatus: terminal.quality.status,
                      exhausted: terminal.quality.exhausted,
                      ...(terminal.quality.bestCandidateId ? { bestCandidateId: terminal.quality.bestCandidateId } : {}),
                      ...(terminal.quality.unresolvedGateIds.length ? { unresolvedGateIds: terminal.quality.unresolvedGateIds } : {}),
                    } : {}),
                  },
                })
              : await failTurn(projectId, threadId, runId, turnId, {
                  status: terminal.type === 'run_aborted' ? 'aborted' : 'error',
                  ...(terminal.type === 'run_error' ? { reason: terminal.error } : {}),
                });
            transitionRunStatus(runId, terminal.type === 'run_done' ? 'done' : terminal.type === 'run_aborted' ? 'aborted' : 'error');
            if (updated) {
              const committed = {
                type: 'thread_committed', runId, threadId, turnId, revision: updated.revision,
                status: terminal.type === 'run_done' ? 'completed' : 'failed',
              } as const;
              recordRunEvent(projectId, runId, committed);
              socketManager.broadcastGraph(committed);
            }
          })
          .catch((err) => {
            const msg = `graph execution crashed: ${(err as Error).message}`;
            socketManager.broadcastGraph({ type: 'run_error', runId, error: msg });
            transitionRunStatus(runId, 'error');
            return failTurn(projectId, threadId, runId, turnId, { status: 'error', reason: msg });
          })
          .finally(() => {
            unregisterAbort(runId);
            closeRunStream(projectId, runId);
          });
      });
    },
  );

  app.post<{ Params: { projectId: string; runId: string } }>(
    '/api/projects/:projectId/run/:runId/resume',
    async (request, reply) => {
      const { projectId, runId } = request.params;
      const body = (request.body ?? {}) as { branchId?: unknown; resumeToken?: unknown; action?: unknown };
      if (typeof body.branchId !== 'string' || typeof body.resumeToken !== 'string' || !['continue_best', 'revise_once', 'fail'].includes(String(body.action))) {
        return reply.code(400).send({ error: 'branchId, resumeToken and valid action are required' });
      }
      const persisted = readPersistedRun(projectId, runId);
      if (!persisted.meta || persisted.meta.graph.schemaVersion !== 4) return reply.code(404).send({ error: 'paused V4 run not found' });
      const checkpointEvent = [...persisted.events].reverse().find((event) => event.type === 'branch_checkpoint' && event.branchId === body.branchId);
      if (!checkpointEvent || checkpointEvent.type !== 'branch_checkpoint') return reply.code(404).send({ error: 'branch checkpoint not found' });
      const checkpoint = checkpointEvent.payload as HarnessCheckpoint;
      // V4.2: 校验 action ∈ checkpoint.allowedActions（无 best 时禁止 continue_best），在消费 token 之前。
      if (!isAllowedResumeAction(checkpoint, String(body.action))) {
        const reason = `action '${String(body.action)}' is not allowed for this checkpoint; allowed: ${(checkpoint.allowedActions ?? (['continue_best', 'revise_once', 'fail'] as ResumeAction[])).join(', ')}`;
        const ev = { type: 'resume_rejected', runId, branchId: body.branchId, reason, timestamp: Date.now() } as const;
        recordRunEvent(projectId, runId, ev); socketManager.broadcastGraph(ev);
        return reply.code(409).send({ error: reason });
      }
      const consumed = persisted.events.some((event) => event.type === 'run_state' && event.phase === 'resume_token_consumed' && (event.payload as { tokenHash?: unknown })?.tokenHash === checkpoint.tokenHash);
      if (consumed || !verifyCheckpointToken(checkpoint, body.resumeToken)) {
        const ev = { type: 'resume_rejected', runId, branchId: body.branchId, reason: 'resume token is invalid, expired, or already used', timestamp: Date.now() } as const;
        recordRunEvent(projectId, runId, ev); socketManager.broadcastGraph(ev);
        return reply.code(409).send({ error: 'resume token is invalid, expired, or already used' });
      }
      const entry = getRun(runId);
      if (entry && entry.status !== 'paused') return reply.code(409).send({ error: `run is not paused (status=${entry.status})` });
      const threadId = persisted.meta.threadId;
      const turnId = persisted.meta.turnId;
      if (!threadId || !turnId) return reply.code(409).send({ error: 'paused run has no Thread checkpoint' });
      if (!readThread(projectId, threadId)) return reply.code(409).send({ error: 'paused run Thread no longer exists' });
      if (!entry) registerRun({ id: runId, projectId, kind: 'graph', status: 'paused', createdAt: persisted.meta.createdAt, threadId, turnId });
      recordRunEvent(projectId, runId, { type: 'run_state', runId, phase: 'resume_token_consumed', payload: { tokenHash: checkpoint.tokenHash, branchId: body.branchId, consumedAt: Date.now() } });
      transitionRunStatus(runId, 'running');
      const controller = registerAbort(runId);
      const registered = getRun(runId); if (registered) registered.controller = controller;
      const local = readProjectLocal(projectId);
      const { prefix: contextPrefix } = buildThreadContext(projectId, threadId, { serverContext: buildServerContext(local?.location) });
      reply.code(202).send({ status: 'resuming', runId, branchId: body.branchId });
      setImmediate(() => {
        let terminal: Extract<PublicGraphEvent, { type: 'run_done' | 'run_error' | 'run_aborted' }> | null = null;
        resumeEvaluatorOptimizerGraph(persisted.meta!.prompt, persisted.meta!.graph as Extract<AnyGraph, { schemaVersion: 4 }>, {
          runId, projectId, contextPrefix, runMode: persisted.meta!.runMode, gatePolicyOverrides: persisted.meta!.gatePolicyOverrides, rubrics: persisted.meta!.rubrics,
          signal: controller.signal,
          emit: (event) => { socketManager.broadcastGraph(event); if (event.type === 'run_done' || event.type === 'run_error' || event.type === 'run_aborted') terminal = event; else if (event.type === 'run_paused') transitionRunStatus(runId, 'paused'); },
          record: (event) => { recordRunEvent(projectId, runId, event); observeFinding(projectId, runId, event); },
        }, checkpoint, body.action as 'continue_best' | 'revise_once' | 'fail', runAgentNode).then(async () => {
          if (!terminal) return;
          const event: Extract<PublicGraphEvent, { type: 'run_done' | 'run_error' | 'run_aborted' }> = terminal;
          const updated = event.type === 'run_done'
            ? await completeTurn(projectId, threadId, runId, turnId, { finalArtifact: event.finalText, quality: { status: 'done', termination: event.termination, ...(event.reason ? { reason: event.reason } : {}), ...(event.quality ? { runQualityStatus: event.quality.status, exhausted: event.quality.exhausted, ...(event.quality.bestCandidateId ? { bestCandidateId: event.quality.bestCandidateId } : {}), ...(event.quality.unresolvedGateIds.length ? { unresolvedGateIds: event.quality.unresolvedGateIds } : {}) } : {}) } })
            : await failTurn(projectId, threadId, runId, turnId, { status: event.type === 'run_aborted' ? 'aborted' : 'error', ...(event.type === 'run_error' ? { reason: event.error } : {}) });
          transitionRunStatus(runId, event.type === 'run_done' ? 'done' : event.type === 'run_aborted' ? 'aborted' : 'error');
          if (updated) {
            const committed = { type: 'thread_committed', runId, threadId, turnId, revision: updated.revision, status: event.type === 'run_done' ? 'completed' : 'failed' } as const;
            recordRunEvent(projectId, runId, committed); socketManager.broadcastGraph(committed);
          }
        }).catch(async (error) => {
          const message = `resume crashed: ${(error as Error).message}`;
          const event = { type: 'run_error', runId, error: message } as const;
          recordRunEvent(projectId, runId, event); socketManager.broadcastGraph(event); transitionRunStatus(runId, 'error');
          await failTurn(projectId, threadId, runId, turnId, { status: 'error', reason: message });
        }).finally(() => { unregisterAbort(runId); closeRunStream(projectId, runId); });
      });
    },
  );

  // ── Project Knowledge: issues 账本 ─────────────────────────────
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/issues', async (request) => {
    return { issues: listIssues(request.params.projectId) };
  });

  app.post<{ Params: { projectId: string; issueId: string } }>('/api/projects/:projectId/issues/:issueId/confirm', async (request, reply) => {
    try { return confirmIssue(request.params.projectId, request.params.issueId); } catch (err) { return reply.code(409).send({ error: (err as Error).message }); }
  });
  app.post<{ Params: { projectId: string; issueId: string } }>('/api/projects/:projectId/issues/:issueId/resolve', async (request, reply) => {
    try { return resolveIssue(request.params.projectId, request.params.issueId); } catch (err) { return reply.code(409).send({ error: (err as Error).message }); }
  });
  app.post<{ Params: { projectId: string; issueId: string } }>('/api/projects/:projectId/issues/:issueId/accept', async (request, reply) => {
    try { return acceptIssue(request.params.projectId, request.params.issueId); } catch (err) { return reply.code(409).send({ error: (err as Error).message }); }
  });
  app.post<{ Params: { projectId: string; issueId: string } }>('/api/projects/:projectId/issues/:issueId/reopen', async (request, reply) => {
    try { return reopenIssue(request.params.projectId, request.params.issueId); } catch (err) { return reply.code(409).send({ error: (err as Error).message }); }
  });
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/issues/publish', async (request, reply) => {
    try { return publishIssues(request.params.projectId); } catch (err) {
      const code = err instanceof PublishError ? 409 : 400;
      return reply.code(code).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { projectId: string; runId: string } }>(
    '/api/projects/:projectId/run/:runId/abort',
    async (request, reply) => {
      const { projectId, runId } = request.params;
      const entry = getRun(runId);
      if (entry && entry.projectId === projectId && entry.status === 'paused') {
        if (entry.threadId && entry.turnId) await failTurn(projectId, entry.threadId, runId, entry.turnId, { status: 'aborted', reason: 'paused run discarded' });
        transitionRunStatus(runId, 'aborted');
        const event = { type: 'run_aborted', runId } as const;
        recordRunEvent(projectId, runId, event); socketManager.broadcastGraph(event); closeRunStream(projectId, runId);
        return reply.code(202).send({ status: 'aborted', runId });
      }
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
