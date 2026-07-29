import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph, validateRunnable, GraphValidationError, isEdgeActive, assertNoSchemaDowngrade, type GraphV5 } from './graph.js';

function v5(over: Partial<Pick<GraphV5, 'nodes' | 'edges'>> = {}): GraphV5 {
  const base: GraphV5 = {
    schemaVersion: 5, inputNode: '__input__', endNode: '__end__', maxNodeExecutions: 80,
    nodes: [
      { id: '__input__', type: 'input' },
      { id: 'router', type: 'router', agentNodeKey: 'opencode:project-router', policyRef: 'router-policy.json' },
      { id: 'responder', type: 'agent', agentNodeKey: 'opencode:responder' },
      { id: 'investigator', type: 'agent', agentNodeKey: 'opencode:investigator' },
      { id: 'implementer', type: 'agent', agentNodeKey: 'opencode:implementer' },
      { id: 'code-review', type: 'decision', agentNodeKey: 'codex:code-review', rubricRef: 'rubric.json' },
      { id: 'knowledge', type: 'project_knowledge' },
      { id: 'scribe', type: 'documenter', agentNodeKey: 'opencode:project-scribe' },
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
      { id: 'observe-scribe', source: 'knowledge', target: 'scribe', kind: 'observe' },
    ],
  };
  return { ...base, ...over };
}

describe('V5 graph validation', () => {
  it('accepts a valid V5 graph with router + lanes + knowledge/observe', () => {
    validateGraph(v5());
    validateRunnable(v5());
  });

  it('rejects zero or multiple router nodes', () => {
    // 零 router：input 直连 responder，无 route 边
    const zero = { schemaVersion: 5 as const, inputNode: '__input__', endNode: '__end__', maxNodeExecutions: 80, nodes: [{ id: '__input__', type: 'input' as const }, { id: 'responder', type: 'agent' as const, agentNodeKey: 'opencode:responder' }, { id: '__end__', type: 'end' as const }], edges: [{ id: 'in->resp', source: '__input__', target: 'responder', kind: 'forward' as const }, { id: 'resp->end', source: 'responder', target: '__end__', kind: 'forward' as const }] } as GraphV5;
    assert.throws(() => validateGraph(zero), /exactly one router/);
    // 多 router
    const multi = { ...v5(), nodes: [...v5().nodes, { id: 'router2', type: 'router' as const, agentNodeKey: 'opencode:project-router2', policyRef: 'router-policy.json' }] } as GraphV5;
    assert.throws(() => validateGraph(multi), /exactly one router/);
  });

  it('rejects input not connecting only to the router', () => {
    const g = v5({ edges: v5().edges.map((e) => e.id === 'in->router' ? { ...e, target: 'responder' } : e) });
    assert.throws(() => validateGraph(g), /input must connect only to the router/);
  });

  it('rejects a lane mapping to multiple route entries', () => {
    const g = v5({ nodes: [...v5().nodes, { id: 'implementer2', type: 'agent', agentNodeKey: 'opencode:implementer2' }], edges: [...v5().edges, { id: 'route-small2', source: 'router', target: 'implementer2', kind: 'route', lanes: ['small_change'] }] });
    assert.throws(() => validateGraph(g), /maps to multiple route/);
  });

  it('rejects knowledge/documenter in the main payload path', () => {
    const g = v5({ edges: v5().edges.map((e) => e.id === 'responder->end' ? { ...e, source: 'knowledge' } : e) });
    assert.throws(() => validateGraph(g), /source must not be project_knowledge/);
  });

  it('rejects observe edge with wrong endpoints', () => {
    const g = v5({ edges: v5().edges.map((e) => e.id === 'observe-scribe' ? { ...e, source: 'responder' } : e) });
    assert.throws(() => validateGraph(g), /observe .* source must be project_knowledge/);
  });

  it('rejects a route edge whose target is not an agent', () => {
    const g = v5({ edges: v5().edges.map((e) => e.id === 'route-answer' ? { ...e, target: '__end__' } : e) });
    assert.throws(() => validateGraph(g), /route .* target must be an agent/);
  });

  it('rejects a lane that does not deterministically reach End', () => {
    const g = v5({ edges: v5().edges.filter((e) => e.id !== 'responder->end') });
    assert.throws(() => validateRunnable(g), /does not deterministically reach End/);
  });

  it('accepts clarify/unsupported lanes without requiring End reachability', () => {
    const g = v5({ edges: [...v5().edges.filter((e) => !e.id.startsWith('route-')), { id: 'route-clarify', source: 'router', target: 'responder', kind: 'route', lanes: ['clarify'] }] });
    validateRunnable(g);
  });
});

describe('isEdgeActive (lanes + minRisk)', () => {
  it('no lanes → active for any lane', () => {
    assert.equal(isEdgeActive({}, 'direct_answer'), true);
    assert.equal(isEdgeActive({}, 'planned_change'), true);
  });
  it('lanes → active only when lane included', () => {
    assert.equal(isEdgeActive({ lanes: ['small_change'] }, 'small_change'), true);
    assert.equal(isEdgeActive({ lanes: ['planned_change'] }, 'small_change'), false);
  });
  it('minRisk → active only when risk meets threshold', () => {
    assert.equal(isEdgeActive({ lanes: ['planned_change'], minRisk: 'high' }, 'planned_change', 'medium'), false);
    assert.equal(isEdgeActive({ lanes: ['planned_change'], minRisk: 'high' }, 'planned_change', 'high'), true);
    assert.equal(isEdgeActive({ lanes: ['planned_change'], minRisk: 'high' }, 'planned_change', 'critical'), true);
  });
  it('minRisk ignored when risk omitted (structural/runnable check)', () => {
    assert.equal(isEdgeActive({ lanes: ['planned_change'], minRisk: 'high' }, 'planned_change'), true);
  });
});

describe('assertNoSchemaDowngrade (PUT 降级保护)', () => {
  it('rejects V5→V4, V5→V3, V4→V3', () => {
    assert.throws(() => assertNoSchemaDowngrade(5, 4), /downgrade/);
    assert.throws(() => assertNoSchemaDowngrade(5, 3), /downgrade/);
    assert.throws(() => assertNoSchemaDowngrade(4, 3), /downgrade/);
  });
  it('allows same-version edits and upgrades via PUT (upgrades blocked later by migration service)', () => {
    assert.doesNotThrow(() => assertNoSchemaDowngrade(5, 5));
    assert.doesNotThrow(() => assertNoSchemaDowngrade(4, 4));
    assert.doesNotThrow(() => assertNoSchemaDowngrade(3, 4));
    assert.doesNotThrow(() => assertNoSchemaDowngrade(4, 5));
  });
});
