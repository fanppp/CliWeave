import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRouteDecision, validateRouteDecision, resolveCapabilityProfile, resolveLanePlan, resolveDownstreamPlan, normalizeRunEntry, routerPrompt, type RouteDecision, type RouteValidation } from './routing.js';
import type { GraphV5, AnyGraph } from './graph.js';

const rd = (lane: RouteDecision['lane'], over: Partial<RouteDecision> = {}): RouteDecision => ({
  schemaVersion: 1, lane, confidence: 0.9, risk: 'low', sideEffects: 'none', reason: 'r', missingRequirements: [], ...over,
});

function v5Graph(): GraphV5 {
  return {
    schemaVersion: 5, inputNode: '__input__', endNode: '__end__', maxNodeExecutions: 80,
    nodes: [
      { id: '__input__', type: 'input' },
      { id: 'router', type: 'router', agentNodeKey: 'opencode:project-router', policyRef: 'router-policy.json' },
      { id: 'responder', type: 'agent', agentNodeKey: 'opencode:responder' },
      { id: 'implementer', type: 'agent', agentNodeKey: 'opencode:implementer' },
      { id: 'code-review', type: 'decision', agentNodeKey: 'codex:code-review', rubricRef: 'rubric.json' },
      { id: '__end__', type: 'end' },
    ],
    edges: [
      { id: 'in->router', source: '__input__', target: 'router', kind: 'forward' },
      { id: 'route-answer', source: 'router', target: 'responder', kind: 'route', lanes: ['direct_answer'] },
      { id: 'route-small', source: 'router', target: 'implementer', kind: 'route', lanes: ['small_change'] },
      { id: 'responder->end', source: 'responder', target: '__end__', kind: 'forward' },
      { id: 'impl->end', source: 'implementer', target: '__end__', kind: 'forward', lanes: ['small_change'] },
      { id: 'gate-code', source: 'implementer', target: 'code-review', kind: 'gate', order: 1, maxRevisions: 1, onExhausted: 'ask_user', onBlocked: 'ask_user', lanes: ['small_change'] },
      { id: 'rework-code', source: 'code-review', target: 'implementer', kind: 'rework' },
    ],
  };
}

describe('RouteDecision contract', () => {
  it('parses a valid RouteDecision JSON', () => {
    const d = parseRouteDecision(JSON.stringify({ schemaVersion: 1, lane: 'direct_answer', confidence: 0.8, risk: 'low', sideEffects: 'none', reason: 'simple q', missingRequirements: [] }));
    assert.equal(d.lane, 'direct_answer');
  });

  it('rejects malformed RouteDecision', () => {
    assert.throws(() => parseRouteDecision('not json'), SyntaxError);
    assert.throws(() => parseRouteDecision(JSON.stringify({ schemaVersion: 1, lane: 'bogus' })), /lane/);
  });

  it('routerPrompt forbids tools and carries the message', () => {
    const p = routerPrompt('hello', '', '', '');
    assert.ok(p.includes('hello'));
    assert.ok(p.includes('不执行工具'));
  });
});

describe('validateRouteDecision (RunCoordinator rules)', () => {
  it('answer intent rejects write lanes and side effects', () => {
    assert.equal(validateRouteDecision(rd('small_change', { sideEffects: 'project_write' }), 'answer').ok, false);
    assert.equal(validateRouteDecision(rd('direct_answer', { sideEffects: 'project_write' }), 'answer').ok, false);
  });

  it('change intent rejects direct_answer', () => {
    assert.equal(validateRouteDecision(rd('direct_answer'), 'change').ok, false);
    assert.equal(validateRouteDecision(rd('planned_change'), 'change').ok, true);
  });

  it('answer→investigate, change→planned_change fallback lanes', () => {
    const r1 = validateRouteDecision(rd('small_change'), 'answer') as Extract<RouteValidation, { ok: false }>;
    assert.equal(r1.fallbackLane, 'investigate');
    const r2 = validateRouteDecision(rd('direct_answer'), 'change') as Extract<RouteValidation, { ok: false }>;
    assert.equal(r2.fallbackLane, 'planned_change');
  });
});

describe('resolveCapabilityProfile', () => {
  it('Implementer gets project read+write; Verifier gets read+test', () => {
    const impl = resolveCapabilityProfile('small_change', 'low');
    assert.equal(impl.projectWrite, true);
    assert.equal(impl.commandExec, 'full_project');
    const ver = resolveCapabilityProfile('verify_only', 'low');
    assert.equal(ver.projectWrite, false);
    assert.equal(ver.commandExec, 'test');
  });

  it('critical risk small_change gates external side effects behind human approval', () => {
    const p = resolveCapabilityProfile('small_change', 'critical');
    assert.equal(p.commandExec, 'test');
    assert.equal(p.externalSideEffects, 'human_approval');
  });
});

describe('resolveLanePlan', () => {
  it('resolves direct_answer to responder→end with no gates', () => {
    const plan = resolveLanePlan(v5Graph(), rd('direct_answer'), false);
    assert.equal(plan.entryNodeId, 'responder');
    assert.equal(plan.endNodeId, '__end__');
    assert.deepEqual(plan.gateNodeIds, []);
    assert.equal(plan.profile.projectWrite, false);
  });

  it('resolves small_change to implementer with the code gate', () => {
    const plan = resolveLanePlan(v5Graph(), rd('small_change'), false);
    assert.equal(plan.entryNodeId, 'implementer');
    assert.deepEqual(plan.gateNodeIds, ['gate-code']);
    assert.equal(plan.profile.projectWrite, true);
  });

  it('throws when no route edge for the lane', () => {
    assert.throws(() => resolveLanePlan(v5Graph(), rd('investigate'), false), /no route edge for lane/);
  });
});

// planned_change 图：architect → implementer，含 code gate + Security gate(minRisk=high)。
function plannedGraph(): GraphV5 {
  return {
    schemaVersion: 5, inputNode: '__input__', endNode: '__end__', maxNodeExecutions: 80,
    nodes: [
      { id: '__input__', type: 'input' },
      { id: 'router', type: 'router', agentNodeKey: 'opencode:project-router', policyRef: 'router-policy.json' },
      { id: 'architect', type: 'agent', agentNodeKey: 'opencode:architect' },
      { id: 'implementer', type: 'agent', agentNodeKey: 'opencode:implementer' },
      { id: 'code-review', type: 'decision', agentNodeKey: 'codex:code-review', rubricRef: 'rubric.json' },
      { id: 'security-review', type: 'decision', agentNodeKey: 'codex:security-review', rubricRef: 'rubric.json' },
      { id: '__end__', type: 'end' },
    ],
    edges: [
      { id: 'in->router', source: '__input__', target: 'router', kind: 'forward' },
      { id: 'route-architect', source: 'router', target: 'architect', kind: 'route', lanes: ['planned_change'] },
      { id: 'route-implementer', source: 'router', target: 'implementer', kind: 'route', lanes: ['small_change'] },
      { id: 'architect->implementer', source: 'architect', target: 'implementer', kind: 'forward', lanes: ['planned_change'] },
      { id: 'implementer->end', source: 'implementer', target: '__end__', kind: 'forward', lanes: ['small_change', 'planned_change'] },
      { id: 'gate-code', source: 'implementer', target: 'code-review', kind: 'gate', order: 1, maxRevisions: 1, onExhausted: 'ask_user', onBlocked: 'ask_user', lanes: ['small_change', 'planned_change'] },
      { id: 'rework-code', source: 'code-review', target: 'implementer', kind: 'rework' },
      { id: 'gate-security', source: 'implementer', target: 'security-review', kind: 'gate', order: 2, maxRevisions: 1, onExhausted: 'ask_user', onBlocked: 'fail', lanes: ['planned_change'], minRisk: 'high' },
      { id: 'rework-security', source: 'security-review', target: 'implementer', kind: 'rework' },
    ],
  };
}

describe('resolveLanePlan risk gating (isEdgeActive minRisk)', () => {
  it('planned_change + medium skips Security gate (risk below minRisk high)', () => {
    const plan = resolveLanePlan(plannedGraph(), rd('planned_change', { risk: 'medium' }), false);
    assert.equal(plan.entryNodeId, 'architect');
    assert.deepEqual(plan.gateNodeIds, ['gate-code']);
  });

  it('planned_change + high/critical must pass Security gate', () => {
    assert.deepEqual(resolveLanePlan(plannedGraph(), rd('planned_change', { risk: 'high' }), false).gateNodeIds, ['gate-code', 'gate-security']);
    assert.deepEqual(resolveLanePlan(plannedGraph(), rd('planned_change', { risk: 'critical' }), false).gateNodeIds, ['gate-code', 'gate-security']);
  });

  it('small_change never activates the planned_change-only Security gate (regardless of risk)', () => {
    assert.deepEqual(resolveLanePlan(plannedGraph(), rd('small_change', { risk: 'critical' }), false).gateNodeIds, ['gate-code']);
    assert.equal(resolveLanePlan(plannedGraph(), rd('small_change', { risk: 'critical' }), false).entryNodeId, 'implementer');
  });

  it('run_plan_created gateNodeIds match runtime walkLane gates (planned_change+medium vs +high)', () => {
    // resolveLanePlan 产出的 gateNodeIds 即 run_plan_created 事件与 walkLane 运行时共用 isEdgeActive 的结果，二者一致。
    const medium = resolveLanePlan(plannedGraph(), rd('planned_change', { risk: 'medium' }), false).gateNodeIds;
    const high = resolveLanePlan(plannedGraph(), rd('planned_change', { risk: 'high' }), false).gateNodeIds;
    assert.deepEqual(medium, ['gate-code']);
    assert.deepEqual(high, ['gate-code', 'gate-security']);
  });
});

describe('resolveDownstreamPlan (manual entry from work node)', () => {
  it('walks from a mid-lane node collecting gates + forward to End', () => {
    const plan = resolveDownstreamPlan(plannedGraph(), 'implementer', 'planned_change', 'high');
    assert.equal(plan.entryNodeId, 'implementer');
    assert.deepEqual(plan.gateNodeIds, ['gate-code', 'gate-security']); // high → security 激活
    assert.equal(plan.endNodeId, '__end__');
  });

  it('skips security gate at medium risk (isEdgeActive minRisk)', () => {
    const plan = resolveDownstreamPlan(plannedGraph(), 'implementer', 'planned_change', 'medium');
    assert.deepEqual(plan.gateNodeIds, ['gate-code']);
  });
});

describe('normalizeRunEntry (RunEntry validation)', () => {
  const v3: AnyGraph = { schemaVersion: 3, inputNode: '__input__', maxNodeExecutions: 50, nodes: [{ id: '__input__', type: 'input' }, { id: 'w', type: 'agent', agentNodeKey: 'opencode:x' }], edges: [{ id: 'e', source: '__input__', target: 'w' }] };

  it('absent → {kind:input} (default, backward compatible)', () => {
    const r1 = normalizeRunEntry(null, v5Graph());
    assert.equal('entry' in r1, true);
    if ('entry' in r1) assert.deepEqual(r1.entry, { kind: 'input' });
    const r2 = normalizeRunEntry(undefined, v5Graph());
    assert.equal('entry' in r2, true);
    if ('entry' in r2) assert.deepEqual(r2.entry, { kind: 'input' });
  });

  it('work node_only accepts an agent node', () => {
    const r = normalizeRunEntry({ kind: 'work', nodeId: 'implementer', mode: 'node_only' }, v5Graph());
    assert.equal('entry' in r, true);
  });

  it('rejects non-agent entry node (decision)', () => {
    const r = normalizeRunEntry({ kind: 'work', nodeId: 'code-review', mode: 'node_only' }, v5Graph()) as { error: string };
    assert.match(r.error, /agent work node/);
  });

  it('rejects downstream on V3 (no gate/forward concept)', () => {
    const r = normalizeRunEntry({ kind: 'work', nodeId: 'w', mode: 'downstream' }, v3) as { error: string };
    assert.match(r.error, /V4 or V5/);
  });

  it('V5 single-lane node auto-derives lane; write lane defaults risk high', () => {
    // v5Graph() implementer 只在 small_change lane
    const r = normalizeRunEntry({ kind: 'work', nodeId: 'implementer', mode: 'downstream' }, v5Graph());
    assert.equal('entry' in r, true);
    if ('entry' in r) {
      assert.equal((r.entry as { lane?: string }).lane, 'small_change');
      assert.equal((r.entry as { risk?: string }).risk, 'high');
    }
  });

  it('V5 multi-lane node requires explicit lane (plannedGraph implementer)', () => {
    const r = normalizeRunEntry({ kind: 'work', nodeId: 'implementer', mode: 'downstream' }, plannedGraph()) as { error: string };
    assert.match(r.error, /lane.*required/);
    const r2 = normalizeRunEntry({ kind: 'work', nodeId: 'implementer', mode: 'downstream', lane: 'small_change' }, plannedGraph());
    assert.equal('entry' in r2, true);
  });

  it('rejects lane not including the node', () => {
    const r = normalizeRunEntry({ kind: 'work', nodeId: 'implementer', mode: 'downstream', lane: 'investigate' }, v5Graph()) as { error: string };
    assert.match(r.error, /does not include node/);
  });

  it('validates artifactRef shape', () => {
    const r = normalizeRunEntry({ kind: 'work', nodeId: 'implementer', mode: 'node_only', artifactRef: { runId: 'r1', source: { kind: 'run_final' }, sha256: 'abc' } }, v5Graph());
    assert.equal('entry' in r, true);
    const bad = normalizeRunEntry({ kind: 'work', nodeId: 'implementer', mode: 'node_only', artifactRef: { runId: 'r1', source: { kind: 'bogus' } } }, v5Graph()) as { error: string };
    assert.match(bad.error, /artifactRef/);
  });
});
