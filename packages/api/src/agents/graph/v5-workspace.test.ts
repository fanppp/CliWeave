import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { getDefaultV5ProjectGraph, scaffoldV5Workspace, V5_ROLES } from './v5-workspace.js';
import { validateGraph, validateRunnable, readProjectGraph, type GraphV5 } from './graph.js';
import { createProject, projectDir } from '../project-storage.js';

const PID = 'v5-scaffold-test';

describe('V5 Project Workspace template', () => {
  it('default V5 graph passes validation', () => {
    const g = getDefaultV5ProjectGraph();
    validateGraph(g);
    validateRunnable(g);
  });

  it('every role nodeKey appears in the template graph', () => {
    const g = getDefaultV5ProjectGraph();
    const keys = new Set(g.nodes.filter((n) => 'agentNodeKey' in n).map((n) => (n as { agentNodeKey: string }).agentNodeKey));
    for (const role of V5_ROLES) assert.ok(keys.has(role.nodeKey), `template missing ${role.nodeKey}`);
  });

  it('security gate is planned_change-only (small_change skips it)', () => {
    const g = getDefaultV5ProjectGraph();
    const sec = g.edges.find((e) => e.kind === 'gate' && e.target === 'security-review') as Extract<GraphV5['edges'][number], { kind: 'gate' }>;
    assert.ok(sec);
    assert.deepEqual(sec.lanes, ['planned_change']);
    assert.equal(sec.minRisk, 'high');
  });
});

describe('V5 Project Workspace scaffold', () => {
  after(() => { try { rmSync(projectDir(PID), { recursive: true, force: true }); } catch { /* ignore */ } });

  it('scaffolds role nodes + writes the V5 graph for a new project', () => {
    try { rmSync(projectDir(PID), { recursive: true, force: true }); } catch { /* ignore */ }
    createProject(PID, undefined);
    const result = scaffoldV5Workspace(PID);
    assert.ok(result.created.includes('opencode:project-router'));
    assert.ok(result.created.includes('codex:plan-review'));
    assert.ok(result.created.includes('claude:verify'));
    assert.equal(result.graphError, undefined);
    const graph = readProjectGraph(PID) as GraphV5;
    assert.equal(graph.schemaVersion, 5);
    assert.ok(graph.nodes.some((n) => n.type === 'router'));
  });

  it('is idempotent (re-scaffold does not fail, graph stays V5)', () => {
    const result = scaffoldV5Workspace(PID);
    assert.equal(result.graphError, undefined);
    const graph = readProjectGraph(PID) as GraphV5;
    assert.equal(graph.schemaVersion, 5);
  });
});
