import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walkEvaluatorOptimizerGraph, resumeEvaluatorOptimizerGraph, verifyCheckpointToken, type HarnessCheckpoint } from './EvaluatorOptimizerRouter.js';
import type { ExecNode, ExecuteOptions } from './AgentRouter.js';
import type { GraphV4 } from './graph.js';
import type { Evaluation, Rubric } from './evaluation.js';
import type { PersistedRunEvent, PublicGraphEvent } from '../../infrastructure/websocket/SocketManager.js';

const rubric: Rubric = { schemaVersion: 1, name: 'quality', criteria: [{ id: 'correct', description: 'correct', required: true, weight: 1 }] };

function formalGraph(overrides: Partial<Record<'plan' | 'code' | 'verify', { maxRevisions: number; onExhausted: 'ask_user' | 'continue_best' | 'fail' }>> = {}): GraphV4 {
  const gate = (id: 'plan' | 'code' | 'verify', source: string, target: string, order: number) => ({
    id: `gate-${id}`, source, target, kind: 'gate' as const, order,
    maxRevisions: overrides[id]?.maxRevisions ?? 2,
    onExhausted: overrides[id]?.onExhausted ?? 'fail' as const,
    onBlocked: 'fail' as const,
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

function scriptedExec(decisions: Record<string, ('approve' | 'revise' | 'malformed')[]>) {
  const calls: { nodeId: string; policy: string; prompt: string }[] = [];
  const workCount = new Map<string, number>();
  const exec: ExecNode = async (node, prompt, _opts, context) => {
    calls.push({ nodeId: node.id, policy: context.sessionPolicy.mode, prompt });
    if (node.type === 'decision') {
      const candidateId = /candidateId 必须为 ([^.。\s]+)/.exec(prompt)?.[1] ?? '';
      const verdict = decisions[node.id]?.shift() ?? 'approve';
      return { status: 'ok', finalText: verdict === 'malformed' ? 'not json' : JSON.stringify(scored(candidateId, verdict)) };
    }
    const count = (workCount.get(node.id) ?? 0) + 1; workCount.set(node.id, count);
    return { status: 'ok', finalText: `${node.id}-artifact-${count}`, sessionId: `${node.id}-session` };
  };
  return { exec, calls, workCount };
}

async function run(graph: GraphV4, exec: ExecNode) {
  const publicEvents: PublicGraphEvent[] = [];
  const persisted: PersistedRunEvent[] = [];
  const rubrics = Object.fromEntries(graph.nodes.filter((n) => n.type === 'decision').map((n) => [n.id, { rubricRef: n.rubricRef, hash: 'test', rubric }]));
  const opts: ExecuteOptions = { runId: 'run-v4', projectId: 'test-project', emit: (e) => publicEvents.push(e), record: (e) => persisted.push(e), rubrics };
  await walkEvaluatorOptimizerGraph('implement feature', graph, opts, exec);
  return { publicEvents, persisted, opts };
}

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
    const checkpointEvent = first.persisted.find((e): e is Extract<PersistedRunEvent, { type: 'branch_checkpoint' }> => e.type === 'branch_checkpoint');
    const checkpoint = checkpointEvent?.payload as HarnessCheckpoint;
    assert.equal(verifyCheckpointToken(checkpoint, paused!.resumeToken), true);
    assert.equal(verifyCheckpointToken({ ...checkpoint, expiresAt: Date.now() - 1 }, paused!.resumeToken), false);

    const resumedPublic: PublicGraphEvent[] = [];
    await resumeEvaluatorOptimizerGraph('implement feature', formalGraph({ plan: { maxRevisions: 0, onExhausted: 'ask_user' } }), { ...first.opts, emit: (e) => resumedPublic.push(e), record: () => undefined }, checkpoint, 'continue_best', scripted.exec);
    assert.equal(resumedPublic.some((e) => e.type === 'run_resumed'), true);
    assert.equal(resumedPublic.some((e) => e.type === 'run_done'), true);
  });
});
