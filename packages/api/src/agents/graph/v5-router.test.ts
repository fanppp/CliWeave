import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walkV5Graph } from './V5Router.js';
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

  it('clarify lane ends as needs_input', async () => {
    const scripted = v5Exec([decision('clarify', { missingRequirements: ['need repo path'] })]);
    const { publicEvents } = await run(v5Graph(), scripted.exec);
    const done = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_done' }> => e.type === 'run_done');
    assert.equal(done?.termination, 'needs_input');
    assert.ok(done?.finalText?.includes('need repo path'));
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
    // reroute 失败 → clarify → needs_input，不发 run_plan_created
    const done = publicEvents.find((e): e is Extract<PublicGraphEvent, { type: 'run_done' }> => e.type === 'run_done');
    assert.equal(done?.termination, 'needs_input');
    assert.equal(publicEvents.some((e) => e.type === 'run_plan_created'), false);
  });
});
