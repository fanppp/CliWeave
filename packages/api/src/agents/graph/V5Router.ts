/**
 * V5 runner —— Router + RunCoordinator + 多通道路由执行。
 *
 * 流程：input → Router（fresh，只给消息+Thread 上下文，不执行工具）→ parseRouteDecision（malformed 重试1次→investigate 兜底）
 *   → validateRouteDecision（answer/inspect 不升级写、change 不走 direct）→ 低置信进 Investigator → 最多 reroute 一次 → 仍不确定→clarify(needs_input)
 *   → resolveLanePlan（lane→entry→forward 链→End，收集 gates + profile）→ emit run_plan_created → walkLane（forward 链 + V4 式 gate 循环 approve/revise/best-effort）。
 *
 * 独立 runner，不读时迁移；V5 gate 的 durable pause/resume 复用 V4 HarnessCheckpoint 留后续提交，本版 ask_user 耗尽/blocked → run_error 优雅失败。
 */
import { randomUUID } from 'node:crypto';
import { formatInstanceKey } from '../instance-key.js';
import type { SessionPolicy, NodeOutcome } from '../session-policy.js';
import type { AgentMessage } from '../types.js';
import type { GraphV5, GraphV5Edge } from './graph.js';
import type { ExecNode, ExecuteOptions } from './AgentRouter.js';
import type { PublicGraphEvent, RunQuality } from '../../infrastructure/websocket/SocketManager.js';
import { routerPrompt, parseRouteDecision, validateRouteDecision, resolveLanePlan, type IntentMode, type RouteDecision, type RunPlan } from './routing.js';
import { evaluatorPrompt, extractEvaluation, readDecisionRubric, revisionPrompt, selectBest, type Candidate, type Evaluation } from './evaluation.js';
import type { ExhaustedPolicy } from './graph.js';

const LOW_CONFIDENCE = 0.5;

type LaneResult = { status: 'completed' | 'best_effort'; output: string; termination?: 'completed' | 'best_effort'; quality: RunQuality } | { status: 'error'; error: string } | { status: 'aborted' };

export async function walkV5Graph(prompt: string, graph: GraphV5, opts: ExecuteOptions, exec: ExecNode, intentMode: IntentMode): Promise<void> {
  const { runId, projectId, emit, record, signal } = opts;
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  let totalExec = 0;
  let finished = false;
  const emitBoth = (event: PublicGraphEvent): void => { emit(event); record?.(event); };
  const finish = (event: PublicGraphEvent): void => { if (!finished) { finished = true; emitBoth(event); } };

  const invoke = async (node: Extract<GraphV5['nodes'][number], { type: 'agent' | 'decision' | 'router' | 'documenter' }>, nodePrompt: string, iteration: number, policy: SessionPolicy) => {
    if (++totalExec > graph.maxNodeExecutions) return { status: 'error' as const, error: `exceeded maxNodeExecutions ${graph.maxNodeExecutions}` };
    const instanceKey = formatInstanceKey(projectId, node.agentNodeKey);
    emitBoth({ type: 'node_iteration', runId, nodeId: node.id, iteration, instanceKey });
    return exec(node as Parameters<ExecNode>[0], (opts.contextPrefix ?? '') + nodePrompt, opts, { iteration, sessionPolicy: policy });
  };

  const input = byId.get(graph.inputNode);
  if (!input || input.type !== 'input') { finish({ type: 'run_error', runId, error: 'invalid V5 input node' }); return; }
  emitBoth({ type: 'node_started', runId, nodeId: input.id });
  emitBoth({ type: 'node_message', runId, nodeId: input.id, message: { type: 'text', nodeId: input.id, content: prompt, timestamp: Date.now() } as AgentMessage });
  emitBoth({ type: 'node_done', runId, nodeId: input.id });

  const router = graph.nodes.find((n) => n.type === 'router');
  if (!router || router.type !== 'router') { finish({ type: 'run_error', runId, error: 'V5 graph has no router node' }); return; }

  // 1. Router 决策（malformed 重试一次 → investigate 兜底）
  let rd: RouteDecision | null = null;
  for (let attempt = 0; attempt < 2 && !rd; attempt++) {
    if (signal?.aborted) { finish({ type: 'run_aborted', runId }); return; }
    const out = await invoke(router, routerPrompt(prompt, '', opts.contextPrefix ?? '', ''), attempt + 1, { mode: 'fresh', persistActive: false });
    if (out.status === 'aborted') { finish({ type: 'run_aborted', runId }); return; }
    if (out.status !== 'ok') continue;
    try { rd = parseRouteDecision(out.finalText ?? ''); } catch { /* malformed: one fresh retry */ }
  }
  if (!rd) rd = { schemaVersion: 1, lane: 'investigate', confidence: 0, risk: 'medium', sideEffects: 'none', reason: 'router returned malformed output twice', missingRequirements: [] };

  // 2. 校验 + 低置信 Investigator reroute 一次
  const v1 = validateRouteDecision(rd, intentMode);
  let finalRd: RouteDecision = v1.ok ? rd : { ...rd, lane: v1.fallbackLane };
  let rerouted = false;
  if (finalRd.confidence < LOW_CONFIDENCE && finalRd.lane !== 'clarify' && finalRd.lane !== 'unsupported') {
    const invPlan = safeResolve(graph, { ...finalRd, lane: 'investigate' }, false);
    const invNode = invPlan ? byId.get(invPlan.entryNodeId) : undefined;
    if (invNode && invNode.type === 'agent') {
      const inv = await invoke(invNode, `【原始需求】\n${prompt}\n\n请调研以补充路由所需信息。`, totalExec, { mode: 'fresh', persistActive: false });
      if (inv.status === 'aborted') { finish({ type: 'run_aborted', runId }); return; }
      const rerouteOut = await invoke(router, routerPrompt(prompt, '', inv.finalText ?? '', ''), totalExec + 1, { mode: 'fresh', persistActive: false });
      if (rerouteOut.status === 'ok') {
        try {
          const rd2 = parseRouteDecision(rerouteOut.finalText ?? '');
          const v2 = validateRouteDecision(rd2, intentMode);
          finalRd = v2.ok ? rd2 : { ...rd2, lane: v2.fallbackLane };
          rerouted = true;
        } catch { /* keep finalRd */ }
      }
    }
    if (finalRd.confidence < LOW_CONFIDENCE) finalRd = { ...finalRd, lane: 'clarify', reason: `${finalRd.reason} (low confidence after reroute)` };
  }

  // 3. clarify/unsupported → needs_input / run_error
  if (finalRd.lane === 'clarify' || finalRd.lane === 'unsupported') {
    emitBoth({ type: 'route_decided', runId, branchId: 'main', nodeId: router.id, claim: null, decision: 'clarify', reason: finalRd.reason, timestamp: Date.now() });
    const text = finalRd.missingRequirements.length ? finalRd.missingRequirements.join('; ') : finalRd.reason;
    emitBoth({ type: 'branch_done', runId, branchId: 'main', cause: 'needs_input', finalArtifact: text, timestamp: Date.now() });
    finish({ type: 'run_done', runId, finalText: text, termination: 'needs_input', reason: finalRd.reason });
    return;
  }

  // 4. resolveLanePlan + run_plan_created
  let plan: RunPlan;
  try { plan = resolveLanePlan(graph, finalRd, rerouted); }
  catch (e) { finish({ type: 'run_error', runId, error: (e as Error).message }); return; }
  emitBoth({ type: 'run_plan_created', runId, lane: plan.lane, entryNodeId: plan.entryNodeId, gateNodeIds: plan.gateNodeIds, rerouted, confidence: finalRd.confidence, risk: finalRd.risk, reason: finalRd.reason, timestamp: Date.now() });
  emitBoth({ type: 'route_decided', runId, branchId: 'main', nodeId: router.id, claim: null, decision: 'forward', reason: `lane=${plan.lane}; ${finalRd.reason}`, timestamp: Date.now() });

  // 5. walk lane
  const result = await walkLane(graph, plan, prompt, opts, exec, invoke, byId, signal);
  if (result.status === 'aborted') { finish({ type: 'run_aborted', runId }); return; }
  if (result.status === 'error') { finish({ type: 'run_error', runId, error: result.error }); return; }
  finish({ type: 'run_done', runId, finalText: result.output, termination: result.termination ?? 'completed', quality: result.quality });
}

function safeResolve(graph: GraphV5, rd: RouteDecision, rerouted: boolean): RunPlan | null {
  try { return resolveLanePlan(graph, rd, rerouted); } catch { return null; }
}

async function walkLane(
  graph: GraphV5,
  plan: RunPlan,
  prompt: string,
  opts: ExecuteOptions,
  exec: ExecNode,
  invoke: (node: Extract<GraphV5['nodes'][number], { type: 'agent' | 'decision' | 'router' | 'documenter' }>, nodePrompt: string, iteration: number, policy: SessionPolicy) => Promise<NodeOutcome>,
  byId: Map<string, GraphV5['nodes'][number]>,
  signal: AbortSignal | undefined,
): Promise<LaneResult> {
  const { runId, projectId, emit, record } = opts;
  const emitBoth = (e: PublicGraphEvent): void => { emit(e); record?.(e); };
  const activeForward = (from: string): GraphV5Edge | undefined => {
    const fwd = graph.edges.filter((e): e is Extract<GraphV5Edge, { kind: 'forward' }> => e.kind === 'forward');
    return fwd.find((e) => e.source === from && (!e.lanes || e.lanes.includes(plan.lane)));
  };
  let unresolvedGateIds: string[] = [];
  let exhausted = false;
  let bestCandidateId: string | undefined;
  let nodeId: string | undefined = plan.entryNodeId;
  let upstreamArtifact = prompt;
  let firstWork = true;
  while (nodeId) {
    if (signal?.aborted) return { status: 'aborted' };
    const node = byId.get(nodeId);
    if (!node) return { status: 'error', error: `lane node '${nodeId}' missing` };
    if (node.type === 'end') break;
    if (node.type !== 'agent') return { status: 'error', error: `lane target '${nodeId}' is not work` };
    let revision = 0;
    let workerSessionId: string | undefined;
    let artifact = '';
    const candidates: Candidate[] = [];
    const makeCandidate = (): Candidate => ({ id: randomUUID(), branchId: 'main', workNodeId: node.id, revision, artifact, evaluations: {} });
    const workPrompt = firstWork ? `【原始需求】\n${prompt}\n\n请按你的角色职责处理。` : `【原始需求】\n${prompt}\n\n【上游产物】\n${upstreamArtifact}\n\n请按你的角色职责继续。`;
    const outcome = await invoke(node, workPrompt, revision + 1, { mode: 'fresh', persistActive: false });
    if (outcome.status !== 'ok') return outcome.status === 'aborted' ? { status: 'aborted' } : { status: 'error', error: outcome.error ?? `${node.id} failed` };
    workerSessionId = outcome.sessionId;
    artifact = outcome.finalText ?? '';
    if (!artifact) return { status: 'error', error: `work '${node.id}' produced empty output; cannot enter evaluation` };
    firstWork = false;
    let candidate = makeCandidate(); candidates.push(candidate);
    emitBoth({ type: 'candidate_produced', runId, branchId: 'main', candidate, timestamp: Date.now() });
    const gates = graph.edges.filter((e): e is Extract<GraphV5Edge, { kind: 'gate' }> => e.kind === 'gate' && e.source === node.id).sort((a, b) => a.order - b.order);
    const gateCounts: Record<string, number> = {};
    let gateIndex = 0;
    let degraded = false;
    while (gateIndex < gates.length) {
      if (signal?.aborted) return { status: 'aborted' };
      const gate = gates[gateIndex];
      const decision = byId.get(gate.target);
      if (!decision || decision.type !== 'decision') return { status: 'error', error: `gate '${gate.id}' decision missing` };
      const rubric = opts.rubrics?.[decision.id]?.rubric ?? readDecisionRubric(projectId, decision as Parameters<typeof readDecisionRubric>[1]);
      emitBoth({ type: 'gate_status', runId, branchId: 'main', gateId: gate.id, status: 'running', timestamp: Date.now() });
      let evaluation: Evaluation | null = null;
      for (let attempt = 0; attempt < 2 && !evaluation; attempt++) {
        const evaluated = await invoke(decision, evaluatorPrompt(prompt, candidate.artifact, candidate.id, rubric), attempt + 1, { mode: 'fresh', persistActive: false });
        if (evaluated.status === 'aborted') return { status: 'aborted' };
        if (evaluated.status !== 'ok') continue;
        try { evaluation = extractEvaluation(evaluated.finalText ?? '', candidate.id, rubric); } catch { /* malformed retry */ }
      }
      if (!evaluation) evaluation = { candidateId: candidate.id, verdict: 'blocked', reason: 'evaluator returned malformed output twice', missingRequirements: [] };
      candidate.evaluations[gate.id] = evaluation;
      emitBoth({ type: 'evaluation_done', runId, branchId: 'main', gateId: gate.id, decisionNodeId: decision.id, evaluation, timestamp: Date.now() });
      if (evaluation.verdict === 'approve') { emitBoth({ type: 'gate_status', runId, branchId: 'main', gateId: gate.id, status: 'approved', timestamp: Date.now() }); gateIndex++; continue; }
      const policy: ExhaustedPolicy = opts.gatePolicyOverrides?.[gate.id] ?? gate.onExhausted;
      if (evaluation.verdict === 'blocked') {
        emitBoth({ type: 'gate_status', runId, branchId: 'main', gateId: gate.id, status: 'blocked', timestamp: Date.now() });
        emitBoth({ type: 'gate_blocked', runId, branchId: 'main', gateId: gate.id, candidateId: candidate.id, reason: evaluation.verdict === 'blocked' ? evaluation.reason : 'blocked', timestamp: Date.now() });
        return { status: 'error', error: `gate '${gate.id}' blocked: ${evaluation.reason} (V5 durable pause deferred)` };
      }
      const used = gateCounts[gate.id] ?? 0;
      if (used < gate.maxRevisions) {
        emitBoth({ type: 'candidate_rejected', runId, branchId: 'main', gateId: gate.id, candidateId: candidate.id, verdict: 'revise', timestamp: Date.now() });
        gateCounts[gate.id] = used + 1; revision++;
        const revised = await invoke(node, revisionPrompt(prompt, candidate.artifact, evaluation), revision + 1, workerSessionId ? { mode: 'resume', sessionId: workerSessionId, persistActive: false } : { mode: 'fresh', persistActive: false });
        if (revised.status !== 'ok') return revised.status === 'aborted' ? { status: 'aborted' } : { status: 'error', error: revised.error ?? `${node.id} revision failed` };
        workerSessionId = revised.sessionId ?? workerSessionId; artifact = revised.finalText ?? '';
        if (!artifact) return { status: 'error', error: `work '${node.id}' empty revision output` };
        candidate = makeCandidate(); candidates.push(candidate);
        emitBoth({ type: 'candidate_produced', runId, branchId: 'main', gateId: gate.id, candidate, timestamp: Date.now() });
        gateIndex = 0;
        continue;
      }
      emitBoth({ type: 'gate_status', runId, branchId: 'main', gateId: gate.id, status: 'exhausted', timestamp: Date.now() });
      const best = selectBest(candidates, gate.id, rubric);
      if (best) emitBoth({ type: 'best_candidate_selected', runId, branchId: 'main', gateId: gate.id, candidateId: best.id, timestamp: Date.now() });
      if (policy === 'fail' || !best) return { status: 'error', error: `gate '${gate.id}' exhausted without acceptable candidate (V5 durable pause deferred)` };
      if (!unresolvedGateIds.includes(gate.id)) unresolvedGateIds.push(gate.id);
      exhausted = true; bestCandidateId = best.id;
      candidate = best; artifact = best.artifact; degraded = true; gateIndex++;
    }
    upstreamArtifact = candidate.artifact; bestCandidateId = candidate.id;
    nodeId = activeForward(node.id)?.target;
  }
  return { status: exhausted ? 'best_effort' : 'completed', output: upstreamArtifact, termination: exhausted ? 'best_effort' : 'completed', quality: { status: exhausted ? 'best_effort' : 'approved', exhausted, ...(bestCandidateId ? { bestCandidateId } : {}), unresolvedGateIds } };
}
