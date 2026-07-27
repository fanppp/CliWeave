/**
 * AgentRouter —— 图运行时
 * 从 input 节点起按拓扑序串行执行 agent 节点；上游最终输出（过滤 [notice]）+ 原始需求作为下游 prompt。
 *
 * 审核修正：
 * - #2 per-node mutex：每个 agent 调用包 withNodeLock，与 /api/messages 共用，防同节点并发破坏 session。
 * - #3 session_init 持久化：收到 session_init → setActiveSession（不广播），下次可 resume。
 * - #4 Graph envelope：对外只发 node_started/node_message/node_done/node_error/run_done/run_error，
 *   provider 的 bare done 不外透。
 * - #6 fail-fast：节点抛错或 yield type:'error' 或无有效 text → node_error + run_error，停下游。
 * - #7 notice 过滤：聚合 text 时排除 `[notice]` 前缀（codex 非致命警告），取最后一条有效 text 作为下游输入。
 *
 * 两步执行（#1）由 routes/graph.ts 编排：POST /run 创建 runId，前端 join_graph 后 POST /run/:id/start 才调用本函数。
 */
import { buildAgent, getActiveSession, setActiveSession } from '../AgentServiceFactory.js';
import { withNodeLock } from '../node-mutex.js';
import type { Graph, GraphNode } from './graph.js';
import type { AgentMessage } from '../types.js';
import type { GraphEvent } from '../../infrastructure/websocket/SocketManager.js';

export interface ExecuteOptions {
  runId: string;
  /** 广播回调（通常绑 socketManager.broadcastGraph）。 */
  emit: (event: GraphEvent) => void;
  /** 用户中止信号；节点间与 invoke 内部据此停止。 */
  signal?: AbortSignal;
}

interface RunOutcome {
  status: 'ok' | 'error' | 'aborted';
  finalText?: string;
  error?: string;
}

/** 拓扑序（Kahn），跳过 input 节点本身。M1 入度 ≤ 1 → 本质是链/树，串行执行即可。 */
function topoOrder(graph: Graph): GraphNode[] {
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) {
    inDeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of graph.edges) {
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
    adj.get(e.source)!.push(e.target);
  }
  const queue: string[] = [graph.inputNode];
  const order: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const next of adj.get(cur) ?? []) {
      const d = (inDeg.get(next) ?? 1) - 1;
      inDeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  return order.filter((id) => id !== graph.inputNode).map((id) => byId.get(id)!);
}

function ts(): number {
  return Date.now();
}

/** 执行单个 agent 节点：持锁 → invoke → 聚合最终 text。 */
async function runAgentNode(
  node: Extract<GraphNode, { type: 'agent' }>,
  nodePrompt: string,
  opts: ExecuteOptions,
): Promise<RunOutcome> {
  const { runId, emit, signal } = opts;
  try {
    return await withNodeLock(node.agentNodeKey, async () => {
      if (signal?.aborted) return { status: 'aborted' } satisfies RunOutcome;
      emit({ type: 'node_started', runId, nodeId: node.id });
      const { descriptor, service } = await buildAgent(node.agentNodeKey);
      const sessionId = getActiveSession(descriptor);
      const texts: string[] = [];

      for await (const msg of service.invoke(nodePrompt, {
        sessionId,
        workingDirectory: descriptor.cli.cwd,
        invocationId: runId,
        ...(signal ? { signal } : {}),
      })) {
        if (msg.type === 'session_init') {
          setActiveSession(descriptor, msg.sessionId);
          continue;
        }
        if (msg.type === 'done') continue; // 用 node_done 取代
        if (msg.type === 'error') {
          emit({ type: 'node_message', runId, nodeId: node.id, message: msg });
          emit({ type: 'node_error', runId, nodeId: node.id, error: msg.error });
          return { status: 'error', error: msg.error } satisfies RunOutcome;
        }
        // 聚合有效 text（排除 codex [notice] 非致命警告）
        if (msg.type === 'text' && !msg.content.startsWith('[notice]')) texts.push(msg.content);
        emit({ type: 'node_message', runId, nodeId: node.id, message: msg });
      }

      // 用户中止：CLI 被 signal 杀掉，流正常结束但无完整输出
      if (signal?.aborted) return { status: 'aborted' } satisfies RunOutcome;

      const finalText = texts.at(-1) ?? '';
      if (!finalText) {
        const error = `node '${node.id}' produced no valid text output`;
        emit({ type: 'node_error', runId, nodeId: node.id, error });
        return { status: 'error', error } satisfies RunOutcome;
      }
      emit({ type: 'node_done', runId, nodeId: node.id });
      return { status: 'ok', finalText } satisfies RunOutcome;
    });
  } catch (err) {
    const error = (err as Error).message;
    emit({ type: 'node_error', runId, nodeId: node.id, error });
    return { status: 'error', error };
  }
}

/**
 * 执行整张图。input 节点为伪节点：不调 CLI，直接以 prompt 作为输出分发给下游。
 * 首个 agent（前驱=input）prompt = 原始 prompt；其余 agent prompt = 原始需求 + 前驱最终输出。
 */
export async function executeGraph(prompt: string, graph: Graph, opts: ExecuteOptions): Promise<void> {
  const { runId, emit, signal } = opts;
  const inputNode = graph.nodes.find((n) => n.id === graph.inputNode);
  if (!inputNode || inputNode.type !== 'input') {
    emit({ type: 'run_error', runId, error: 'invalid graph: input node missing' });
    return;
  }

  // 伪 input 节点：分发 prompt
  emit({ type: 'node_started', runId, nodeId: inputNode.id });
  const inputMsg: AgentMessage = { type: 'text', nodeId: inputNode.id, content: prompt, timestamp: ts() };
  emit({ type: 'node_message', runId, nodeId: inputNode.id, message: inputMsg });
  emit({ type: 'node_done', runId, nodeId: inputNode.id });

  const output = new Map<string, string>();
  output.set(inputNode.id, prompt);

  for (const node of topoOrder(graph)) {
    if (node.type !== 'agent') continue;
    // 节点之间检查中止
    if (signal?.aborted) {
      emit({ type: 'run_aborted', runId });
      return;
    }
    const inEdge = graph.edges.find((e) => e.target === node.id);
    const predId = inEdge?.source;
    const predOutput = predId ? output.get(predId) : undefined;

    let nodePrompt: string;
    if (predId === inputNode.id) {
      // 紧接 input：原始需求，无上游输出包装
      nodePrompt = prompt;
    } else {
      nodePrompt =
        `【原始需求】${prompt}\n\n` +
        `【上一节点 ${predId} 的输出】${predOutput ?? '(无)'}\n\n` +
        `请基于以上继续。`;
    }

    const result = await runAgentNode(node, nodePrompt, opts);
    if (result.status === 'aborted') {
      emit({ type: 'run_aborted', runId });
      return;
    }
    if (result.status === 'error') {
      emit({ type: 'run_error', runId, error: `node '${node.id}' failed: ${result.error}` });
      return; // fail-fast
    }
    output.set(node.id, result.finalText!);
  }

  emit({ type: 'run_done', runId });
}
