/**
 * AgentRouter —— 图运行时（M4a-simplified：纯方向驱动）
 *
 * 回边（target 能经其它边回到 source）= "不满足→回到 target"；前向边 = "满足→继续/结束"。
 * 决策点（有回边出边）自动 emit verdict（满意/不满意）；满意→前向边，不满意→回边（maxIterations ?? 3）。
 * 单路径：每节点 ≤1 前向 + ≤1 回边。fan-out 留 M4b。
 *
 * 终态（finish guard 各最多一次）：
 * - 到 endNode / 无前向边 → run_done(completed, finalText=各分支最后生产者产出拼接||最后完成输出)。
 * - 回边覆盖次数达 maxIterations（默认1）→ best-effort：发 gate_exhausted 后改走前向（不硬终止）；分支终态 best_effort 跟随至聚合。
 * - 决策点未取到 verdict → 当不满意（走回边，靠 maxIter 兜底）。
 */
import { buildAgent, getActiveSessionCtx, setActiveSessionCtx } from '../AgentServiceFactory.js';
import { formatInstanceKey } from '../instance-key.js';
import { formatSubInvocationId } from '../run-registry.js';
import { withNodeLock } from '../node-mutex.js';
import { computeBackEdges, DEFAULT_BACK_EDGE_MAX_ITER, type Graph, type GraphAgentNode, type GraphEdge } from './graph.js';
import { extractVerdict, type TrailEntry, type Verdict, type VerdictContext } from './verdict.js';
import type { AgentMessage } from '../types.js';
import type { GraphEvent } from '../../infrastructure/websocket/SocketManager.js';

export interface ExecuteOptions {
  runId: string;
  projectId: string;
  /** WS 广播（公开形，M8 run_paused 可携带原始 resumeToken）。 */
  emit: (event: GraphEvent) => void;
  /** JSONL 持久化（持久形，token 须由调用方/recordRunEvent 净化为 hash）。 */
  record?: (event: GraphEvent) => void;
  signal?: AbortSignal;
}

interface NodeOutcome {
  status: 'ok' | 'error' | 'aborted';
  finalText?: string;
  error?: string;
}

export type ExecNode = (node: GraphAgentNode, prompt: string, opts: ExecuteOptions, iteration?: number) => Promise<NodeOutcome>;

function ts(): number {
  return Date.now();
}

/** 真实执行单个 agent 节点（画布实例隔离）。 */
export async function runAgentNode(node: GraphAgentNode, nodePrompt: string, opts: ExecuteOptions, iteration: number = 0): Promise<NodeOutcome> {
  const { runId, projectId, emit, record, signal } = opts;
  const instanceKey = formatInstanceKey(projectId, node.agentNodeKey);
  const emitBoth = (e: GraphEvent): void => {
    emit(e);
    record?.(e);
  };
  try {
    return await withNodeLock(instanceKey, async () => {
      if (signal?.aborted) return { status: 'aborted' } satisfies NodeOutcome;
      emitBoth({ type: 'node_started', runId, nodeId: node.id, instanceKey });
      const { ctx, service } = await buildAgent(projectId, node.agentNodeKey);
      const sessionId = getActiveSessionCtx(ctx);
      const texts: string[] = [];
      const subInvocationId = formatSubInvocationId(runId, node.id, iteration);

      for await (const msg of service.invoke(nodePrompt, {
        sessionId,
        workingDirectory: ctx.projectPath,
        invocationId: subInvocationId,
        ...(signal ? { signal } : {}),
      })) {
        if (msg.type === 'session_init') {
          setActiveSessionCtx(ctx, msg.sessionId);
          continue;
        }
        if (msg.type === 'done') continue;
        if (msg.type === 'error') {
          emitBoth({ type: 'node_message', runId, nodeId: node.id, instanceKey, message: msg });
          emitBoth({ type: 'node_error', runId, nodeId: node.id, instanceKey, error: msg.error });
          return { status: 'error', error: msg.error } satisfies NodeOutcome;
        }
        if (msg.type === 'text' && !msg.content.startsWith('[notice]')) texts.push(msg.content);
        emitBoth({ type: 'node_message', runId, nodeId: node.id, instanceKey, message: msg });
      }
      if (signal?.aborted) return { status: 'aborted' } satisfies NodeOutcome;

      const finalText = texts.at(-1) ?? '';
      if (!finalText) {
        const error = `node '${node.id}' produced no valid text output`;
        emitBoth({ type: 'node_error', runId, nodeId: node.id, instanceKey, error });
        return { status: 'error', error } satisfies NodeOutcome;
      }
      emitBoth({ type: 'node_done', runId, nodeId: node.id, instanceKey });
      return { status: 'ok', finalText } satisfies NodeOutcome;
    });
  } catch (err) {
    if (signal?.aborted) return { status: 'aborted' };
    const error = (err as Error).message;
    emitBoth({ type: 'node_error', runId, nodeId: node.id, instanceKey, error });
    return { status: 'error', error };
  }
}

/**
 * 构造 prompt（V3 legacy runner）：稳定三分区，显式状态，不反查 trail。
 * - decision：只读 lastProducerArtifact，不消费旧 review metadata（自己生成 metadata）。
 * - producer rework（target===lastProducerNodeId）：【上游产物】=你的上一版 + 【审核元数据】→ 修改。
 * - producer forward：【上游产物】+ 可选【审核元数据】→ 继续。
 * 不变量：【上游产物】只含 producer artifact；reviewer 文本永不入此区；reviewer output 不成为 lastProducerArtifact。
 */
function buildLegacyPrompt(
  _node: GraphAgentNode,
  input: string,
  lastProducerArtifact: string,
  lastProducerNodeId: string | null,
  latestReview: { approved: boolean; feedback: string } | null,
  isDecision: boolean,
): string {
  if (isDecision) {
    return `【原始需求】\n${input}\n\n【待裁定内容】\n${lastProducerArtifact || '(无)'}\n\n请判定并在结尾输出一行 \`VERDICT: APPROVE\`（满意）或 \`VERDICT: REJECT\`（不满意），其后附反馈。`;
  }
  const artifactSection = `【上游产物】\n${lastProducerArtifact || '(无)'}`;
  const reviewSection = latestReview
    ? `\n\n【审核元数据】\nVERDICT: ${latestReview.approved ? 'APPROVE' : 'REJECT'}\n反馈: ${latestReview.feedback}`
    : '';
  const instruction = lastProducerNodeId === _node.id
    ? '请基于审核反馈修改你的上一版。'
    : '请基于上游产物继续。';
  return `【原始需求】\n${input}\n\n${artifactSection}${reviewSection}\n\n${instruction}`;
}

/** 单路径条件游走（可注入 exec 用于测试）。input 可扇出多条前向出边 → 并行跑多个首层分支，各自产出后图结束（无汇合）。 */
export async function walkGraph(prompt: string, graph: Graph, opts: ExecuteOptions, exec: ExecNode = runAgentNode): Promise<void> {
  const { runId, projectId, emit, record, signal } = opts;
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
    record?.(ev);
  };

  // input 伪节点
  const emitInput = (ev: GraphEvent): void => {
    emit(ev);
    record?.(ev);
  };
  emitInput({ type: 'node_started', runId, nodeId: inputNode.id });
  emitInput({ type: 'node_message', runId, nodeId: inputNode.id, message: { type: 'text', nodeId: inputNode.id, content: prompt, timestamp: ts() } as AgentMessage });
  emitInput({ type: 'node_done', runId, nodeId: inputNode.id });

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
    | { status: 'best_effort'; output: string; reason?: string }
    | { status: 'global_limit'; output: string }
    | { status: 'aborted' }
    | { status: 'error'; error: string };

  /**
   * 单路径分支游走（V3 legacy）：显式状态 lastProducerArtifact/lastProducerNodeId/latestReview/bestEffortUsed。
   * 决策点解析 verdict→满意前向/不满意回边；回边覆盖达 maxIter → best-effort（改走前向 + 发 gate_exhausted），不硬终止。
   * producer 产出后清 review metadata（gap4）；bestEffortUsed 跟随分支，下游成功不抹掉 best-effort 事实（gap1）。
   */
  async function walkBranch(startId: string, branchPrompt: string): Promise<BranchResult> {
    let nodeId = startId;
    let curPrompt = branchPrompt;
    const trail: TrailEntry[] = [];
    let lastProducerArtifact = '';
    let lastProducerNodeId: string | null = null;
    let latestReview: { approved: boolean; feedback: string } | null = null;
    let bestEffortUsed = false;
    let bestEffortReason = '';

    /** 分支终态：bestEffortUsed 时标 best_effort（保留降级事实），否则 completed。 */
    const finalize = (output: string): BranchResult => ({
      status: bestEffortUsed ? 'best_effort' : 'completed',
      output,
      ...(bestEffortReason ? { reason: bestEffortReason } : {}),
    });

    while (true) {
      if (signal?.aborted) return { status: 'aborted' };
      if (++totalExec > maxExec) return { status: 'global_limit', output: lastProducerArtifact };
      const node = byId.get(nodeId);
      if (!node || node.type !== 'agent') return finalize(lastProducerArtifact);

      const iter = (nodeIter.get(nodeId) ?? 0) + 1;
      nodeIter.set(nodeId, iter);
      const instanceKey = formatInstanceKey(projectId, node.agentNodeKey);
      emit({ type: 'node_iteration', runId, nodeId, iteration: iter, instanceKey });
      record?.({ type: 'node_iteration', runId, nodeId, iteration: iter, instanceKey });

      const outs = graph.edges.filter((e) => e.source === nodeId);
      const forward = outs.filter((e) => !isBack(e));
      const backs = outs.filter((e) => isBack(e));
      const isDecision = backs.length > 0;

      const outcome = await exec(node, curPrompt, opts, iter);
      if (outcome.status === 'aborted') return { status: 'aborted' };
      if (outcome.status === 'error') return { status: 'error', error: outcome.error ?? `node '${nodeId}' failed` };
      const finalText = outcome.finalText ?? '';

      const vctx: VerdictContext = { runId, nodeId, iteration: iter, finalText, trail };
      const verdict: Verdict | null = isDecision ? extractVerdict(node, vctx) : null;
      trail.push({ nodeId, output: finalText, verdict: verdict ?? undefined, iter });
      lastCompletedOutput = finalText;

      // 显式状态（gap4）：producer 产出→设 artifact+清 review；decision→设 review（不碰 artifact）。
      if (isDecision) {
        latestReview = verdict ?? { approved: false, feedback: '(reviewer 未给出裁定)' };
      } else {
        lastProducerArtifact = finalText;
        lastProducerNodeId = node.id;
        latestReview = null;
      }

      // 选边：决策点 满意→前向；不满意→回边。透传→前向。
      let chosen: GraphEdge | undefined = isDecision
        ? (verdict?.approved === true ? forward[0] : backs[0])
        : forward[0];
      if (!chosen) return finalize(lastProducerArtifact);

      // 回边：覆盖次数达 maxIterations → best-effort（改走前向 + 发 gate_exhausted），不硬终止。
      // gap2：显式重指 chosen 走前向，不能裸 fall through 走回边 target。
      if (isBack(chosen)) {
        const cap = chosen.maxIterations ?? DEFAULT_BACK_EDGE_MAX_ITER;
        const used = edgeCount.get(chosen.id) ?? 0;
        if (used >= cap) {
          bestEffortUsed = true;
          bestEffortReason = `gate '${chosen.id}' exhausted (maxIterations ${cap}); best-effort forward`;
          const exEv = { type: 'gate_exhausted', runId, nodeId, edgeId: chosen.id, reason: bestEffortReason, lastProducerArtifact, reviewerFeedback: latestReview?.feedback ?? null } as const;
          emit(exEv);
          record?.(exEv);
          const continuation = forward[0];
          if (!continuation) return { status: 'best_effort', output: lastProducerArtifact, reason: bestEffortReason };
          chosen = continuation; // 显式改走前向，fall through 到前向块
        } else {
          edgeCount.set(chosen.id, used + 1);
          const tgtId = chosen.target;
          const targetNode = byId.get(tgtId);
          if (!targetNode || targetNode.type !== 'agent') return finalize(lastProducerArtifact);
          nodeId = tgtId;
          curPrompt = buildLegacyPrompt(targetNode, prompt, lastProducerArtifact, lastProducerNodeId, latestReview, graph.edges.some((e) => e.source === tgtId && isBack(e)));
          continue;
        }
      }

      // 前向（chosen 为前向，含 best-effort 重指）
      const fwdId = chosen.target;
      if (graph.endNode && fwdId === graph.endNode) return finalize(lastProducerArtifact);
      const targetNode = byId.get(fwdId);
      if (!targetNode || targetNode.type !== 'agent') return finalize(lastProducerArtifact);
      nodeId = fwdId;
      curPrompt = buildLegacyPrompt(targetNode, prompt, lastProducerArtifact, lastProducerNodeId, latestReview, graph.edges.some((e) => e.source === fwdId && isBack(e)));
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
  // 优先级：best_effort > completed（下游成功不抹掉上游 best-effort 事实，gap1）
  const beRes = results.find((r): r is Extract<BranchResult, { status: 'best_effort' }> => r.status === 'best_effort');
  if (beRes) {
    finish({ type: 'run_done', runId, finalText, termination: 'best_effort', reason: beRes.reason });
  } else {
    finish({ type: 'run_done', runId, finalText, termination: 'completed' });
  }
}

export async function executeGraph(prompt: string, graph: Graph, opts: ExecuteOptions): Promise<void> {
  return walkGraph(prompt, graph, opts, runAgentNode);
}
