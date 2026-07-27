/**
 * AgentRouter —— 图运行时（M4a-simplified：纯方向驱动）
 *
 * 回边（target 能经其它边回到 source）= "不满足→回到 target"；前向边 = "满足→继续/结束"。
 * 决策点（有回边出边）自动 emit verdict（满意/不满意）；满意→前向边，不满意→回边（maxIterations ?? 3）。
 * 单路径：每节点 ≤1 前向 + ≤1 回边。fan-out 留 M4b。
 *
 * 终态（finish guard 各最多一次）：
 * - 到 endNode / 无前向边 → run_done(completed, finalText=各分支最后生产者产出拼接||最后完成输出)。
 * - 回边覆盖次数达 maxIterations（默认1）→ run_done(edge_limit, 最后生产者产出)；无生产者输出 → run_error。
 * - 决策点未取到 verdict → 当不满意（走回边，靠 maxIter 兜底）。
 */
import { buildAgent, getActiveSession, setActiveSession } from '../AgentServiceFactory.js';
import { withNodeLock } from '../node-mutex.js';
import { computeBackEdges, DEFAULT_BACK_EDGE_MAX_ITER, type Graph, type GraphAgentNode, type GraphEdge } from './graph.js';
import { extractVerdict, type TrailEntry, type Verdict, type VerdictContext } from './verdict.js';
import type { AgentMessage } from '../types.js';
import type { GraphEvent } from '../../infrastructure/websocket/SocketManager.js';

export interface ExecuteOptions {
  runId: string;
  emit: (event: GraphEvent) => void;
  signal?: AbortSignal;
}

interface NodeOutcome {
  status: 'ok' | 'error' | 'aborted';
  finalText?: string;
  error?: string;
}

export type ExecNode = (node: GraphAgentNode, prompt: string, opts: ExecuteOptions) => Promise<NodeOutcome>;

function ts(): number {
  return Date.now();
}

/** 真实执行单个 agent 节点。 */
export async function runAgentNode(node: GraphAgentNode, nodePrompt: string, opts: ExecuteOptions): Promise<NodeOutcome> {
  const { runId, emit, signal } = opts;
  try {
    return await withNodeLock(node.agentNodeKey, async () => {
      if (signal?.aborted) return { status: 'aborted' } satisfies NodeOutcome;
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
        if (msg.type === 'done') continue;
        if (msg.type === 'error') {
          emit({ type: 'node_message', runId, nodeId: node.id, message: msg });
          emit({ type: 'node_error', runId, nodeId: node.id, error: msg.error });
          return { status: 'error', error: msg.error } satisfies NodeOutcome;
        }
        if (msg.type === 'text' && !msg.content.startsWith('[notice]')) texts.push(msg.content);
        emit({ type: 'node_message', runId, nodeId: node.id, message: msg });
      }
      if (signal?.aborted) return { status: 'aborted' } satisfies NodeOutcome;

      const finalText = texts.at(-1) ?? '';
      if (!finalText) {
        const error = `node '${node.id}' produced no valid text output`;
        emit({ type: 'node_error', runId, nodeId: node.id, error });
        return { status: 'error', error } satisfies NodeOutcome;
      }
      emit({ type: 'node_done', runId, nodeId: node.id });
      return { status: 'ok', finalText } satisfies NodeOutcome;
    });
  } catch (err) {
    if (signal?.aborted) return { status: 'aborted' };
    const error = (err as Error).message;
    emit({ type: 'node_error', runId, nodeId: node.id, error });
    return { status: 'error', error };
  }
}

/** 构造 prompt：决策点要求输出 VERDICT；生产者重跑带上一版+上游反馈；紧接 input 用原始需求。 */
function buildPrompt(node: GraphAgentNode, trail: TrailEntry[], input: string, isDecision: boolean): string {
  const prev = trail.at(-1);
  if (isDecision) {
    return `【原始需求】${input}\n\n【待裁定内容】${prev?.output ?? '(无)'}\n\n请判定并在结尾输出一行 \`VERDICT: APPROVE\`（满意）或 \`VERDICT: REJECT\`（不满意），其后附反馈。`;
  }
  const lastSelf = [...trail].reverse().find((t) => t.nodeId === node.id);
  if (lastSelf) {
    const fb = prev?.verdict;
    return `【原始需求】${input}\n\n【你的上一版】${lastSelf.output}\n\n【上游裁定】${fb ? (fb.approved ? 'APPROVE' : 'REJECT') : '(无)'}\n【上游反馈】${fb?.feedback ?? '(无)'}\n\n请基于反馈修改。`;
  }
  return input;
}

/** 单路径条件游走（可注入 exec 用于测试）。input 可扇出多条前向出边 → 并行跑多个首层分支，各自产出后图结束（无汇合）。 */
export async function walkGraph(prompt: string, graph: Graph, opts: ExecuteOptions, exec: ExecNode = runAgentNode): Promise<void> {
  const { runId, emit, signal } = opts;
  const inputNode = graph.nodes.find((n) => n.id === graph.inputNode);
  if (!inputNode || inputNode.type !== 'input') {
    emit({ type: 'run_error', runId, error: 'invalid graph: input node missing' });
    return;
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const maxExec = graph.maxNodeExecutions ?? 50;
  const backEdges = computeBackEdges(graph);
  const isBack = (e: GraphEdge): boolean => backEdges.has(e.id);

  let finished = false;
  const finish = (ev: GraphEvent): void => {
    if (finished) return;
    finished = true;
    emit(ev);
  };

  // input 伪节点
  emit({ type: 'node_started', runId, nodeId: inputNode.id });
  emit({ type: 'node_message', runId, nodeId: inputNode.id, message: { type: 'text', nodeId: inputNode.id, content: prompt, timestamp: ts() } as AgentMessage });
  emit({ type: 'node_done', runId, nodeId: inputNode.id });

  const inputOuts = graph.edges.filter((e) => e.source === inputNode.id);
  if (inputOuts.length === 0) {
    finish({ type: 'run_error', runId, error: 'input node has no out-edge' });
    return;
  }

  // 分支间共享：节点迭代计数、回边覆盖计数、全局执行上限、最后完成输出（兜底）
  const nodeIter = new Map<string, number>();
  const edgeCount = new Map<string, number>();
  let totalExec = 0;
  let lastCompletedOutput = '';

  type BranchResult =
    | { status: 'completed'; output: string }
    | { status: 'edge_limit'; output: string; reason: string }
    | { status: 'global_limit'; output: string }
    | { status: 'aborted' }
    | { status: 'error'; error: string };

  /** 单路径分支游走：决策点解析 verdict→满意前向/不满意回边；回边 target 跑满 maxIter → edge_limit。 */
  async function walkBranch(startId: string, branchPrompt: string): Promise<BranchResult> {
    let nodeId = startId;
    let curPrompt = branchPrompt;
    const trail: TrailEntry[] = [];
    let lastProducer = '';
    while (true) {
      if (signal?.aborted) return { status: 'aborted' };
      if (++totalExec > maxExec) return { status: 'global_limit', output: lastProducer };
      const node = byId.get(nodeId);
      if (!node || node.type !== 'agent') return { status: 'completed', output: lastProducer };

      const iter = (nodeIter.get(nodeId) ?? 0) + 1;
      nodeIter.set(nodeId, iter);
      emit({ type: 'node_iteration', runId, nodeId, iteration: iter });

      const outs = graph.edges.filter((e) => e.source === nodeId);
      const forward = outs.filter((e) => !isBack(e));
      const backs = outs.filter((e) => isBack(e));
      const isDecision = backs.length > 0;

      const outcome = await exec(node, curPrompt, opts);
      if (outcome.status === 'aborted') return { status: 'aborted' };
      if (outcome.status === 'error') return { status: 'error', error: outcome.error ?? `node '${nodeId}' failed` };
      const finalText = outcome.finalText ?? '';

      const vctx: VerdictContext = { runId, nodeId, iteration: iter, finalText, trail };
      const verdict: Verdict | null = isDecision ? extractVerdict(node, vctx) : null;
      trail.push({ nodeId, output: finalText, verdict: verdict ?? undefined, iter });
      lastCompletedOutput = finalText;
      if (!isDecision) lastProducer = finalText;

      // 选边：决策点 满意→前向；不满意→回边。透传→前向。
      const chosen: GraphEdge | undefined = isDecision
        ? (verdict?.approved === true ? forward[0] : backs[0])
        : forward[0];
      if (!chosen) return { status: 'completed', output: lastProducer };

      // 回边：该边覆盖次数达 maxIterations → 该分支 edge_limit（采用本分支最后生产者输出）
      if (isBack(chosen)) {
        const cap = chosen.maxIterations ?? DEFAULT_BACK_EDGE_MAX_ITER;
        const used = edgeCount.get(chosen.id) ?? 0;
        if (used >= cap) {
          return { status: 'edge_limit', output: lastProducer, reason: `back-edge '${chosen.id}' reached maxIterations ${cap}` };
        }
        edgeCount.set(chosen.id, used + 1);
        const targetNode = byId.get(chosen.target);
        if (!targetNode || targetNode.type !== 'agent') return { status: 'completed', output: lastProducer };
        nodeId = chosen.target;
        curPrompt = buildPrompt(targetNode, trail, prompt, graph.edges.some((e) => e.source === chosen.target && isBack(e)));
        continue;
      }

      // 前向
      if (graph.endNode && chosen.target === graph.endNode) return { status: 'completed', output: lastProducer };
      const targetNode = byId.get(chosen.target);
      if (!targetNode || targetNode.type !== 'agent') return { status: 'completed', output: lastProducer };
      nodeId = chosen.target;
      curPrompt = buildPrompt(targetNode, trail, prompt, graph.edges.some((e) => e.source === chosen.target && isBack(e)));
    }
  }

  // 并行跑所有首层分支
  const results = await Promise.all(inputOuts.map((e) => walkBranch(e.target, prompt)));

  if (results.some((r) => r.status === 'aborted')) {
    finish({ type: 'run_aborted', runId });
    return;
  }
  const errRes = results.find((r): r is Extract<BranchResult, { status: 'error' }> => r.status === 'error');
  if (errRes) {
    finish({ type: 'run_error', runId, error: errRes.error });
    return;
  }
  const glRes = results.find((r): r is Extract<BranchResult, { status: 'global_limit' }> => r.status === 'global_limit');
  if (glRes) {
    finish({ type: 'run_done', runId, finalText: glRes.output || lastCompletedOutput, termination: 'global_limit', reason: `exceeded maxNodeExecutions ${maxExec}` });
    return;
  }
  // 各分支产出用 --- 拼接；无任何产出 → 兜底最后完成输出
  const finalText = results
    .filter((r): r is Extract<BranchResult, { output: string }> => 'output' in r && r.output !== '')
    .map((r) => r.output)
    .join('\n\n---\n\n') || lastCompletedOutput;
  const elRes = results.find((r): r is Extract<BranchResult, { status: 'edge_limit' }> => r.status === 'edge_limit');
  if (elRes) {
    finish({ type: 'run_done', runId, finalText, termination: 'edge_limit', reason: elRes.reason });
  } else {
    finish({ type: 'run_done', runId, finalText, termination: 'completed' });
  }
}

export async function executeGraph(prompt: string, graph: Graph, opts: ExecuteOptions): Promise<void> {
  return walkGraph(prompt, graph, opts, runAgentNode);
}
