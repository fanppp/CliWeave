import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walkEvaluatorOptimizerGraph, resumeEvaluatorOptimizerGraph, verifyCheckpointToken, isAllowedResumeAction, type HarnessCheckpoint } from './EvaluatorOptimizerRouter.js';
import type { ExecNode, ExecuteOptions } from './AgentRouter.js';
import type { GraphV4 } from './graph.js';
import type { Evaluation, Rubric } from './evaluation.js';
import type { PersistedRunEvent, PublicGraphEvent } from '../../infrastructure/websocket/SocketManager.js';

const rubric: Rubric = { schemaVersion: 1, name: 'quality', criteria: [{ id: 'correct', description: 'correct', required: true, weight: 1 }] };

function formalGraph(overrides: Partial<Record<'plan' | 'code' | 'verify', { maxRevisions: number; onExhausted: 'ask_user' | 'continue_best' | 'fail'; onBlocked?: 'ask_user' | 'fail' }>> = {}): GraphV4 {
  const gate = (id: 'plan' | 'code' | 'verify', source: string, target: string, order: number) => ({
    id: `gate-${id}`, source, target, kind: 'gate' as const, order,
    maxRevisions: overrides[id]?.maxRevisions ?? 2,
    onExhausted: overrides[id]?.onExhausted ?? 'fail' as const,
    onBlocked: overrides[id]?.onBlocked ?? 'ask_user' as const,
  });
  return {
    schemaVersion: 4, inputNode: '__input__', endNode: '__end__', maxNodeExecutions: 80,
    nodes: [
      { id: '__input__', type: 'input' },
      { id: 'architect', type: 'agent', agentNodeKey: 'opencode:architect' },
      { id: 'plan-review', type: 'decision', agentNodeKey: 'codex:plan-review', rubricRef: 'rubric.json' },
      { id: 'implementer', type: 'agent', agentNodeKey: 'opencode:implementer' },
      { id: 'code-review', type: 'decision', agentNodeKey: 'codex:code-review', rubricRef: 'rubric.json' },
      { id: 'verify', type: 'decision', agentNodeKey: 'claude:verify', rubricRef: 'rubric.json' },
      { id: '__end__', type: 'end' },
    ],
    edges: [
      { id: 'branch-main', source: '__input__', target: 'architect', kind: 'forward' },
      { id: 'architect-to-implementer', source: 'architect', target: 'implementer', kind: 'forward' },
      { id: 'implementer-to-end', source: 'implementer', target: '__end__', kind: 'forward' },
      gate('plan', 'architect', 'plan-review', 1),
      { id: 'rework-plan', source: 'plan-review', target: 'architect', kind: 'rework' },
      gate('code', 'implementer', 'code-review', 1),
      { id: 'rework-code', source: 'code-review', target: 'implementer', kind: 'rework' },
      gate('verify', 'implementer', 'verify', 2),
      { id: 'rework-verify', source: 'verify', target: 'implementer', kind: 'rework' },
    ],
  };
}

function scored(candidateId: string, verdict: 'approve' | 'revise'): Evaluation {
  return { candidateId, verdict, score: verdict === 'approve' ? 95 : 60, confidence: 0.9, criteria: [{ id: 'correct', passed: verdict === 'approve', severity: verdict === 'approve' ? 'info' : 'blocking', evidence: 'checked' }], feedback: verdict === 'approve' ? 'ok' : 'fix it' };
}

function scriptedExec(decisions: Record<string, ('approve' | 'revise' | 'malformed' | 'blocked')[]>, workScripts: Record<string, string[]> = {}) {
  const calls: { nodeId: string; policy: string; prompt: string }[] = [];
  const workCount = new Map<string, number>();
  const exec: ExecNode = async (node, prompt, _opts, context) => {
    calls.push({ nodeId: node.id, policy: context.sessionPolicy.mode, prompt });
    if (node.type === 'decision') {
      const candidateId = /candidateId 必须为 ([^.。\s]+)/.exec(prompt)?.[1] ?? '';
      const verdict = decisions[node.id]?.shift() ?? 'approve';
      if (verdict === 'malformed') return { status: 'ok' as const, finalText: 'not json' };
      if (verdict === 'blocked') return { status: 'ok' as const, finalText: JSON.stringify({ candidateId, verdict: 'blocked', reason: 'no repo', missingRequirements: ['repo'] }) };
      return { status: 'ok' as const, finalText: JSON.stringify(scored(candidateId, verdict)) };
    }
    const count = (workCount.get(node.id) ?? 0) + 1; workCount.set(node.id, count);
    const script = workScripts[node.id];
    if (script && script.length) return { status: 'ok' as const, finalText: script.shift()!, sessionId: `${node.id}-session` };
    return { status: 'ok' as const, finalText: `${node.id}-artifact-${count}`, sessionId: `${node.id}-session` };
  };
  return { exec, calls, workCount };
}

async function run(graph: GraphV4, exec: ExecNode, extra: Partial<ExecuteOptions> = {}) {
  const publicEvents: PublicGraphEvent[] = [];
  const persisted: PersistedRunEvent[] = [];
  const rubrics = Object.fromEntries(graph.nodes.filter((n) => n.type === 'decision').map((n) => [n.id, { rubricRef: n.rubricRef, hash: 'test', rubric }] as const));
  const opts: ExecuteOptions = { runId: 'run-v4', projectId: 'test-project', emit: (e) => publicEvents.push(e), record: (e) => persisted.push(e), rubrics, ...extra };
  await walkEvaluatorOptimizerGraph('implement feature', graph, opts, exec);
  return { publicEvents, persisted, opts };
}

function checkpointOf(persisted: PersistedRunEvent[], branchId = 'branch-main'): HarnessCheckpoint | undefined {
  const ev = [...persisted].reverse().find((e) => e.type === 'branch_checkpoint' && e.branchId === branchId);
  return ev?.type === 'branch_checkpoint' ? ev.payload as HarnessCheckpoint : undefined;
}

const finishBlock = (artifact: string, category = 'simple_answer', reason = 'done') =>
  `${artifact}\nROUTE: FINISH\nROUTE_CATEGORY: ${category}\nROUTE_REASON: ${reason}`;
const controlOnly = (category = 'simple_answer', reason = 'done') =>
  `ROUTE: FINISH\nROUTE_CATEGORY: ${category}\nROUTE_REASON: ${reason}`;

describe('V4 Evaluator-Optimizer runner', () => {
  it('runs Plan Review, then Code Review, then Verify in order', async () => {
    const scripted = scriptedExec({ 'plan-review': ['approve'], 'code-review': ['approve'], verify: ['approve'] });
    const { publicEvents } = await run(formalGraph(), scripted.exec);
    assert.deepEqual(scripted.calls.map((c) => c.nodeId), ['architect', 'plan-review', 'implementer', 'code-review', 'verify']);
    assert.equal(publicEvents.find((e) => e.type === 'run_done')?.type, 'run_done');
  });

  it('Plan reject resumes Architect and re-evaluates before implementation', async () => {
    const scripted = scriptedExec({ 'plan-review': ['revise', 'approve'], 'code-review': ['approve'], verify: ['approve'] });
    await run(formalGraph(), scripted.exec);
    assert.deepEqual(scripted.calls.map((c) => c.nodeId), ['architect', 'plan-review', 'architect', 'plan-review', 'implementer', 'code-review', 'verify']);
    assert.deepEqual(scripted.calls.filter((c) => c.nodeId === 'architect').map((c) => c.policy), ['fresh', 'resume']);
  });

  it('Verify reject returns to Implementer and the revised candidate restarts at Code Review', async () => {
    const scripted = scriptedExec({ 'plan-review': ['approve'], 'code-review': ['approve', 'approve'], verify: ['revise', 'approve'] });
    await run(formalGraph(), scripted.exec);
    assert.deepEqual(scripted.calls.map((c) => c.nodeId), ['architect', 'plan-review', 'implementer', 'code-review', 'verify', 'implementer', 'code-review', 'verify']);
    assert.deepEqual(scripted.calls.filter((c) => c.nodeId === 'implementer').map((c) => c.policy), ['fresh', 'resume']);
  });

  it('uses the last scored candidate as best-effort when a gate has zero revision budget', async () => {
    const scripted = scriptedExec({ 'plan-review': ['approve'], 'code-review': ['revise'], verify: ['approve'] });
    const { publicEvents } = await run(formalGraph({ code: { maxRevisions: 0, onExhausted: 'continue_best' } }), scripted.exec);
    const done = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_done' }> => e.type === 'run_done');
    assert.equal(done?.termination, 'best_effort');
    assert.equal(scripted.workCount.get('implementer'), 1);
  });

  it('persists only a token hash, supports resume, and rejects expired tokens', async () => {
    const scripted = scriptedExec({ 'plan-review': ['revise'] });
    const first = await run(formalGraph({ plan: { maxRevisions: 0, onExhausted: 'ask_user' } }), scripted.exec);
    const paused = first.publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_paused' }> => e.type === 'run_paused');
    assert.ok(paused?.resumeToken);
    assert.ok(!JSON.stringify(first.persisted).includes(paused!.resumeToken));
    const checkpoint = checkpointOf(first.persisted);
    assert.ok(checkpoint);
    assert.equal(verifyCheckpointToken(checkpoint!, paused!.resumeToken), true);
    assert.equal(verifyCheckpointToken({ ...checkpoint!, expiresAt: Date.now() - 1 }, paused!.resumeToken), false);

    const resumedPublic: PublicGraphEvent[] = [];
    await resumeEvaluatorOptimizerGraph('implement feature', formalGraph({ plan: { maxRevisions: 0, onExhausted: 'ask_user' } }), { ...first.opts, emit: (e) => resumedPublic.push(e), record: () => undefined }, checkpoint!, 'continue_best', scripted.exec);
    assert.equal(resumedPublic.some((e) => e.type === 'run_resumed'), true);
    assert.equal(resumedPublic.some((e) => e.type === 'run_done'), true);
  });
});

describe('V4.1 completion hardening (auto mode)', () => {
  it('1+1 finishes at the Architect without entering Plan Reviewer', async () => {
    const scripted = scriptedExec({}, { architect: [finishBlock('2', 'simple_answer', 'arithmetic answered')] });
    const { publicEvents } = await run(formalGraph(), scripted.exec, { runMode: 'auto' });
    assert.deepEqual(scripted.calls.map((c) => c.nodeId), ['architect']);
    const done = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_done' }> => e.type === 'run_done');
    assert.equal(done?.termination, 'early_complete');
    assert.equal(done?.finalText, '2');
    assert.equal(publicEvents.some((e) => e.type === 'candidate_produced'), false);
  });

  it('control-only output triggers a completion retry, not Plan Reviewer', async () => {
    const scripted = scriptedExec({}, { architect: [controlOnly('simple_answer', 'done'), finishBlock('answer', 'simple_answer', 'done')] });
    const { publicEvents } = await run(formalGraph(), scripted.exec, { runMode: 'auto' });
    assert.deepEqual(scripted.calls.map((c) => c.nodeId), ['architect', 'architect']);
    const done = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_done' }> => e.type === 'run_done');
    assert.equal(done?.termination, 'early_complete');
    assert.equal(done?.finalText, 'answer');
    // 两次 route_decided：第一次 empty_artifact，第二次 ok
    const routes = publicEvents.filter((e) => e.type === 'route_decided');
    assert.equal(routes.length, 2);
  });

  it('still-empty artifact after retry → run_error, no candidate', async () => {
    const scripted = scriptedExec({}, { architect: [controlOnly('simple_answer', 'x'), controlOnly('simple_answer', 'y')] });
    const { publicEvents } = await run(formalGraph(), scripted.exec, { runMode: 'auto' });
    assert.deepEqual(scripted.calls.map((c) => c.nodeId), ['architect', 'architect']);
    assert.equal(publicEvents.some((e) => e.type === 'run_error'), true);
    assert.equal(publicEvents.some((e) => e.type === 'candidate_produced'), false);
  });

  it('engineering request claiming FINISH change forwards into Plan Reviewer (unsafe_category)', async () => {
    const scripted = scriptedExec({ 'plan-review': ['approve'] }, { architect: ['plan\nROUTE: FINISH\nROUTE_CATEGORY: change\nROUTE_REASON: should forward'] });
    const { publicEvents } = await run(formalGraph(), scripted.exec, { runMode: 'auto' });
    assert.ok(scripted.calls.map((c) => c.nodeId).includes('plan-review'));
    const route = publicEvents.find((e) => e.type === 'route_decided');
    assert.equal(route?.decision, 'forward');
    assert.equal(publicEvents.some((e) => e.type === 'run_done'), true);
  });

  it('any empty work output never enters the Decision (full mode, empty implementer)', async () => {
    const scripted = scriptedExec({ 'plan-review': ['approve'], 'code-review': ['approve'], verify: ['approve'] }, { implementer: [''] });
    const { publicEvents } = await run(formalGraph(), scripted.exec, { runMode: 'full' });
    assert.equal(publicEvents.some((e) => e.type === 'run_error'), true);
    // implementer 之后的 gate（code-review / verify）不得被评估；仅 architect 的 plan-review 被评估。
    assert.equal(scripted.calls.some((c) => c.nodeId === 'code-review' || c.nodeId === 'verify'), false);
    assert.equal(publicEvents.filter((e) => e.type === 'evaluation_done').length, 1);
  });
});

describe('V4.2 blocked / best-candidate resume actions', () => {
  it('blocked with no best candidate → only revise_once|fail (forbids continue_best)', async () => {
    const scripted = scriptedExec({ 'plan-review': ['blocked'] });
    const { publicEvents, persisted } = await run(formalGraph(), scripted.exec);
    const paused = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_paused' }> => e.type === 'run_paused');
    assert.ok(paused);
    assert.deepEqual(paused!.options, ['revise_once', 'fail']);
    const checkpoint = checkpointOf(persisted);
    assert.deepEqual(checkpoint?.allowedActions, ['revise_once', 'fail']);
    assert.equal(checkpoint?.bestCandidateId, undefined);
    assert.equal(checkpoint?.pauseReason, 'blocked');
    assert.equal(isAllowedResumeAction(checkpoint!, 'continue_best'), false);
    assert.equal(isAllowedResumeAction(checkpoint!, 'revise_once'), true);
  });

  it('blocked with a historical best candidate → allows continue_best', async () => {
    const scripted = scriptedExec({ 'plan-review': ['revise', 'blocked'] });
    const { publicEvents, persisted } = await run(formalGraph(), scripted.exec);
    const paused = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_paused' }> => e.type === 'run_paused');
    assert.ok(paused);
    assert.deepEqual(paused!.options, ['continue_best', 'revise_once', 'fail']);
    const checkpoint = checkpointOf(persisted);
    assert.deepEqual(checkpoint?.allowedActions, ['continue_best', 'revise_once', 'fail']);
    assert.ok(checkpoint?.bestCandidateId);
    assert.equal(isAllowedResumeAction(checkpoint!, 'continue_best'), true);
  });

  it('exhausted ask_user with a best → allows continue_best', async () => {
    const scripted = scriptedExec({ 'plan-review': ['revise'] });
    const { publicEvents, persisted } = await run(formalGraph({ plan: { maxRevisions: 0, onExhausted: 'ask_user' } }), scripted.exec);
    const checkpoint = checkpointOf(persisted);
    assert.deepEqual(checkpoint?.allowedActions, ['continue_best', 'revise_once', 'fail']);
    assert.ok(checkpoint?.bestCandidateId);
    assert.equal(checkpoint?.pauseReason, 'exhausted');
    assert.equal(publicEvents.some((e) => e.type === 'run_paused'), true);
  });

  it('malformed evaluator twice → paused with pauseReason malformed', async () => {
    const scripted = scriptedExec({ 'plan-review': ['malformed', 'malformed'] });
    const { publicEvents, persisted } = await run(formalGraph(), scripted.exec);
    const checkpoint = checkpointOf(persisted);
    assert.equal(checkpoint?.pauseReason, 'malformed');
    assert.equal(publicEvents.some((e) => e.type === 'run_paused'), true);
  });

  it('resume rejects a disallowed action via isAllowedResumeAction', () => {
    const noBest: HarnessCheckpoint = {
      schemaVersion: 1, prompt: '', branchId: 'b', workNodeId: 'w', upstreamArtifact: '',
      candidates: [], currentCandidateId: 'c', gateIndex: 0, gateCounts: {}, degraded: false,
      tokenHash: 'x', expiresAt: Date.now() + 1000, allowedActions: ['revise_once', 'fail'], pauseReason: 'blocked',
    };
    assert.equal(isAllowedResumeAction(noBest, 'continue_best'), false);
    assert.equal(isAllowedResumeAction(noBest, 'fail'), true);
    // 旧 checkpoint 无 allowedActions → 回退允许全部三种
    const legacy: HarnessCheckpoint = { ...noBest, allowedActions: undefined as unknown as string[] } as HarnessCheckpoint;
    assert.equal(isAllowedResumeAction(legacy, 'continue_best'), true);
  });
});
