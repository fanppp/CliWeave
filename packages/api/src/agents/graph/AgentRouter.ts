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
import { formatSubInvocationId, registerSubInvocation, removeSubInvocation } from '../run-registry.js';
import { withNodeLock } from '../node-mutex.js';
import { invokeAgentWithPolicy } from '../invoke-agent.js';
import type { SessionPolicy, NodeOutcome } from '../session-policy.js';
import type { AgentMessage } from '../types.js';
import { computeBackEdges, DEFAULT_BACK_EDGE_MAX_ITER, type AnyGraph, type AnyGraphAgentNode, type ExhaustedPolicy, type Graph, type GraphAgentNode, type GraphEdge } from './graph.js';
import { extractVerdict, type TrailEntry, type Verdict, type VerdictContext } from './verdict.js';
import { AUTO_ROUTE_INSTRUCTION, extractCompletion, type RunMode } from './completion.js';
import type { PublicGraphEvent, PersistedRunEvent } from '../../infrastructure/websocket/SocketManager.js';
import { walkEvaluatorOptimizerGraph } from './EvaluatorOptimizerRouter.js';
import type { Rubric } from './evaluation.js';

export interface ExecuteOptions {
  runId: string;
  projectId: string;
  /** WS 广播（仅 PublicGraphEvent；run_state/branch_checkpoint 不得经此广播，防内部事件泄漏前端）。 */
  emit: (event: PublicGraphEvent) => void;
  /** JSONL 持久化（PersistedRunEvent：公开事件 + 内部检查点）。 */
  record?: (event: PersistedRunEvent) => void;
  signal?: AbortSignal;
  /** Step 3: Thread 跨轮上下文前缀（serverContext+summary+历史 turns+pins），由 /run/start 一次构造、注入每个节点 prompt。 */
  contextPrefix?: string;
  /** auto 仅允许每个首层分支的第一个 work 节点决定提前结束；缺省 full 保持旧客户端行为。 */
  runMode?: RunMode;
  gatePolicyOverrides?: Record<string, ExhaustedPolicy>;
  /** V4 run_meta 中冻结的 rubric 快照。运行和恢复都必须使用它，禁止中途重读可变文件。 */
  rubrics?: Record<string, { rubricRef: string; hash: string; rubric: Rubric }>;
}

/** 节点执行上下文（第 4 参，测试 wrapper 必须透传，不依赖少参数赋值）。 */
export interface NodeExecContext {
  iteration: number;
  sessionPolicy: SessionPolicy;
}

export type ExecNode = (node: AnyGraphAgentNode, prompt: string, opts: ExecuteOptions, context: NodeExecContext) => Promise<NodeOutcome>;

function ts(): number {
  return Date.now();
}

/** 真实执行单个 agent 节点（画布实例隔离）。图运行收 fresh/resume，永不传 active → 不触碰 active-session.json。 */
export async function runAgentNode(node: AnyGraphAgentNode, nodePrompt: string, opts: ExecuteOptions, context: NodeExecContext): Promise<NodeOutcome> {
  const { runId, projectId, emit, record, signal } = opts;
  const { iteration, sessionPolicy } = context;
  const instanceKey = formatInstanceKey(projectId, node.agentNodeKey);
  const emitBoth = (e: PublicGraphEvent): void => {
    emit(e);
    record?.(e);
  };
  let subInvocationId = '';
  try {
    return await withNodeLock(instanceKey, async () => {
      if (signal?.aborted) return { status: 'aborted' } satisfies NodeOutcome;
      emitBoth({ type: 'node_started', runId, nodeId: node.id, instanceKey });
      const { ctx, service } = await buildAgent(projectId, node.agentNodeKey);
      subInvocationId = formatSubInvocationId(runId, node.id, iteration);
      // 登记 sub-invocation（RunRegistry，供按 run 查询/审计）；spawnCli 据 invocationId+runId 登记 PID
      registerSubInvocation({ subInvocationId, parentRunId: runId, projectId, instanceKey, createdAt: Date.now() });

      const outcome = await invokeAgentWithPolicy({
        service,
        nodeId: node.id,
        prompt: nodePrompt,
        policy: sessionPolicy,
        workingDirectory: ctx.projectPath,
        invocationId: subInvocationId,
        runId,
        signal,
        onMessage: (msg) => emitBoth({ type: 'node_message', runId, nodeId: node.id, instanceKey, message: msg }),
        getActiveSession: () => getActiveSessionCtx(ctx),
        setActiveSession: (sid) => setActiveSessionCtx(ctx, sid),
      });

      if (outcome.status === 'ok') {
        emitBoth({ type: 'node_done', runId, nodeId: node.id, instanceKey });
      } else if (outcome.status === 'error') {
        emitBoth({ type: 'node_error', runId, nodeId: node.id, instanceKey, error: outcome.error ?? '' });
      }
      // aborted：不发终态，由 walkGraph 发 run_aborted
      return outcome;
    });
  } catch (err) {
    if (signal?.aborted) return { status: 'aborted' };
    const error = (err as Error).message;
    emitBoth({ type: 'node_error', runId, nodeId: node.id, instanceKey, error });
    return { status: 'error', error };
  } finally {
    // 清理 sub-invocation 注册（PID 由 spawnCli 自行注销；此处仅清 RunRegistry 索引）
    if (subInvocationId) removeSubInvocation(subInvocationId);
  }
}

/**
 * 构造 prompt（V3 legacy）：稳定三分区，显式状态，不反查 trail。
 * - decision：只读上游产物（聚合），不消费旧 review metadata（自己生成 metadata）。
 * - producer rework（target===lastProducerNodeId）：【上游产物】=你的上一版 + 【审核元数据】→ 修改。
 * - producer forward/join：【上游产物】（多上游用 --- 拼接）+ 可选【审核元数据】→ 继续。
 * 不变量：【上游产物】只含 producer artifact；reviewer 文本永不入此区；reviewer output 不成为 lastProducerArtifact。
 * join 节点（多前向入边）聚合所有上游产物，等齐再跑一次（不再每来一个上游跑一次）。
 */
function buildLegacyPrompt(
  _node: GraphAgentNode,
  input: string,
  upstreamArtifacts: string[],
  lastProducerNodeId: string | null,
  latestReview: { approved: boolean; feedback: string } | null,
  isDecision: boolean,
): string {
  const artifactBlob = upstreamArtifacts.length > 0 ? upstreamArtifacts.join('\n---\n') : '';
  if (isDecision) {
    return `【原始需求】\n${input}\n\n【待裁定内容】\n${artifactBlob || '(无)'}\n\n请判定并在结尾输出一行 \`VERDICT: APPROVE\`（满意）或 \`VERDICT: REJECT\`（不满意），其后附反馈。`;
  }
  const artifactSection = `【上游产物】\n${artifactBlob || '(无)'}`;
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
  const finish = (ev: PublicGraphEvent): void => {
    if (finished) return;
    finished = true;
    emit(ev);
    record?.(ev);
  };

  // input 伪节点
  const emitInput = (ev: PublicGraphEvent): void => {
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

  // 分支间共享：节点迭代计数、回边覆盖计数、全局执行上限、join 汇聚缓冲
  const nodeIter = new Map<string, number>();
  const edgeCount = new Map<string, number>();
  let totalExec = 0;
  // 前向入度（仅前向边）：join 节点 >1。arrival 时 deposit 产物，等齐所有前向上游再跑一次（聚合产物）。
  const forwardInDegree = new Map<string, number>();
  for (const n of graph.nodes) forwardInDegree.set(n.id, 0);
  for (const e of graph.edges) if (!isBack(e)) forwardInDegree.set(e.target, (forwardInDegree.get(e.target) ?? 0) + 1);
  const joinBuffer = new Map<string, Map<string, string>>();

  type BranchResult =
    | { status: 'completed'; output: string }
    | { status: 'early_complete'; output: string }
    | { status: 'needs_input'; output: string; reason: string }
    | { status: 'best_effort'; output: string; reason?: string }
    | { status: 'global_limit'; output: string }
    | { status: 'aborted' }
    | { status: 'error'; error: string };

  /**
   * 单路径分支游走（V3 legacy）：显式状态 lastProducerArtifact/lastProducerNodeId/latestReview/bestEffortUsed。
   * 决策点解析 verdict→满意前向/不满意回边；回边覆盖达 maxIter → best-effort（改走前向 + 发 gate_exhausted），不硬终止。
   * producer 产出后清 review metadata（gap4）；bestEffortUsed 跟随分支，下游成功不抹掉 best-effort 事实（gap1）。
   */
  async function walkBranch(startEdge: GraphEdge, branchPrompt: string): Promise<BranchResult> {
    const branchId = startEdge.id;
    let inEdge: GraphEdge | null = startEdge;
    let nodeId = startEdge.target;
    let carriedArtifact = branchPrompt;
    let arrivedViaBack = false; // 首层经 input 前向边到达
    const trail: TrailEntry[] = [];
    let lastProducerArtifact = '';
    let lastProducerNodeId: string | null = null;
    let latestReview: { approved: boolean; feedback: string } | null = null;
    let bestEffortUsed = false;
    let bestEffortReason = '';
    // producer nodeId → sessionId（branch 内，run-scoped）：rework(回边回到 producer) resume 该 session
    const producerSessions = new Map<string, string>();
    let firstProducerSeen = false;

    /** 分支终态：bestEffortUsed 时标 best_effort（保留降级事实），否则 completed。 */
    const finalize = (output: string): BranchResult => ({
      status: bestEffortUsed ? 'best_effort' : 'completed',
      output,
      ...(bestEffortReason ? { reason: bestEffortReason } : {}),
    });

    while (true) {
      if (signal?.aborted) return { status: 'aborted' };
      if (++totalExec > maxExec) return { status: 'global_limit', output: lastProducerArtifact };

      // ── JOIN 汇聚：前向到达时 deposit 产物，等齐所有前向上游再跑一次（聚合）。
      // 非_agent（end 等）：本分支产出 = lastProducerArtifact，不经 join（end 是汇点，各分支独立完成）
      const node = byId.get(nodeId);
      if (!node || node.type !== 'agent') return finalize(lastProducerArtifact);

      // ── JOIN 汇聚：前向到达时 deposit 产物，等齐所有前向上游再跑一次（聚合）。
      // 回边（rework）旁路 join——同分支内循环重做，不重复 deposit。
      let upstreamArtifacts: string[];
      if (arrivedViaBack) {
        upstreamArtifacts = [carriedArtifact];
      } else {
        const need = forwardInDegree.get(nodeId) ?? 0;
        const buf = joinBuffer.get(nodeId) ?? new Map<string, string>();
        if (inEdge) buf.set(inEdge.id, carriedArtifact);
        joinBuffer.set(nodeId, buf);
        if (need > 1 && buf.size < need) {
          // 上游未齐：本分支贡献产物后终止，join 节点由最后到达者跑
          return finalize('');
        }
        upstreamArtifacts = need > 0 ? [...buf.values()] : [carriedArtifact];
      }

      const iter = (nodeIter.get(nodeId) ?? 0) + 1;
      nodeIter.set(nodeId, iter);
      const instanceKey = formatInstanceKey(projectId, node.agentNodeKey);
      emit({ type: 'node_iteration', runId, nodeId, iteration: iter, instanceKey });
      record?.({ type: 'node_iteration', runId, nodeId, iteration: iter, instanceKey });

      const outs = graph.edges.filter((e) => e.source === nodeId);
      const forward = outs.filter((e) => !isBack(e));
      const backs = outs.filter((e) => isBack(e));
      const isDecision = backs.length > 0;

      const shouldRoute = (opts.runMode ?? 'full') === 'auto' && !firstProducerSeen && !isDecision;
      const curPrompt = (opts.contextPrefix ?? '')
        + buildLegacyPrompt(node, prompt, upstreamArtifacts, lastProducerNodeId, latestReview, isDecision)
        + (shouldRoute ? AUTO_ROUTE_INSTRUCTION : '');
      // 会话策略：rework(回边回到 producer) resume 该 producer 的 session；其余 fresh。图运行永不传 active。
      const sessionPolicy: SessionPolicy =
        arrivedViaBack && producerSessions.has(nodeId)
          ? { mode: 'resume', sessionId: producerSessions.get(nodeId)!, persistActive: false }
          : { mode: 'fresh', persistActive: false };
      const outcome = await exec(node, curPrompt, opts, { iteration: iter, sessionPolicy });
      if (outcome.status === 'aborted') return { status: 'aborted' };
      if (outcome.status === 'error') return { status: 'error', error: outcome.error ?? `node '${nodeId}' failed` };
      let finalText = outcome.finalText ?? '';

      // Auto 只信任首个 producer 的行锚定控制块。控制块从 artifact 中移除，永不传给下游。
      if (shouldRoute) {
        firstProducerSeen = true;
        const routed = extractCompletion(finalText);
        finalText = routed.artifact;
        const routeEvent = {
          type: 'route_decided', runId, branchId, nodeId,
          claim: routed.claim, decision: routed.decision, reason: routed.reason, timestamp: ts(),
        } as const;
        emit(routeEvent);
        record?.(routeEvent);
        if (routed.decision === 'finish') {
          const doneEvent = { type: 'branch_done', runId, branchId, cause: 'early_complete', finalArtifact: finalText, timestamp: ts() } as const;
          emit(doneEvent);
          record?.(doneEvent);
          return { status: 'early_complete', output: finalText };
        }
        if (routed.decision === 'clarify') {
          const doneEvent = { type: 'branch_done', runId, branchId, cause: 'needs_input', finalArtifact: finalText, timestamp: ts() } as const;
          emit(doneEvent);
          record?.(doneEvent);
          return { status: 'needs_input', output: finalText, reason: routed.reason };
        }
      } else if (!isDecision) {
        firstProducerSeen = true;
      }

      const vctx: VerdictContext = { runId, nodeId, iteration: iter, finalText, trail };
      const verdict: Verdict | null = isDecision ? extractVerdict(node, vctx) : null;
      trail.push({ nodeId, output: finalText, verdict: verdict ?? undefined, iter });

      // 显式状态（gap4）：producer 产出→设 artifact+清 review；decision→设 review（不碰 artifact）。
      if (isDecision) {
        latestReview = verdict ?? { approved: false, feedback: '(reviewer 未给出裁定)' };
      } else {
        lastProducerArtifact = finalText;
        lastProducerNodeId = node.id;
        latestReview = null;
        // 捕获 producer 的 sessionId（供后续 rework resume）；resumeFallback 时 outcome.sessionId 已是 fresh 的新 id
        if (outcome.sessionId) producerSessions.set(node.id, outcome.sessionId);
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
          const exEv = { type: 'gate_exhausted', runId, nodeId, instanceKey, edgeId: chosen.id, reason: bestEffortReason, lastProducerArtifact, reviewerFeedback: latestReview?.feedback ?? null, timestamp: Date.now() } as const;
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
          // rework：回边旁路 join（同分支内循环重做）
          inEdge = chosen;
          nodeId = tgtId;
          carriedArtifact = lastProducerArtifact;
          arrivedViaBack = true;
          continue;
        }
      }

      // 前向（chosen 为前向，含 best-effort 重指）
      const fwdId = chosen.target;
      if (graph.endNode && fwdId === graph.endNode) return finalize(lastProducerArtifact);
      const targetNode = byId.get(fwdId);
      if (!targetNode || targetNode.type !== 'agent') return finalize(lastProducerArtifact);
      inEdge = chosen;
      nodeId = fwdId;
      carriedArtifact = lastProducerArtifact;
      arrivedViaBack = false;
    }
  }

  // 并行跑所有首层分支（各分支在 join 节点汇聚：等齐所有前向上游再跑一次）
  const results = await Promise.all(inputOuts.map((e) => walkBranch(e, prompt)));

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
    if (!glRes.output) {
      finish({ type: 'run_error', runId, error: 'global execution limit reached with no producer artifact' });
    } else {
      finish({ type: 'run_done', runId, finalText: glRes.output, termination: 'global_limit', reason: `exceeded maxNodeExecutions ${maxExec}` });
    }
    return;
  }
  // 各分支 producer 产出用 --- 拼接；无任何 producer artifact → run_error（reviewer 文本永不成为 payload）
  const finalText = results
    .filter((r): r is Extract<BranchResult, { output: string }> => 'output' in r && r.output !== '')
    .map((r) => r.output)
    .join('\n\n---\n\n');
  if (!finalText) {
    finish({ type: 'run_error', runId, error: 'no producer artifact produced (reviewer output is never payload)' });
    return;
  }
  // 优先级：best_effort > completed（下游成功不抹掉上游 best-effort 事实，gap1）
  const beRes = results.find((r): r is Extract<BranchResult, { status: 'best_effort' }> => r.status === 'best_effort');
  if (beRes) {
    finish({ type: 'run_done', runId, finalText, termination: 'best_effort', reason: beRes.reason });
  } else if (results.some((r) => r.status === 'needs_input')) {
    const blocked = results.find((r): r is Extract<BranchResult, { status: 'needs_input' }> => r.status === 'needs_input');
    finish({ type: 'run_done', runId, finalText, termination: 'needs_input', reason: blocked?.reason ?? 'missing required input' });
  } else if (results.every((r) => r.status === 'early_complete')) {
    finish({ type: 'run_done', runId, finalText, termination: 'early_complete' });
  } else {
    finish({ type: 'run_done', runId, finalText, termination: 'completed' });
  }
}

export async function executeGraph(prompt: string, graph: AnyGraph, opts: ExecuteOptions): Promise<void> {
  return graph.schemaVersion === 4
    ? walkEvaluatorOptimizerGraph(prompt, graph, opts, runAgentNode)
    : walkGraph(prompt, graph, opts, runAgentNode);
}
