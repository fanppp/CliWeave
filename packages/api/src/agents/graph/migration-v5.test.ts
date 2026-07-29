import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../../utils/project-root.js';
import { buildMigrationV5Graph, previewMigration, applyMigration, rollbackMigration, MigrationError } from './migration-v5.js';
import { readProjectGraph, writeProjectGraphForced, type GraphV4 } from './graph.js';
import { bindLocalPath } from '../project-storage.js';

describe('buildMigrationV5Graph (pure)', () => {
  it('substitutes nodeKeys per roleMap; keeps canonical for unspecified roles', () => {
    const g = buildMigrationV5Graph({ 'plan-review': 'codex:plan-reviewer', 'code-review': 'codex:code-reviewer', verify: 'claude:verifier' });
    assert.equal(g.schemaVersion, 5);
    const planReview = g.nodes.find((n) => n.id === 'plan-review');
    assert.equal(planReview && 'agentNodeKey' in planReview && planReview.agentNodeKey, 'codex:plan-reviewer');
    const codeReview = g.nodes.find((n) => n.id === 'code-review');
    assert.equal(codeReview && 'agentNodeKey' in codeReview && codeReview.agentNodeKey, 'codex:code-reviewer');
    const router = g.nodes.find((n) => n.id === 'router');
    assert.equal(router && 'agentNodeKey' in router && router.agentNodeKey, 'opencode:project-router'); // canonical kept
  });
});

// 最小 V4 图：architect → plan_reviewer gate → implementer → code_reviewer gate → verifier gate → end
function v4Graph(): GraphV4 {
  return {
    schemaVersion: 4, inputNode: '__input__', endNode: '__end__', maxNodeExecutions: 80,
    nodes: [
      { id: '__input__', type: 'input' },
      { id: 'architect', type: 'agent', agentNodeKey: 'opencode:architect' },
      { id: 'plan_reviewer', type: 'decision', agentNodeKey: 'codex:plan-reviewer', rubricRef: 'rubric.json' },
      { id: 'implementer', type: 'agent', agentNodeKey: 'opencode:implementer' },
      { id: 'code_reviewer', type: 'decision', agentNodeKey: 'codex:code-reviewer', rubricRef: 'rubric.json' },
      { id: 'verifier', type: 'decision', agentNodeKey: 'claude:verifier', rubricRef: 'rubric.json' },
      { id: '__end__', type: 'end' },
    ],
    edges: [
      { id: 'in->arch', source: '__input__', target: 'architect', kind: 'forward' },
      { id: 'arch->impl', source: 'architect', target: 'implementer', kind: 'forward' },
      { id: 'impl->end', source: 'implementer', target: '__end__', kind: 'forward' },
      { id: 'gate-plan', source: 'architect', target: 'plan_reviewer', kind: 'gate', order: 1, maxRevisions: 2, onExhausted: 'ask_user', onBlocked: 'ask_user' },
      { id: 'rework-plan', source: 'plan_reviewer', target: 'architect', kind: 'rework' },
      { id: 'gate-code', source: 'implementer', target: 'code_reviewer', kind: 'gate', order: 1, maxRevisions: 2, onExhausted: 'ask_user', onBlocked: 'ask_user' },
      { id: 'rework-code', source: 'code_reviewer', target: 'implementer', kind: 'rework' },
      { id: 'gate-verify', source: 'implementer', target: 'verifier', kind: 'gate', order: 2, maxRevisions: 2, onExhausted: 'ask_user', onBlocked: 'ask_user' },
      { id: 'rework-verify', source: 'verifier', target: 'implementer', kind: 'rework' },
    ],
  };
}

// canonical roleMap（全用 V5 canonical key → apply 经 V5_ROLES scaffold；避免非 canonical 无 metadata）
const ROLE_MAP = { architect: 'opencode:architect', 'plan-review': 'codex:plan-review', implementer: 'opencode:implementer', 'code-review': 'codex:code-review', verify: 'claude:verify' };

describe('V4→V5 migration service (integration)', () => {
  const pid = 'migration-test-' + randomUUID().slice(0, 8);
  const pdir = join(getProjectRoot(), 'agents', 'projects', pid);

  before(() => {
    mkdirSync(join(pdir, 'nodes'), { recursive: true });
    writeFileSync(join(pdir, 'project.json'), JSON.stringify({ schemaVersion: 1, id: pid, name: 'migration test', createdAt: Date.now() }) + '\n', 'utf-8');
    bindLocalPath(pid, pdir); // instantiateNodeInstance 需绑定 local path
  });

  beforeEach(() => {
    writeFileSync(join(pdir, 'graph.json'), JSON.stringify(v4Graph()) + '\n', 'utf-8'); // 每个测试前重置为 V4
  });

  after(() => {
    rmSync(pdir, { recursive: true, force: true });
  });

  it('preview without roleMap → requiresMapping (refuses to guess)', () => {
    const r = previewMigration(pid);
    assert.equal('requiresMapping' in r, true);
  });

  it('preview with roleMap → candidate V5 + confirmToken + created nodes', () => {
    const r = previewMigration(pid, ROLE_MAP);
    assert.equal('requiresMapping' in r || 'error' in r, false, 'preview should succeed');
    if (!('requiresMapping' in r) && !('error' in r)) {
      assert.equal(r.candidate.schemaVersion, 5);
      assert.ok(r.confirmToken);
      assert.ok(r.created.includes('opencode:project-router'));
    }
  });

  it('apply consumes confirmToken → writes V5 graph + scaffolds new nodes', () => {
    const preview = previewMigration(pid, ROLE_MAP);
    if ('requiresMapping' in preview || 'error' in preview) throw new Error('preview failed');
    const result = applyMigration(pid, preview.confirmToken);
    assert.ok(result.migrationId);
    assert.ok(result.created.includes('opencode:project-router'));
    assert.equal(readProjectGraph(pid).schemaVersion, 5);
    assert.ok(existsSync(join(pdir, 'nodes', 'opencode', 'project-router', 'node.json')));
  });

  it('apply rejects a stale/unknown confirmToken', () => {
    assert.throws(() => applyMigration(pid, 'bogus-token'), MigrationError);
  });

  it('rollback restores the V4 graph + trashes created nodes', () => {
    const preview = previewMigration(pid, ROLE_MAP);
    if ('requiresMapping' in preview || 'error' in preview) throw new Error('preview failed');
    const applied = applyMigration(pid, preview.confirmToken);
    assert.equal(readProjectGraph(pid).schemaVersion, 5);
    rollbackMigration(pid, applied.migrationId);
    assert.equal(readProjectGraph(pid).schemaVersion, 4); // V4 恢复
    assert.equal(existsSync(join(pdir, 'nodes', 'opencode', 'project-router', 'node.json')), false);
  });

  it('rollback refuses if current graph differs from migration product', () => {
    const preview = previewMigration(pid, ROLE_MAP);
    if ('requiresMapping' in preview || 'error' in preview) throw new Error('preview failed');
    const applied = applyMigration(pid, preview.confirmToken);
    // 强写一个不同的 V5 图（改 gate maxRevisions）→ 当前图 ≠ 迁移产物
    const modified = { ...preview.candidate, edges: preview.candidate.edges.map((e) => e.id === 'gate-code' ? { ...e, maxRevisions: 3 } : e) };
    writeProjectGraphForced(pid, modified);
    assert.throws(() => rollbackMigration(pid, applied.migrationId), MigrationError);
  });
});
