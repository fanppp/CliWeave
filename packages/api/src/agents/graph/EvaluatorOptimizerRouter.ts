import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { formatInstanceKey } from '../instance-key.js';
import type { SessionPolicy } from '../session-policy.js';
import type { AgentMessage } from '../types.js';
import { AUTO_ROUTE_INSTRUCTION, completionRetryPrompt, extractCompletion } from './completion.js';
import { evaluatorPrompt, extractEvaluation, readDecisionRubric, revisionPrompt, selectBest, type Candidate, type Evaluation } from './evaluation.js';
import type { ExhaustedPolicy, GraphV4 } from './graph.js';
import type { ExecNode, ExecuteOptions } from './AgentRouter.js';
import type { RunQuality } from '../../infrastructure/websocket/SocketManager.js';

export interface HarnessCheckpoint {
  runner: 'v4';
  kind: 'gate';
  schemaVersion: 1;
  prompt: string;
  branchId: string;
  workNodeId: string;
  upstreamArtifact: string;
  candidates: Candidate[];
  currentCandidateId: string;
  workerSessionId?: string;
  gateIndex: number;
  gateCounts: Record<string, number>;
  degraded: boolean;
  nextForwardNodeId?: string;
  tokenHash: string;
  expiresAt: number;
  /** V4.2: 该 checkpoint 允许的恢复动作（无 best 时不允许 continue_best）。Resume API 须校验 action ∈ allowedActions。 */
  allowedActions: ResumeAction[];
  bestCandidateId?: string;
  pauseReason: 'exhausted' | 'blocked' | 'malformed';
  /** V4.3: resume 时延续的未解决 gate 与 exhausted 标记（continue_best 保留未解决 gate）。 */
  unresolvedGateIds?: string[];
  exhausted?: boolean;
}

type BranchResult = { status: 'completed' | 'early_complete' | 'best_effort'; output: string; quality: RunQuality } | { status: 'paused' } | { status: 'error'; error: string } | { status: 'aborted' };

const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

export type ResumeAction = 'continue_best' | 'revise_once' | 'fail';

export function verifyCheckpointToken(checkpoint: HarnessCheckpoint, token: string): boolean {
  if (checkpoint.expiresAt < Date.now()) return false;
  const actual = Buffer.from(tokenHash(token), 'hex');
  const expected = Buffer.from(checkpoint.tokenHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** V4.2: 校验 resume action ∈ checkpoint.allowedActions（无 best 时禁止 continue_best）。旧 checkpoint 无 allowedActions 时回退允许全部三种。 */
export function isAllowedResumeAction(checkpoint: HarnessCheckpoint, action: string): boolean {
  const allowed = checkpoint.allowedActions ?? (['continue_best', 'revise_once', 'fail'] as ResumeAction[]);
  return allowed.includes(action as ResumeAction);
}

export async function walkEvaluatorOptimizerGraph(prompt: string, graph: GraphV4, opts: ExecuteOptions, exec: ExecNode, resume?: { checkpoint: HarnessCheckpoint; action: ResumeAction }, startNodeId?: string): Promise<void> {
  const { runId, projectId, emit, record, signal } = opts;
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  let totalExec = 0;
  let finished = false;
  const emitBoth = (event: Parameters<typeof emit>[0]): void => { emit(event); record?.(event); };
  const finish = (event: Parameters<typeof emit>[0]): void => { if (!finished) { finished = true; emitBoth(event); } };
  const input = byId.get(graph.inputNode);
  if (!input || input.type !== 'input') { finish({ type: 'run_error', runId, error: 'invalid V4 input node' }); return; }
  if (!resume) {
    emitBoth({ type: 'node_started', runId, nodeId: input.id });
    emitBoth({ type: 'node_message', runId, nodeId: input.id, message: { type: 'text', nodeId: input.id, content: prompt, timestamp: Date.now() } as AgentMessage });
    emitBoth({ type: 'node_done', runId, nodeId: input.id });
  }

  const forwardFrom = (nodeId: string) => graph.edges.find((e) => e.kind === 'forward' && e.source === nodeId);
  const inputEdges: Extract<GraphV4['edges'][number], { kind: 'forward' }>[] = resume
    ? [{ id: resume.checkpoint.branchId, source: input.id, target: resume.checkpoint.workNodeId, kind: 'forward' }]
    : startNodeId
      ? [{ id: `manual-${startNodeId}`, source: input.id, target: startNodeId, kind: 'forward' }]
      : graph.edges.filter((e): e is Extract<GraphV4['edges'][number], { kind: 'forward' }> => e.kind === 'forward' && e.source === input.id);

  async function invoke(node: Extract<GraphV4['nodes'][number], { type: 'agent' | 'decision' }>, nodePrompt: string, iteration: number, policy: SessionPolicy) {
    if (++totalExec > graph.maxNodeExecutions) return { status: 'error' as const, error: `exceeded maxNodeExecutions ${graph.maxNodeExecutions}` };
    const instanceKey = formatInstanceKey(projectId, node.agentNodeKey);
    emitBoth({ type: 'node_iteration', runId, nodeId: node.id, iteration, instanceKey });
    return exec(node, (opts.contextPrefix ?? '') + nodePrompt, opts, { iteration, sessionPolicy: policy });
  }

  async function pause(branchId: string, gateId: string, checkpoint: Omit<HarnessCheckpoint, 'schemaVersion' | 'tokenHash' | 'expiresAt' | 'runner' | 'kind'>): Promise<BranchResult> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    const payload: HarnessCheckpoint = { runner: 'v4', kind: 'gate', schemaVersion: 1, ...checkpoint, tokenHash: tokenHash(token), expiresAt };
    record?.({ type: 'branch_checkpoint', runId, branchId, payload });
    record?.({ type: 'run_state', runId, phase: 'paused', payload: { branchId, gateId, status: 'paused', pauseReason: payload.pauseReason, allowedActions: payload.allowedActions, ...(payload.bestCandidateId ? { bestCandidateId: payload.bestCandidateId } : {}) } });
    emit({ type: 'run_paused', runId, projectId, branchId, pauseKind: 'gate', gateId, question: '审核预算耗尽或评估阻塞，请选择后续动作', options: payload.allowedActions, resumeToken: token, expiresAt });
    return { status: 'paused' };
  }

  async function walkBranch(branchEdge: Extract<GraphV4['edges'][number], { kind: 'forward' }>): Promise<BranchResult> {
    const branchId = branchEdge.id;
    let branchResume = resume?.checkpoint.branchId === branchId ? resume : undefined;
    let nodeId = branchResume?.checkpoint.workNodeId ?? branchEdge.target;
    let upstreamArtifact = branchResume?.checkpoint.upstreamArtifact ?? prompt;
    let firstWork = !branchResume;
    let degraded = branchResume?.checkpoint.degraded ?? false;
    // V4.3: 跟踪未解决 gate / exhausted / bestCandidateId，供 run_done + Thread turn 质量摘要。
    let unresolvedGateIds: string[] = branchResume ? [...(branchResume.checkpoint.unresolvedGateIds ?? [])] : [];
    let exhausted = branchResume?.checkpoint.exhausted ?? false;
    let bestCandidateId: string | undefined;
    const branchQuality = (): RunQuality => ({ status: degraded ? 'best_effort' : 'approved', exhausted, ...(bestCandidateId ? { bestCandidateId } : {}), unresolvedGateIds });
    while (true) {
      if (signal?.aborted) return { status: 'aborted' };
      const node = byId.get(nodeId);
      if (!node || node.type === 'end') return { status: degraded ? 'best_effort' : 'completed', output: upstreamArtifact, quality: branchQuality() };
      if (node.type !== 'agent') return { status: 'error', error: `main chain target '${nodeId}' is not work` };

      let revision = branchResume ? Math.max(...branchResume.checkpoint.candidates.map((c) => c.revision)) : 0;
      let workerSessionId: string | undefined = branchResume?.checkpoint.workerSessionId;
      let artifact = '';
      const candidates: Candidate[] = branchResume ? [...branchResume.checkpoint.candidates] : [];
      const makeCandidate = (): Candidate => ({ id: randomUUID(), branchId, workNodeId: node.id, revision, artifact, evaluations: {} });
      let candidate: Candidate;
      if (branchResume) {
        const resumedCandidateId = branchResume.checkpoint.currentCandidateId;
        candidate = candidates.find((c) => c.id === resumedCandidateId) ?? candidates[candidates.length - 1];
        if (!candidate) return { status: 'error', error: 'resume checkpoint has no candidate' };
        artifact = candidate.artifact;
      } else {
        let workPrompt = firstWork ? `【原始需求】\n${prompt}\n\n请按你的角色职责处理。` : `【原始需求】\n${prompt}\n\n【上游产物】\n${upstreamArtifact}\n\n请按你的角色职责继续。`;
        if (firstWork && (opts.runMode ?? 'full') === 'auto') workPrompt += AUTO_ROUTE_INSTRUCTION;
        const outcome = await invoke(node, workPrompt, revision + 1, { mode: 'fresh', persistActive: false });
        if (outcome.status !== 'ok') return outcome.status === 'aborted' ? { status: 'aborted' } : { status: 'error', error: outcome.error ?? `${node.id} failed` };
        workerSessionId = outcome.sessionId;
        artifact = outcome.finalText ?? '';
        if (firstWork && (opts.runMode ?? 'full') === 'auto') {
          let routed = extractCompletion(artifact);
          emitBoth({ type: 'route_decided', runId, branchId, nodeId: node.id, claim: routed.claim, decision: routed.decision, reason: routed.reason, timestamp: Date.now() });
          // V4.1: 模型声明 FINISH/CLARIFY 但 artifact 为空 → 定向重试一次，要求补完整答案 + 控制块。
          if (routed.claim && (routed.claim.action === 'finish' || routed.claim.action === 'clarify') && routed.diagnostic === 'empty_artifact') {
            const retried = await invoke(node, completionRetryPrompt(prompt), revision + 2, { mode: 'fresh', persistActive: false });
            if (retried.status !== 'ok') return retried.status === 'aborted' ? { status: 'aborted' } : { status: 'error', error: retried.error ?? `${node.id} completion retry failed` };
            workerSessionId = retried.sessionId ?? workerSessionId;
            artifact = retried.finalText ?? '';
            routed = extractCompletion(artifact);
            emitBoth({ type: 'route_decided', runId, branchId, nodeId: node.id, claim: routed.claim, decision: routed.decision, reason: routed.reason, timestamp: Date.now() });
            if (routed.claim && (routed.claim.action === 'finish' || routed.claim.action === 'clarify') && routed.diagnostic === 'empty_artifact') {
              return { status: 'error', error: `work '${node.id}' produced empty artifact after completion retry` };
            }
          }
          artifact = routed.artifact;
          if (routed.decision === 'finish' || routed.decision === 'clarify') {
            if (!artifact) return { status: 'error', error: `work '${node.id}' empty ${routed.decision} artifact` };
            emitBoth({ type: 'branch_done', runId, branchId, cause: routed.decision === 'finish' ? 'early_complete' : 'needs_input', finalArtifact: artifact, timestamp: Date.now() });
            return { status: 'early_complete', output: artifact, quality: branchQuality() };
          }
        }
        // V4.1: 任意 work 空输出都不得进入 Decision。
        if (!artifact) return { status: 'error', error: `work '${node.id}' produced empty output; cannot enter evaluation` };
        firstWork = false;
        candidate = makeCandidate(); candidates.push(candidate);
        emitBoth({ type: 'candidate_produced', runId, branchId, candidate, timestamp: Date.now() });
      }
      const gates = graph.edges.filter((e): e is Extract<GraphV4['edges'][number], { kind: 'gate' }> => e.kind === 'gate' && e.source === node.id).sort((a, b) => a.order - b.order);
      const gateCounts: Record<string, number> = branchResume ? { ...branchResume.checkpoint.gateCounts } : {};
      let gateIndex = branchResume?.checkpoint.gateIndex ?? 0;
      if (branchResume) {
        emitBoth({ type: 'run_resumed', runId, branchId, gateId: gates[gateIndex]?.id ?? 'unknown' });
        if (branchResume.action === 'fail') return { status: 'error', error: `run failed by user at gate '${gates[gateIndex]?.id ?? 'unknown'}'` };
        if (branchResume.action === 'continue_best') { degraded = true; const skipped = gates[gateIndex]?.id; if (skipped && !unresolvedGateIds.includes(skipped)) unresolvedGateIds.push(skipped); gateIndex++; }
        else {
          const evaluation = candidate.evaluations[gates[gateIndex]?.id ?? ''];
          if (!evaluation) return { status: 'error', error: 'resume checkpoint evaluation missing' };
          revision++;
          const revised = await invoke(node, revisionPrompt(prompt, candidate.artifact, evaluation), revision + 1, workerSessionId ? { mode: 'resume', sessionId: workerSessionId, persistActive: false } : { mode: 'fresh', persistActive: false });
          if (revised.status !== 'ok') return revised.status === 'aborted' ? { status: 'aborted' } : { status: 'error', error: revised.error ?? `${node.id} revision failed` };
          workerSessionId = revised.sessionId ?? workerSessionId; artifact = revised.finalText ?? '';
          candidate = makeCandidate(); candidates.push(candidate);
          emitBoth({ type: 'candidate_produced', runId, branchId, gateId: gates[gateIndex]?.id, candidate, timestamp: Date.now() });
          gateIndex = 0;
        }
      }
      while (gateIndex < gates.length) {
        const gate = gates[gateIndex];
        const decision = byId.get(gate.target);
        if (!decision || decision.type !== 'decision') return { status: 'error', error: `gate '${gate.id}' decision missing` };
        const rubric = opts.rubrics?.[decision.id]?.rubric ?? readDecisionRubric(projectId, decision);
        emitBoth({ type: 'gate_status', runId, branchId, gateId: gate.id, status: 'running', timestamp: Date.now() });
        let evaluation: Evaluation | null = null;
        let evaluatorMalformed = false;
        for (let attempt = 0; attempt < 2 && !evaluation; attempt++) {
          const evaluated = await invoke(decision, evaluatorPrompt(prompt, candidate.artifact, candidate.id, rubric), attempt + 1, { mode: 'fresh', persistActive: false });
          if (evaluated.status === 'aborted') return { status: 'aborted' };
          if (evaluated.status !== 'ok') continue;
          try { evaluation = extractEvaluation(evaluated.finalText ?? '', candidate.id, rubric); } catch { /* malformed: one fresh retry */ }
        }
        if (!evaluation) {
          evaluatorMalformed = true;
          evaluation = { candidateId: candidate.id, verdict: 'blocked', reason: 'evaluator returned malformed output twice', missingRequirements: [] };
        }
        candidate.evaluations[gate.id] = evaluation;
        emitBoth({ type: 'evaluation_done', runId, branchId, gateId: gate.id, decisionNodeId: decision.id, evaluation, timestamp: Date.now() });
        if (evaluation.verdict === 'approve') {
          emitBoth({ type: 'gate_status', runId, branchId, gateId: gate.id, status: 'approved', timestamp: Date.now() });
          gateIndex++;
          continue;
        }
        const policy: ExhaustedPolicy = opts.gatePolicyOverrides?.[gate.id] ?? gate.onExhausted;
        if (evaluation.verdict === 'blocked') {
          emitBoth({ type: 'gate_status', runId, branchId, gateId: gate.id, status: 'blocked', timestamp: Date.now() });
          emitBoth({ type: 'gate_blocked', runId, branchId, gateId: gate.id, candidateId: candidate.id, reason: evaluation.verdict === 'blocked' ? evaluation.reason : 'blocked', timestamp: Date.now() });
          emitBoth({ type: 'candidate_rejected', runId, branchId, gateId: gate.id, candidateId: candidate.id, verdict: 'blocked', timestamp: Date.now() });
          if (gate.onBlocked === 'fail') return { status: 'error', error: `gate '${gate.id}' blocked: ${evaluation.reason}` };
          const bestBlocked = selectBest(candidates, gate.id, rubric);
          const allowedBlocked: ResumeAction[] = bestBlocked ? ['continue_best', 'revise_once', 'fail'] : ['revise_once', 'fail'];
          return pause(branchId, gate.id, { prompt, branchId, workNodeId: node.id, upstreamArtifact, candidates, currentCandidateId: bestBlocked?.id ?? candidate.id, ...(workerSessionId ? { workerSessionId } : {}), gateIndex, gateCounts, degraded, nextForwardNodeId: forwardFrom(node.id)?.target, pauseReason: evaluatorMalformed ? 'malformed' : 'blocked', allowedActions: allowedBlocked, ...(bestBlocked ? { bestCandidateId: bestBlocked.id } : {}), unresolvedGateIds, exhausted });
        }
        const used = gateCounts[gate.id] ?? 0;
        if (used < gate.maxRevisions) {
          emitBoth({ type: 'candidate_rejected', runId, branchId, gateId: gate.id, candidateId: candidate.id, verdict: 'revise', timestamp: Date.now() });
          gateCounts[gate.id] = used + 1;
          revision++;
          const revised = await invoke(node, revisionPrompt(prompt, candidate.artifact, evaluation), revision + 1, workerSessionId ? { mode: 'resume', sessionId: workerSessionId, persistActive: false } : { mode: 'fresh', persistActive: false });
          if (revised.status !== 'ok') return revised.status === 'aborted' ? { status: 'aborted' } : { status: 'error', error: revised.error ?? `${node.id} revision failed` };
          workerSessionId = revised.sessionId ?? workerSessionId;
          artifact = revised.finalText ?? '';
          candidate = makeCandidate(); candidates.push(candidate);
          emitBoth({ type: 'candidate_produced', runId, branchId, gateId: gate.id, candidate, timestamp: Date.now() });
          gateIndex = 0; // 任一 gate reject 后，新 candidate 从第一个 gate 重审
          continue;
        }
        emitBoth({ type: 'gate_status', runId, branchId, gateId: gate.id, status: 'exhausted', timestamp: Date.now() });
        const best = selectBest(candidates, gate.id, rubric);
        if (best) emitBoth({ type: 'best_candidate_selected', runId, branchId, gateId: gate.id, candidateId: best.id, timestamp: Date.now() });
        if (policy === 'fail') return { status: 'error', error: `gate '${gate.id}' exhausted (fail policy)` };
        // V4.2: 无 best → 只允许 revise_once|fail（禁 continue_best）；有 best → 允许 continue_best。
        const allowedExhausted: ResumeAction[] = best ? ['continue_best', 'revise_once', 'fail'] : ['revise_once', 'fail'];
        if (policy === 'ask_user' || !best) {
          return pause(branchId, gate.id, { prompt, branchId, workNodeId: node.id, upstreamArtifact, candidates, currentCandidateId: best?.id ?? candidate.id, ...(workerSessionId ? { workerSessionId } : {}), gateIndex, gateCounts, degraded, nextForwardNodeId: forwardFrom(node.id)?.target, pauseReason: 'exhausted', allowedActions: allowedExhausted, ...(best ? { bestCandidateId: best.id } : {}), unresolvedGateIds, exhausted: true });
        }
        // policy === 'continue_best' 且有 best → 自动 best-effort 放行（不暂停）。
        if (!unresolvedGateIds.includes(gate.id)) unresolvedGateIds.push(gate.id);
        exhausted = true;
        bestCandidateId = best.id;
        candidate = best; artifact = best.artifact; degraded = true; gateIndex++;
      }
      upstreamArtifact = candidate.artifact;
      bestCandidateId = candidate.id;
      branchResume = undefined;
      const next = forwardFrom(node.id);
      if (!next) return { status: degraded ? 'best_effort' : 'completed', output: upstreamArtifact, quality: branchQuality() };
      nodeId = next.target;
    }
  }

  const results = await Promise.all(inputEdges.map(walkBranch));
  if (results.some((r) => r.status === 'paused')) return;
  if (results.some((r) => r.status === 'aborted')) { finish({ type: 'run_aborted', runId }); return; }
  const error = results.find((r): r is Extract<BranchResult, { status: 'error' }> => r.status === 'error');
  if (error) { finish({ type: 'run_error', runId, error: error.error }); return; }
  const outputs = results.filter((r): r is Extract<BranchResult, { output: string }> => 'output' in r).map((r) => r.output).filter(Boolean);
  const finalText = outputs.join('\n\n---\n\n');
  if (!finalText) { finish({ type: 'run_error', runId, error: 'no V4 producer artifact' }); return; }
  const termination = results.some((r) => r.status === 'best_effort') ? 'best_effort' : results.every((r) => r.status === 'early_complete') ? 'early_complete' : 'completed';
  // V4.3: 聚合分支质量摘要（payload 是下游唯一主体；quality 独立元数据，Thread turn 同时保存）。
  const completed = results.filter((r): r is Extract<BranchResult, { quality: RunQuality }> => 'quality' in r);
  const bestId = completed.map((r) => r.quality.bestCandidateId).find(Boolean);
  const quality: RunQuality | undefined = completed.length ? {
    status: completed.some((r) => r.quality.status === 'best_effort') ? 'best_effort' : 'approved',
    exhausted: completed.some((r) => r.quality.exhausted),
    unresolvedGateIds: completed.flatMap((r) => r.quality.unresolvedGateIds),
    ...(bestId ? { bestCandidateId: bestId } : {}),
  } : undefined;
  finish({ type: 'run_done', runId, finalText, termination, ...(quality ? { quality } : {}) });
}

export async function resumeEvaluatorOptimizerGraph(prompt: string, graph: GraphV4, opts: ExecuteOptions, checkpoint: HarnessCheckpoint, action: ResumeAction, exec: ExecNode): Promise<void> {
  return walkEvaluatorOptimizerGraph(prompt, graph, opts, exec, { checkpoint, action });
}
