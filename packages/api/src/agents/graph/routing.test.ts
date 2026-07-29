import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRouteDecision, validateRouteDecision, resolveCapabilityProfile, resolveLanePlan, routerPrompt, type RouteDecision, type RouteValidation } from './routing.js';
import type { GraphV5 } from './graph.js';

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
