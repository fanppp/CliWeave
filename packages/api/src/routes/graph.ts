/**
 * Graph 路由
 * - GET  /api/graph           返回当前图（M1 默认图；graph.json 存在则解析校验，非法回 400）。
 * - POST /api/graph/run       创建运行（不执行），返回 runId。前端拿到 runId → join_graph → 再调 start。
 * - POST /api/graph/run/:id/start  开始执行（后台 setImmediate），流式经 WS graph_message 推送。
 *
 * 审核修正 #1：两步执行消除"POST 后 setImmediate 广播早于前端 join room"的丢消息窗口。
 * 审核修正 #9：M1 不开放 PUT（随 M2 画布 + 原子写入一起上）。
 */
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { executeGraph } from '../agents/graph/AgentRouter.js';
import { GraphSchema, GraphValidationError, readGraph, validateGraph, writeGraph } from '../agents/graph/graph.js';
import type { Graph } from '../agents/graph/graph.js';
import { closeRunStream, listRuns, readRun, recordRunEvent, recordRunStart } from '../agents/graph/graph-run-store.js';
import { readNodeDescriptor } from '../agents/NodeDescriptor.js';
import { abortRun, registerAbort, unregisterAbort } from '../agents/abort-registry.js';
import type { SocketManager } from '../infrastructure/websocket/SocketManager.js';

export interface GraphRouteOptions {
  socketManager: SocketManager;
}

interface PendingRun {
  prompt: string;
  createdAt: number;
  started: boolean;
}

const pendingRuns = new Map<string, PendingRun>();

const graphRoutes: FastifyPluginCallback<GraphRouteOptions> = (app, options, done) => {
  const { socketManager } = options;

  app.get('/api/graph', async (_request, reply) => {
    try {
      const graph = readGraph();
      return reply.send(graph);
    } catch (err) {
      if (err instanceof GraphValidationError || err instanceof Error) {
        return reply.code(400).send({ error: err.message });
      }
      return reply.code(500).send({ error: 'failed to read graph' });
    }
  });

  // 全量替换图（M2.4）。单用户单 tab：前端权威本地状态 + last-write-wins。
  // 校验顺序：schema → 结构(validateGraph) → agentNodeKey 存在(readNodeDescriptor) → 原子写。
  app.put('/api/graph', async (request, reply) => {
    let graph: Graph;
    try {
      graph = GraphSchema.parse(request.body);
      validateGraph(graph);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid graph';
      return reply.code(400).send({ error: msg });
    }
    // agentNodeKey 存在校验（审核#14：逐个 try/catch 聚合缺失节点一次返回）
    const missing: string[] = [];
    for (const node of graph.nodes) {
      if (node.type !== 'agent') continue;
      try {
        readNodeDescriptor(node.agentNodeKey);
      } catch {
        missing.push(node.agentNodeKey);
      }
    }
    if (missing.length > 0) {
      return reply.code(400).send({ error: `agent nodes not found: ${missing.join(', ')}` });
    }
    try {
      writeGraph(graph);
      return reply.code(200).send({ status: 'ok' });
    } catch (err) {
      return reply.code(500).send({ error: `write graph failed: ${(err as Error).message}` });
    }
  });

  // 步骤 1：创建运行，不执行。前端拿到 runId 后先 join_graph(room)。
  app.post('/api/graph/run', async (request, reply) => {
    const body = (request.body ?? {}) as { prompt?: unknown };
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (prompt.trim().length === 0) {
      return reply.code(400).send({ error: 'prompt is required' });
    }
    const runId = crypto.randomUUID();
    pendingRuns.set(runId, { prompt, createdAt: Date.now(), started: false });
    return reply.code(202).send({ status: 'created', runId });
  });

  // 步骤 2：前端已 join graph:<runId> 后调用，开始执行。
  app.post<{ Params: { runId: string } }>(
    '/api/graph/run/:runId/start',
    async (request, reply) => {
      const { runId } = request.params;
      const pending = pendingRuns.get(runId);
      if (!pending) return reply.code(404).send({ error: 'run not found' });
      if (pending.started) return reply.code(409).send({ error: 'run already started' });
      pending.started = true;

      let graph;
      try {
        graph = readGraph();
      } catch (err) {
        pendingRuns.delete(runId);
        const msg = err instanceof Error ? err.message : 'failed to read graph';
        socketManager.broadcastGraph({ type: 'run_error', runId, error: msg });
        return reply.code(400).send({ error: msg });
      }

      const prompt = pending.prompt;
      // 启动后即可清理 pending（已 started 标记防重复）
      pendingRuns.delete(runId);

      const controller = registerAbort(runId);
      recordRunStart(runId, prompt, graph);

      // 先回 202，流式回复走 WebSocket
      reply.code(202).send({ status: 'started', runId });

      setImmediate(() => {
        executeGraph(prompt, graph, {
          runId,
          emit: (event) => {
            socketManager.broadcastGraph(event);
            recordRunEvent(runId, event); // 异步 WriteStream 落盘（审核#3）
          },
          signal: controller.signal,
        })
          .catch((err) => {
            socketManager.broadcastGraph({
              type: 'run_error',
              runId,
              error: `graph execution crashed: ${(err as Error).message}`,
            });
          })
          .finally(() => {
            unregisterAbort(runId);
            closeRunStream(runId);
          });
      });
    },
  );

  // 图运行历史：列表 + 重放
  app.get('/api/graph/runs', async (_request, reply) => {
    try {
      return reply.send({ runs: listRuns() });
    } catch {
      return reply.code(500).send({ error: 'failed to list runs' });
    }
  });

  app.get<{ Params: { runId: string } }>('/api/graph/runs/:runId', async (request, reply) => {
    const { runId } = request.params;
    const data = readRun(runId);
    if (!data.meta) return reply.code(404).send({ error: 'run not found' });
    return reply.send(data);
  });

  // 中止图运行
  app.post<{ Params: { runId: string } }>(
    '/api/graph/run/:runId/abort',
    async (request, reply) => {
      const { runId } = request.params;
      const ok = abortRun(runId);
      return reply.code(ok ? 202 : 404).send({ status: ok ? 'aborted' : 'not_found', runId });
    },
  );

  done();
};

export default graphRoutes;
