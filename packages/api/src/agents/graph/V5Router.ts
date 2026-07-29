/**
 * V5 runner —— Router + RunCoordinator + 多通道路由执行。
 *
 * 流程：input → Router（fresh，只给消息+Thread 上下文，不执行工具）→ parseRouteDecision（malformed 重试1次→investigate 兜底）
 *   → validateRouteDecision（answer/inspect 不升级写、change 不走 direct）→ 低置信进 Investigator → 最多 reroute 一次 → 仍不确定→clarify(needs_input)
 *   → resolveLanePlan（lane→entry→forward 链→End，收集 gates + profile）→ emit run_plan_created → walkLane（forward 链 + V4 式 gate 循环 approve/revise/best-effort）。
 *
 * Durable pause/resume（#10）：gate 耗尽(onExhausted=ask_user)或阻塞(onBlocked=ask_user) 落盘 V5GateCheckpoint（branch_checkpoint）+
 *   run_state paused，emit run_paused(pauseKind:'gate')，token 只经 WS。resume 复用 V4 best/revise/fail 规则，不重跑已完成 work。
 *   onExhausted/onBlocked=fail 仍直接 run_error（终态）。clarify 的 durable pause 见 #11。
 *
 * 独立 runner，不读时迁移。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { formatInstanceKey } from '../instance-key.js';
import type { SessionPolicy, NodeOutcome } from '../session-policy.js';
import type { AgentMessage } from '../types.js';
import type { GraphV5, GraphV5Edge } from './graph.js';
import { isEdgeActive } from './graph.js';
import type { ExecNode, ExecuteOptions } from './AgentRouter.js';
import type { PublicGraphEvent, RunQuality } from '../../infrastructure/websocket/SocketManager.js';
import { routerPrompt, parseRouteDecision, validateRouteDecision, resolveLanePlan, type IntentMode, type RouteDecision, type RunPlan } from './routing.js';
import { evaluatorPrompt, extractEvaluation, readDecisionRubric, revisionPrompt, selectBest, type Candidate, type Evaluation } from './evaluation.js';
import type { ExhaustedPolicy } from './graph.js';
import { hashToken, TOKEN_TTL_MS, type V5GateCheckpoint, type V5ClarifyCheckpoint, type ResumeAction } from './checkpoint.js';

const LOW_CONFIDENCE = 0.5;

type LaneResult = { status: 'completed' | 'best_effort'; output: string; termination?: 'completed' | 'best_effort'; quality: RunQuality } | { status: 'error'; error: string } | { status: 'aborted' } | { status: 'paused' };

export async function walkV5Graph(prompt: string, graph: GraphV5, opts: ExecuteOptions, exec: ExecNode, intentMode: IntentMode, resume?: { checkpoint: V5GateCheckpoint; action: ResumeAction }, clarifyResume?: { checkpoint: V5ClarifyCheckpoint; userResponse: string }): Promise<void> {
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

  // durable clarify pause：Router 判定 clarify（缺关键信息）→ 落盘 V5ClarifyCheckpoint + run_state paused，
  // emit run_paused(pauseKind:'clarify')，token 只经 WS。resume 补充文本后同 run 重跑 Router。
  function pauseClarify(rd: RouteDecision, originalPrompt: string, clarificationAttempts: number): void {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const payload: V5ClarifyCheckpoint = { runner: 'v5', kind: 'clarify', schemaVersion: 1, branchId: 'main', routeDecision: rd, originalPrompt, clarificationAttempts, tokenHash: hashToken(token), expiresAt };
    record?.({ type: 'branch_checkpoint', runId, branchId: 'main', payload });
    record?.({ type: 'run_state', runId, phase: 'paused', payload: { branchId: 'main', status: 'paused', pauseKind: 'clarify', missingRequirements: rd.missingRequirements } });
    emit({ type: 'run_paused', runId, projectId, branchId: 'main', pauseKind: 'clarify', question: rd.missingRequirements.length ? rd.missingRequirements.join('; ') : rd.reason, missingRequirements: rd.missingRequirements, resumeToken: token, expiresAt });
  }

  const input = byId.get(graph.inputNode);
  if (!input || input.type !== 'input') { finish({ type: 'run_error', runId, error: 'invalid V5 input node' }); return; }
  if (!resume && !clarifyResume) {
    emitBoth({ type: 'node_started', runId, nodeId: input.id });
    emitBoth({ type: 'node_message', runId, nodeId: input.id, message: { type: 'text', nodeId: input.id, content: prompt, timestamp: Date.now() } as AgentMessage });
    emitBoth({ type: 'node_done', runId, nodeId: input.id });
  }

  // resume：跳过 input/Router/Coordinator，恢复 plan，在暂停的 gate 处重新进入 walkLane（不重跑已完成 work）。
  if (resume) {
    const result = await walkLane(graph, resume.checkpoint.plan, prompt, opts, exec, invoke, byId, signal, resume);
    if (result.status === 'aborted') { finish({ type: 'run_aborted', runId }); return; }
    if (result.status === 'paused') return; // pause 已 emit run_paused
    if (result.status === 'error') { finish({ type: 'run_error', runId, error: result.error }); return; }
    finish({ type: 'run_done', runId, finalText: result.output, termination: result.termination ?? 'completed', quality: result.quality });
    return;
  }

  // clarify-resume：跳过 input/初始 Router/Investigator，用补充文本重跑 Router（同 run 同 turn），最多 2 次，再不足 → run_error。
  if (clarifyResume) {
    const cp = clarifyResume.checkpoint;
    const attempts = cp.clarificationAttempts + 1;
    const routerNode = graph.nodes.find((n) => n.type === 'router');
    if (!routerNode || routerNode.type !== 'router') { finish({ type: 'run_error', runId, error: 'V5 graph has no router node' }); return; }
    const clarifiedPrompt = `${cp.originalPrompt}\n\n【用户补充】\n${clarifyResume.userResponse}`;
    const out = await invoke(routerNode, routerPrompt(clarifiedPrompt, '', opts.contextPrefix ?? '', ''), 1, { mode: 'fresh', persistActive: false });
    if (out.status === 'aborted') { finish({ type: 'run_aborted', runId }); return; }
    let rd: RouteDecision | null = null;
    if (out.status === 'ok') { try { rd = parseRouteDecision(out.finalText ?? ''); } catch { /* malformed */ } }
    if (!rd) rd = { ...cp.routeDecision, reason: `router returned malformed output on clarify resume (attempt ${attempts})` };
    if (rd.lane === 'clarify' || rd.lane === 'unsupported') {
      if (attempts >= 2) { finish({ type: 'run_error', runId, error: `clarification exhausted after ${attempts} attempts` }); return; }
      pauseClarify(rd.lane === 'clarify' ? rd : { ...rd, lane: 'clarify' }, cp.originalPrompt, attempts);
      return;
    }
    // 非 clarify：信任补充后的新决策，resolveLanePlan + walkLane（跳过 validate/investigate，已于暂停前完成）。
    let plan: RunPlan;
    try { plan = resolveLanePlan(graph, rd, false); }
    catch (e) { finish({ type: 'run_error', runId, error: (e as Error).message }); return; }
    emitBoth({ type: 'run_plan_created', runId, lane: plan.lane, entryNodeId: plan.entryNodeId, gateNodeIds: plan.gateNodeIds, rerouted: false, confidence: rd.confidence, risk: rd.risk, reason: rd.reason, timestamp: Date.now() });
    emitBoth({ type: 'route_decided', runId, branchId: 'main', nodeId: routerNode.id, claim: null, decision: 'forward', reason: `lane=${plan.lane}; ${rd.reason}`, timestamp: Date.now() });
    const result = await walkLane(graph, plan, prompt, opts, exec, invoke, byId, signal);
    if (result.status === 'aborted') { finish({ type: 'run_aborted', runId }); return; }
    if (result.status === 'paused') return;
    if (result.status === 'error') { finish({ type: 'run_error', runId, error: result.error }); return; }
    finish({ type: 'run_done', runId, finalText: result.output, termination: result.termination ?? 'completed', quality: result.quality });
    return;
  }

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

  // 3. clarify → durable pause（补充文本后重跑 Router）；unsupported → 终态 needs_input（超出能力）。
  if (finalRd.lane === 'clarify') {
    emitBoth({ type: 'route_decided', runId, branchId: 'main', nodeId: router.id, claim: null, decision: 'clarify', reason: finalRd.reason, timestamp: Date.now() });
    pauseClarify(finalRd, prompt, 0);
    return;
  }
  if (finalRd.lane === 'unsupported') {
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
  if (result.status === 'paused') return; // gate ask_user → durable pause 已 emit run_paused
  if (result.status === 'error') { finish({ type: 'run_error', runId, error: result.error }); return; }
  finish({ type: 'run_done', runId, finalText: result.output, termination: result.termination ?? 'completed', quality: result.quality });
}

function safeResolve(graph: GraphV5, rd: RouteDecision, rerouted: boolean): RunPlan | null {
  try { return resolveLanePlan(graph, rd, rerouted); } catch { return null; }
}

export async function resumeV5Graph(prompt: string, graph: GraphV5, opts: ExecuteOptions, checkpoint: V5GateCheckpoint, action: ResumeAction, exec: ExecNode): Promise<void> {
  return walkV5Graph(prompt, graph, opts, exec, 'auto', { checkpoint, action });
}

export async function resumeV5Clarify(prompt: string, graph: GraphV5, opts: ExecuteOptions, checkpoint: V5ClarifyCheckpoint, userResponse: string, exec: ExecNode): Promise<void> {
  return walkV5Graph(prompt, graph, opts, exec, 'auto', undefined, { checkpoint, userResponse });
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
  resume?: { checkpoint: V5GateCheckpoint; action: ResumeAction },
): Promise<LaneResult> {
  const { runId, projectId, emit, record } = opts;
  const emitBoth = (e: PublicGraphEvent): void => { emit(e); record?.(e); };
  const activeForward = (from: string): GraphV5Edge | undefined => {
    const fwd = graph.edges.filter((e): e is Extract<GraphV5Edge, { kind: 'forward' }> => e.kind === 'forward');
    return fwd.find((e) => e.source === from && isEdgeActive(e, plan.lane, plan.routeDecision.risk));
  };

  // durable gate pause：落盘 V5GateCheckpoint + run_state paused，emit run_paused(pauseKind:'gate')，token 只经 WS。
  async function pause(gateId: string, cp: Omit<V5GateCheckpoint, 'runner' | 'kind' | 'schemaVersion' | 'tokenHash' | 'expiresAt'>): Promise<LaneResult> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const payload: V5GateCheckpoint = { runner: 'v5', kind: 'gate', schemaVersion: 1, ...cp, tokenHash: hashToken(token), expiresAt };
    record?.({ type: 'branch_checkpoint', runId, branchId: 'main', payload });
    record?.({ type: 'run_state', runId, phase: 'paused', payload: { branchId: 'main', gateId, status: 'paused', pauseReason: payload.pauseReason, allowedActions: payload.allowedActions, ...(payload.bestCandidateId ? { bestCandidateId: payload.bestCandidateId } : {}) } });
    emit({ type: 'run_paused', runId, projectId, branchId: 'main', pauseKind: 'gate', gateId, question: '审核预算耗尽或评估阻塞，请选择后续动作', options: payload.allowedActions, resumeToken: token, expiresAt });
    return { status: 'paused' };
  }

  let unresolvedGateIds: string[] = resume ? [...resume.checkpoint.unresolvedGateIds] : [];
  let exhausted = resume?.checkpoint.exhausted ?? false;
  let degraded = resume?.checkpoint.degraded ?? false;
  let bestCandidateId: string | undefined = resume?.checkpoint.bestCandidateId;
  let nodeId: string | undefined = resume?.checkpoint.nodeId ?? plan.entryNodeId;
  let upstreamArtifact = resume?.checkpoint.upstreamArtifact ?? prompt;
  let firstWork = !resume;
  let laneResume = resume;
  while (nodeId) {
    if (signal?.aborted) return { status: 'aborted' };
    const node = byId.get(nodeId);
    if (!node) return { status: 'error', error: `lane node '${nodeId}' missing` };
    if (node.type === 'end') break;
    if (node.type !== 'agent') return { status: 'error', error: `lane target '${nodeId}' is not work` };
    let revision = laneResume ? Math.max(0, ...laneResume.checkpoint.candidates.map((c) => c.revision)) : 0;
    let workerSessionId: string | undefined = laneResume?.checkpoint.workerSessionId;
    let artifact = '';
    const candidates: Candidate[] = laneResume ? [...laneResume.checkpoint.candidates] : [];
    const makeCandidate = (): Candidate => ({ id: randomUUID(), branchId: 'main', workNodeId: node.id, revision, artifact, evaluations: {} });
    let candidate: Candidate;
    if (laneResume) {
      candidate = candidates.find((c) => c.id === laneResume!.checkpoint.currentCandidateId) ?? candidates[candidates.length - 1];
      if (!candidate) return { status: 'error', error: 'resume checkpoint has no candidate' };
      artifact = candidate.artifact;
    } else {
      const workPrompt = firstWork ? `【原始需求】\n${prompt}\n\n请按你的角色职责处理。` : `【原始需求】\n${prompt}\n\n【上游产物】\n${upstreamArtifact}\n\n请按你的角色职责继续。`;
      const outcome = await invoke(node, workPrompt, revision + 1, { mode: 'fresh', persistActive: false });
      if (outcome.status !== 'ok') return outcome.status === 'aborted' ? { status: 'aborted' } : { status: 'error', error: outcome.error ?? `${node.id} failed` };
      workerSessionId = outcome.sessionId;
      artifact = outcome.finalText ?? '';
      if (!artifact) return { status: 'error', error: `work '${node.id}' produced empty output; cannot enter evaluation` };
      firstWork = false;
      candidate = makeCandidate(); candidates.push(candidate);
      emitBoth({ type: 'candidate_produced', runId, branchId: 'main', candidate, timestamp: Date.now() });
    }
    const gates = graph.edges.filter((e): e is Extract<GraphV5Edge, { kind: 'gate' }> => e.kind === 'gate' && e.source === node.id && isEdgeActive(e, plan.lane, plan.routeDecision.risk)).sort((a, b) => a.order - b.order);
    const gateCounts: Record<string, number> = laneResume ? { ...laneResume.checkpoint.gateCounts } : {};
    let gateIndex = laneResume?.checkpoint.gateIndex ?? 0;
    if (laneResume) {
      emitBoth({ type: 'run_resumed', runId, branchId: 'main', gateId: gates[gateIndex]?.id ?? 'unknown' });
      if (laneResume.action === 'fail') return { status: 'error', error: `run failed by user at gate '${gates[gateIndex]?.id ?? 'unknown'}'` };
      if (laneResume.action === 'continue_best') {
        degraded = true;
        const skipped = gates[gateIndex]?.id;
        if (skipped && !unresolvedGateIds.includes(skipped)) unresolvedGateIds.push(skipped);
        gateIndex++;
      } else {
        // revise_once：用暂停前存储的 evaluation 触发一次修订，新 candidate 从首个 gate 重审。
        const resumedGate = gates[gateIndex];
        const evaluation = resumedGate ? candidate.evaluations[resumedGate.id] : undefined;
        if (!evaluation) return { status: 'error', error: 'resume checkpoint evaluation missing' };
        revision++;
        const revised = await invoke(node, revisionPrompt(prompt, candidate.artifact, evaluation), revision + 1, workerSessionId ? { mode: 'resume', sessionId: workerSessionId, persistActive: false } : { mode: 'fresh', persistActive: false });
        if (revised.status !== 'ok') return revised.status === 'aborted' ? { status: 'aborted' } : { status: 'error', error: revised.error ?? `${node.id} revision failed` };
        workerSessionId = revised.sessionId ?? workerSessionId; artifact = revised.finalText ?? '';
        if (!artifact) return { status: 'error', error: `work '${node.id}' empty revision output` };
        candidate = makeCandidate(); candidates.push(candidate);
        emitBoth({ type: 'candidate_produced', runId, branchId: 'main', gateId: resumedGate?.id, candidate, timestamp: Date.now() });
        gateIndex = 0;
      }
    }
    while (gateIndex < gates.length) {
      if (signal?.aborted) return { status: 'aborted' };
      const gate = gates[gateIndex];
      const decision = byId.get(gate.target);
      if (!decision || decision.type !== 'decision') return { status: 'error', error: `gate '${gate.id}' decision missing` };
      const rubric = opts.rubrics?.[decision.id]?.rubric ?? readDecisionRubric(projectId, decision as Parameters<typeof readDecisionRubric>[1]);
      emitBoth({ type: 'gate_status', runId, branchId: 'main', gateId: gate.id, status: 'running', timestamp: Date.now() });
      let evaluation: Evaluation | null = null;
      let evaluatorMalformed = false;
      for (let attempt = 0; attempt < 2 && !evaluation; attempt++) {
        const evaluated = await invoke(decision, evaluatorPrompt(prompt, candidate.artifact, candidate.id, rubric), attempt + 1, { mode: 'fresh', persistActive: false });
        if (evaluated.status === 'aborted') return { status: 'aborted' };
        if (evaluated.status !== 'ok') continue;
        try { evaluation = extractEvaluation(evaluated.finalText ?? '', candidate.id, rubric); } catch { /* malformed retry */ }
      }
      if (!evaluation) { evaluatorMalformed = true; evaluation = { candidateId: candidate.id, verdict: 'blocked', reason: 'evaluator returned malformed output twice', missingRequirements: [] }; }
      candidate.evaluations[gate.id] = evaluation;
      emitBoth({ type: 'evaluation_done', runId, branchId: 'main', gateId: gate.id, decisionNodeId: decision.id, evaluation, timestamp: Date.now() });
      if (evaluation.verdict === 'approve') { emitBoth({ type: 'gate_status', runId, branchId: 'main', gateId: gate.id, status: 'approved', timestamp: Date.now() }); gateIndex++; continue; }
      const policy: ExhaustedPolicy = opts.gatePolicyOverrides?.[gate.id] ?? gate.onExhausted;
      if (evaluation.verdict === 'blocked') {
        emitBoth({ type: 'gate_status', runId, branchId: 'main', gateId: gate.id, status: 'blocked', timestamp: Date.now() });
        emitBoth({ type: 'gate_blocked', runId, branchId: 'main', gateId: gate.id, candidateId: candidate.id, reason: evaluation.reason, timestamp: Date.now() });
        emitBoth({ type: 'candidate_rejected', runId, branchId: 'main', gateId: gate.id, candidateId: candidate.id, verdict: 'blocked', timestamp: Date.now() });
        if (gate.onBlocked === 'fail') return { status: 'error', error: `gate '${gate.id}' blocked: ${evaluation.reason}` };
        const bestBlocked = selectBest(candidates, gate.id, rubric);
        const allowedBlocked: ResumeAction[] = bestBlocked ? ['continue_best', 'revise_once', 'fail'] : ['revise_once', 'fail'];
        return pause(gate.id, { branchId: 'main', plan, routeDecision: plan.routeDecision, nodeId: node.id, upstreamArtifact, candidates, currentCandidateId: bestBlocked?.id ?? candidate.id, ...(workerSessionId ? { workerSessionId } : {}), gateIndex, gateCounts, degraded, unresolvedGateIds, exhausted, allowedActions: allowedBlocked, pauseReason: evaluatorMalformed ? 'malformed' : 'blocked', ...(bestBlocked ? { bestCandidateId: bestBlocked.id } : {}) });
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
      if (policy === 'fail') return { status: 'error', error: `gate '${gate.id}' exhausted (fail policy)` };
      // ask_user 或无 best → durable pause；continue_best + 有 best → 自动 best-effort 放行（不暂停）。
      const allowedExhausted: ResumeAction[] = best ? ['continue_best', 'revise_once', 'fail'] : ['revise_once', 'fail'];
      if (policy === 'ask_user' || !best) {
        return pause(gate.id, { branchId: 'main', plan, routeDecision: plan.routeDecision, nodeId: node.id, upstreamArtifact, candidates, currentCandidateId: best?.id ?? candidate.id, ...(workerSessionId ? { workerSessionId } : {}), gateIndex, gateCounts, degraded, unresolvedGateIds, exhausted: true, allowedActions: allowedExhausted, pauseReason: 'exhausted', ...(best ? { bestCandidateId: best.id } : {}) });
      }
      if (!unresolvedGateIds.includes(gate.id)) unresolvedGateIds.push(gate.id);
      exhausted = true; bestCandidateId = best.id;
      candidate = best; artifact = best.artifact; degraded = true; gateIndex++;
    }
    upstreamArtifact = candidate.artifact; bestCandidateId = candidate.id;
    laneResume = undefined;
    nodeId = activeForward(node.id)?.target;
  }
  void exec;
  return { status: degraded ? 'best_effort' : 'completed', output: upstreamArtifact, termination: degraded ? 'best_effort' : 'completed', quality: { status: degraded ? 'best_effort' : 'approved', exhausted, ...(bestCandidateId ? { bestCandidateId } : {}), unresolvedGateIds } };
}
