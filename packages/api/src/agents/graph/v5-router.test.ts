import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walkV5Graph, resumeV5Graph, resumeV5Clarify } from './V5Router.js';
import { parseDurableCheckpoint, isV5GateCheckpoint, type V5GateCheckpoint, type V5ClarifyCheckpoint } from './checkpoint.js';
import { getDefaultV5ProjectGraph } from './v5-workspace.js';
import type { ExecNode, ExecuteOptions } from './AgentRouter.js';
import type { GraphV5 } from './graph.js';
import type { Rubric, Evaluation } from './evaluation.js';
import type { PublicGraphEvent, PersistedRunEvent } from '../../infrastructure/websocket/SocketManager.js';
import type { RouteDecision } from './routing.js';

const rubric: Rubric = { schemaVersion: 1, name: 'quality', criteria: [{ id: 'correct', description: 'correct', required: true, weight: 1 }] };

function v5Graph(): GraphV5 {
  return {
    schemaVersion: 5, inputNode: '__input__', endNode: '__end__', maxNodeExecutions: 80,
    nodes: [
      { id: '__input__', type: 'input' },
      { id: 'router', type: 'router', agentNodeKey: 'opencode:project-router', policyRef: 'router-policy.json' },
      { id: 'responder', type: 'agent', agentNodeKey: 'opencode:responder' },
      { id: 'investigator', type: 'agent', agentNodeKey: 'opencode:investigator' },
      { id: 'implementer', type: 'agent', agentNodeKey: 'opencode:implementer' },
      { id: 'code-review', type: 'decision', agentNodeKey: 'codex:code-review', rubricRef: 'rubric.json' },
      { id: '__end__', type: 'end' },
    ],
    edges: [
      { id: 'in->router', source: '__input__', target: 'router', kind: 'forward' },
      { id: 'route-answer', source: 'router', target: 'responder', kind: 'route', lanes: ['direct_answer'] },
      { id: 'route-investigate', source: 'router', target: 'investigator', kind: 'route', lanes: ['investigate'] },
      { id: 'route-small', source: 'router', target: 'implementer', kind: 'route', lanes: ['small_change'] },
      { id: 'responder->end', source: 'responder', target: '__end__', kind: 'forward' },
      { id: 'investigator->end', source: 'investigator', target: '__end__', kind: 'forward' },
      { id: 'impl->end', source: 'implementer', target: '__end__', kind: 'forward', lanes: ['small_change'] },
      { id: 'gate-code', source: 'implementer', target: 'code-review', kind: 'gate', order: 1, maxRevisions: 1, onExhausted: 'ask_user', onBlocked: 'ask_user', lanes: ['small_change'] },
      { id: 'rework-code', source: 'code-review', target: 'implementer', kind: 'rework' },
    ],
  };
}

function scored(candidateId: string, verdict: 'approve' | 'revise'): Evaluation {
  return { candidateId, verdict, score: verdict === 'approve' ? 95 : 60, confidence: 0.9, criteria: [{ id: 'correct', passed: verdict === 'approve', severity: verdict === 'approve' ? 'info' : 'blocking', evidence: 'checked' }], feedback: verdict === 'approve' ? 'ok' : 'fix it' };
}

const decision = (lane: RouteDecision['lane'], over: Partial<RouteDecision> = {}): RouteDecision => ({ schemaVersion: 1, lane, confidence: 0.9, risk: 'low', sideEffects: 'none', reason: 'r', missingRequirements: [], ...over });

function v5Exec(routerQueue: RouteDecision[], decisions: Record<string, ('approve' | 'revise' | 'malformed')[]> = {}, agentOutputs: Record<string, string[]> = {}) {
  const calls: { nodeId: string; policy: string }[] = [];
  const rq = [...routerQueue];
  const exec: ExecNode = async (node, _prompt, _opts, ctx) => {
    calls.push({ nodeId: node.id, policy: ctx.sessionPolicy.mode });
    if (node.type === 'router') {
      const d = rq.shift() ?? decision('direct_answer');
      return { status: 'ok' as const, finalText: JSON.stringify(d), sessionId: 'router-s' };
    }
    if (node.type === 'decision') {
      const candidateId = /candidateId 必须为 ([^.。\s]+)/.exec(_prompt)?.[1] ?? '';
      const v = decisions[node.id]?.shift() ?? 'approve';
      if (v === 'malformed') return { status: 'ok' as const, finalText: 'not json' };
      return { status: 'ok' as const, finalText: JSON.stringify(scored(candidateId, v)) };
    }
    const q = agentOutputs[node.id];
    const out = q && q.length ? q.shift()! : `${node.id}-artifact`;
    return { status: 'ok' as const, finalText: out, sessionId: `${node.id}-session` };
  };
  return { exec, calls };
}

async function run(graph: GraphV5, exec: ExecNode, intentMode: 'auto' | 'answer' | 'inspect' | 'change' = 'auto') {
  const publicEvents: PublicGraphEvent[] = [];
  const persisted: PersistedRunEvent[] = [];
  const rubrics = Object.fromEntries(graph.nodes.filter((n) => n.type === 'decision').map((n) => [n.id, { rubricRef: n.rubricRef!, hash: 'test', rubric }] as const));
  const opts: ExecuteOptions = { runId: 'run-v5', projectId: 'test-project', emit: (e) => publicEvents.push(e), record: (e) => persisted.push(e), rubrics };
  await walkV5Graph('implement feature', graph, opts, exec, intentMode);
  return { publicEvents, persisted };
}

describe('V5 Router + Coordinator runner', () => {
  it('direct_answer routes to responder and finishes without gates', async () => {
    const scripted = v5Exec([decision('direct_answer')]);
    const { publicEvents } = await run(v5Graph(), scripted.exec);
    const plan = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_plan_created' }> => e.type === 'run_plan_created');
    assert.equal(plan?.lane, 'direct_answer');
    assert.equal(plan?.entryNodeId, 'responder');
    assert.deepEqual(plan?.gateNodeIds, []);
    const done = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_done' }> => e.type === 'run_done');
    assert.equal(done?.termination, 'completed');
    assert.equal(done?.finalText, 'responder-artifact');
    // 不经 code-review
    assert.equal(scripted.calls.some((c) => c.nodeId === 'code-review'), false);
  });

  it('clarify lane pauses as pauseKind:clarify (durable, not terminal)', async () => {
    const scripted = v5Exec([decision('clarify', { missingRequirements: ['need repo path'] })]);
    const { publicEvents } = await run(v5Graph(), scripted.exec);
    const paused = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_paused'; pauseKind: 'clarify' }> => e.type === 'run_paused' && e.pauseKind === 'clarify');
    assert.ok(paused);
    assert.deepEqual(paused?.missingRequirements, ['need repo path']);
    assert.equal(publicEvents.some((e) => e.type === 'run_done'), false); // paused, 未 done
    assert.equal(publicEvents.some((e) => e.type === 'run_plan_created'), false);
  });

  it('small_change runs the code gate and completes on approve', async () => {
    const scripted = v5Exec([decision('small_change', { sideEffects: 'project_write', risk: 'medium' })], { 'code-review': ['approve'] });
    const { publicEvents } = await run(v5Graph(), scripted.exec);
    const plan = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_plan_created' }> => e.type === 'run_plan_created');
    assert.equal(plan?.lane, 'small_change');
    assert.deepEqual(plan?.gateNodeIds, ['gate-code']);
    const done = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_done' }> => e.type === 'run_done');
    assert.equal(done?.termination, 'completed');
    assert.equal(done?.quality?.status, 'approved');
    assert.ok(scripted.calls.some((c) => c.nodeId === 'code-review'));
  });

  it('low confidence invokes Investigator then reroutes once', async () => {
    const scripted = v5Exec([decision('investigate', { confidence: 0.2 }), decision('direct_answer', { confidence: 0.9 })]);
    const { publicEvents } = await run(v5Graph(), scripted.exec);
    // investigator 被调用
    assert.ok(scripted.calls.some((c) => c.nodeId === 'investigator'));
    // router 被调用两次（初次 + reroute）
    assert.equal(scripted.calls.filter((c) => c.nodeId === 'router').length, 2);
    const plan = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_plan_created' }> => e.type === 'run_plan_created');
    assert.equal(plan?.rerouted, true);
    assert.equal(plan?.lane, 'direct_answer');
  });

  it('malformed Router twice falls back to investigate then clarify after failed reroute', async () => {
    // router 返回非 JSON 两次 → 兜底 investigate(confidence 0) → Investigator 调研 → reroute 仍坏 → clarify(needs_input)
    const scripted = v5Exec([]);
    const origExec = scripted.exec;
    const wrapped: ExecNode = async (node, prompt, opts, ctx) => {
      if (node.type === 'router') return { status: 'ok', finalText: 'not json at all', sessionId: 'r' };
      return origExec(node, prompt, opts, ctx);
    };
    const { publicEvents } = await run(v5Graph(), wrapped);
    // investigator 被调用（兜底调研）
    assert.ok(scripted.calls.some((c) => c.nodeId === 'investigator'));
    // reroute 失败 → clarify → durable pause（不发 run_plan_created，不发 run_done）
    const paused = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_paused'; pauseKind: 'clarify' }> => e.type === 'run_paused' && e.pauseKind === 'clarify');
    assert.ok(paused);
    assert.equal(publicEvents.some((e) => e.type === 'run_plan_created'), false);
  });
});

describe('V5 default workspace template lanes', () => {
  async function runTemplate(routerQueue: RouteDecision[], decisions: Record<string, ('approve' | 'revise' | 'malformed')[]>, agentOutputs: Record<string, string[]> = {}) {
    const scripted = v5Exec(routerQueue, decisions, agentOutputs);
    const publicEvents: PublicGraphEvent[] = [];
    const persisted: PersistedRunEvent[] = [];
    const graph = getDefaultV5ProjectGraph();
    const rubrics = Object.fromEntries(graph.nodes.filter((n) => n.type === 'decision').map((n) => [n.id, { rubricRef: n.rubricRef!, hash: 'test', rubric }] as const));
    const opts: ExecuteOptions = { runId: 'run-v5tpl', projectId: 'test-project', emit: (e) => publicEvents.push(e), record: (e) => persisted.push(e), rubrics };
    await walkV5Graph('implement feature', graph, opts, scripted.exec, 'auto');
    return { publicEvents, calls: scripted.calls };
  }

  it('small_change skips the Security Reviewer gate (planned_change-only)', async () => {
    const { publicEvents, calls } = await runTemplate(
      [decision('small_change', { sideEffects: 'project_write', risk: 'medium' })],
      { 'code-review': ['approve'], verify: ['approve'] },
      { implementer: ['impl-artifact'] },
    );
    assert.equal(calls.some((c) => c.nodeId === 'security-review'), false);
    assert.equal(calls.some((c) => c.nodeId === 'code-review'), true);
    assert.equal(calls.some((c) => c.nodeId === 'verify'), true);
    const done = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_done' }> => e.type === 'run_done');
    assert.equal(done?.termination, 'completed');
  });

  it('planned_change runs Architect → Plan Review → Implementer → Code/Security/Verify', async () => {
    const { calls } = await runTemplate(
      [decision('planned_change', { sideEffects: 'project_write', risk: 'high' })],
      { 'plan-review': ['approve'], 'code-review': ['approve'], 'security-review': ['approve'], verify: ['approve'] },
      { architect: ['plan-artifact'], implementer: ['impl-artifact'] },
    );
    assert.deepEqual(calls.map((c) => c.nodeId).filter((id) => ['architect', 'plan-review', 'implementer', 'code-review', 'security-review', 'verify'].includes(id)),
      ['architect', 'plan-review', 'implementer', 'code-review', 'security-review', 'verify']);
  });
});

describe('V5 durable gate pause/resume', () => {
  function checkpointOf(persisted: PersistedRunEvent[]): V5GateCheckpoint | undefined {
    const cp = [...persisted].reverse().find((e) => e.type === 'branch_checkpoint');
    return cp && cp.type === 'branch_checkpoint' ? parseDurableCheckpoint(cp.payload) as V5GateCheckpoint : undefined;
  }
  function resumeOpts(events: { publicEvents: PublicGraphEvent[]; persisted: PersistedRunEvent[] }, exec: ExecNode): ExecuteOptions {
    const rubrics = Object.fromEntries(v5Graph().nodes.filter((n) => n.type === 'decision').map((n) => [n.id, { rubricRef: n.rubricRef!, hash: 'test', rubric }] as const));
    return { runId: 'run-v5', projectId: 'test-project', emit: (e) => events.publicEvents.push(e), record: (e) => events.persisted.push(e), rubrics };
  }

  it('gate exhausted (ask_user) pauses with best → continue_best/revise_once/fail', async () => {
    const scripted = v5Exec([decision('small_change', { sideEffects: 'project_write', risk: 'medium' })], { 'code-review': ['revise', 'revise'] }, { implementer: ['impl-artifact'] });
    const { publicEvents, persisted } = await run(v5Graph(), scripted.exec);
    const paused = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_paused' }> => e.type === 'run_paused');
    assert.equal(paused?.pauseKind, 'gate');
    assert.deepEqual(paused?.options, ['continue_best', 'revise_once', 'fail']);
    assert.equal(publicEvents.some((e) => e.type === 'run_done'), false); // paused, 未 done
    const cp = checkpointOf(persisted);
    assert.equal(cp?.pauseReason, 'exhausted');
    assert.equal(isV5GateCheckpoint(cp!), true);
    assert.ok(cp?.bestCandidateId);
  });

  it('gate blocked (malformed) pauses without best → revise_once/fail only', async () => {
    const scripted = v5Exec([decision('small_change', { sideEffects: 'project_write', risk: 'medium' })], { 'code-review': ['malformed', 'malformed'] });
    const { publicEvents, persisted } = await run(v5Graph(), scripted.exec);
    const paused = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_paused' }> => e.type === 'run_paused');
    assert.equal(paused?.pauseKind, 'gate');
    assert.deepEqual(paused?.options, ['revise_once', 'fail']); // blocked candidate 被排除 → 无 best
    const cp = checkpointOf(persisted);
    assert.equal(cp?.pauseReason, 'malformed');
    assert.equal(cp?.bestCandidateId, undefined);
  });

  it('resume continue_best skips the gate and completes best_effort', async () => {
    const scripted = v5Exec([decision('small_change', { sideEffects: 'project_write', risk: 'medium' })], { 'code-review': ['revise', 'revise'] }, { implementer: ['impl-artifact'] });
    const { persisted } = await run(v5Graph(), scripted.exec);
    const cp = checkpointOf(persisted)!;
    const ev: { publicEvents: PublicGraphEvent[]; persisted: PersistedRunEvent[] } = { publicEvents: [], persisted: [] };
    await resumeV5Graph('implement feature', v5Graph(), resumeOpts(ev, scripted.exec), cp, 'continue_best', scripted.exec);
    assert.ok(ev.publicEvents.some((e) => e.type === 'run_resumed'));
    const done = ev.publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_done' }> => e.type === 'run_done');
    assert.equal(done?.termination, 'best_effort');
    assert.equal(done?.quality?.status, 'best_effort');
    assert.ok(done?.quality?.unresolvedGateIds?.includes('gate-code'));
  });

  it('resume fail returns run_error', async () => {
    const scripted = v5Exec([decision('small_change', { sideEffects: 'project_write', risk: 'medium' })], { 'code-review': ['revise', 'revise'] }, { implementer: ['impl-artifact'] });
    const { persisted } = await run(v5Graph(), scripted.exec);
    const cp = checkpointOf(persisted)!;
    const ev: { publicEvents: PublicGraphEvent[]; persisted: PersistedRunEvent[] } = { publicEvents: [], persisted: [] };
    await resumeV5Graph('implement feature', v5Graph(), resumeOpts(ev, scripted.exec), cp, 'fail', scripted.exec);
    assert.ok(ev.publicEvents.some((e) => e.type === 'run_error'));
  });

  it('resume revise_once re-invokes work and re-evaluates from first gate → completed', async () => {
    const scripted = v5Exec([decision('small_change', { sideEffects: 'project_write', risk: 'medium' })], { 'code-review': ['revise', 'revise'] }, { implementer: ['impl-artifact'] });
    const { persisted } = await run(v5Graph(), scripted.exec);
    const cp = checkpointOf(persisted)!;
    const scripted2 = v5Exec([], { 'code-review': ['approve'] }, { implementer: ['impl-revised'] });
    const ev: { publicEvents: PublicGraphEvent[]; persisted: PersistedRunEvent[] } = { publicEvents: [], persisted: [] };
    await resumeV5Graph('implement feature', v5Graph(), resumeOpts(ev, scripted2.exec), cp, 'revise_once', scripted2.exec);
    assert.ok(scripted2.calls.some((c) => c.nodeId === 'implementer')); // work 被重新调用
    const done = ev.publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_done' }> => e.type === 'run_done');
    assert.equal(done?.termination, 'completed'); // approve → completed
  });
});

describe('V5 durable clarify pause/resume', () => {
  function clarifyCpOf(persisted: PersistedRunEvent[]): V5ClarifyCheckpoint | undefined {
    const cp = [...persisted].reverse().find((e) => e.type === 'branch_checkpoint');
    return cp && cp.type === 'branch_checkpoint' ? parseDurableCheckpoint(cp.payload) as V5ClarifyCheckpoint : undefined;
  }
  function resumeOpts2(events: { publicEvents: PublicGraphEvent[]; persisted: PersistedRunEvent[] }): ExecuteOptions {
    const rubrics = Object.fromEntries(v5Graph().nodes.filter((n) => n.type === 'decision').map((n) => [n.id, { rubricRef: n.rubricRef!, hash: 'test', rubric }] as const));
    return { runId: 'run-v5', projectId: 'test-project', emit: (e) => events.publicEvents.push(e), record: (e) => events.persisted.push(e), rubrics };
  }

  it('clarify resume with userResponse re-routes to a lane and completes', async () => {
    const scripted = v5Exec([decision('clarify', { missingRequirements: ['need path'] })]);
    const { persisted } = await run(v5Graph(), scripted.exec);
    const cp = clarifyCpOf(persisted)!;
    assert.equal(cp.clarificationAttempts, 0);
    // resume：Router 补充信息后改判 direct_answer → responder → end
    const scripted2 = v5Exec([decision('direct_answer', { confidence: 0.9 })]);
    const ev: { publicEvents: PublicGraphEvent[]; persisted: PersistedRunEvent[] } = { publicEvents: [], persisted: [] };
    await resumeV5Clarify('implement feature', v5Graph(), resumeOpts2(ev), cp, 'the path is /repo', scripted2.exec);
    const done = ev.publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_done' }> => e.type === 'run_done');
    assert.equal(done?.termination, 'completed');
    assert.equal(done?.finalText, 'responder-artifact');
  });

  it('clarify resume still clarify → pauses again (attempts=1); 2nd still clarify → run_error (max 2)', async () => {
    // 初始 clarify(attempts=0)
    const scripted = v5Exec([decision('clarify', { missingRequirements: ['x'] })]);
    const { persisted } = await run(v5Graph(), scripted.exec);
    const cp0 = clarifyCpOf(persisted)!;
    // 第一次 resume：Router 仍 clarify → 暂停(attempts=1)
    const scripted2 = v5Exec([decision('clarify', { missingRequirements: ['y'] })]);
    const ev1: { publicEvents: PublicGraphEvent[]; persisted: PersistedRunEvent[] } = { publicEvents: [], persisted: [] };
    await resumeV5Clarify('implement feature', v5Graph(), resumeOpts2(ev1), cp0, 'partial', scripted2.exec);
    const cp1 = clarifyCpOf(ev1.persisted)!;
    assert.equal(cp1.clarificationAttempts, 1);
    assert.ok(ev1.publicEvents.some((e) => e.type === 'run_paused' && e.pauseKind === 'clarify'));
    // 第二次 resume：Router 仍 clarify → attempts=2 → run_error
    const scripted3 = v5Exec([decision('clarify', { missingRequirements: ['z'] })]);
    const ev2: { publicEvents: PublicGraphEvent[]; persisted: PersistedRunEvent[] } = { publicEvents: [], persisted: [] };
    await resumeV5Clarify('implement feature', v5Graph(), resumeOpts2(ev2), cp1, 'more', scripted3.exec);
    assert.ok(ev2.publicEvents.some((e) => e.type === 'run_error'));
  });

  it('unsupported lane stays terminal needs_input (not durable pause)', async () => {
    const scripted = v5Exec([decision('unsupported', { reason: 'out of scope' })]);
    const { publicEvents } = await run(v5Graph(), scripted.exec);
    assert.equal(publicEvents.some((e) => e.type === 'run_paused'), false);
    const done = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_done' }> => e.type === 'run_done');
    assert.equal(done?.termination, 'needs_input');
  });
});
