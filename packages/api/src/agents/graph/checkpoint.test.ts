import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDurableCheckpoint, verifyDurableToken, isAllowedDurableAction, allowedDurableActions, isV5GateCheckpoint, hashToken } from './checkpoint.js';
import type { HarnessCheckpoint } from './EvaluatorOptimizerRouter.js';

const v4 = (over: Partial<HarnessCheckpoint> = {}): HarnessCheckpoint => ({
  runner: 'v4', kind: 'gate', schemaVersion: 1, prompt: '', branchId: 'b', workNodeId: 'w', upstreamArtifact: '',
  candidates: [], currentCandidateId: 'c', gateIndex: 0, gateCounts: {}, degraded: false,
  tokenHash: hashToken('tok'), expiresAt: Date.now() + 1000, allowedActions: ['continue_best', 'revise_once', 'fail'], pauseReason: 'exhausted', ...over,
});

describe('DurableCheckpoint protocol', () => {
  it('parseDurableCheckpoint: legacy V4 (no runner/kind) → v4-gate', () => {
    const legacy = { schemaVersion: 1, branchId: 'b', workNodeId: 'w', tokenHash: hashToken('t'), expiresAt: Date.now() + 1000, allowedActions: ['fail'], pauseReason: 'exhausted' };
    const cp = parseDurableCheckpoint(legacy);
    assert.equal(isV5GateCheckpoint(cp), false);
  });

  it('parseDurableCheckpoint: V5 gate → v5-gate', () => {
    const v5 = { runner: 'v5', kind: 'gate', schemaVersion: 1, branchId: 'main', plan: {}, routeDecision: {}, nodeId: 'impl', upstreamArtifact: '', candidates: [], currentCandidateId: 'c', gateIndex: 0, gateCounts: {}, degraded: false, unresolvedGateIds: [], exhausted: true, allowedActions: ['fail'], pauseReason: 'exhausted', tokenHash: hashToken('t'), expiresAt: Date.now() + 1000 };
    assert.equal(isV5GateCheckpoint(parseDurableCheckpoint(v5)), true);
  });

  it('verifyDurableToken: valid true; wrong/expired false (constant-time)', () => {
    assert.equal(verifyDurableToken(v4({ tokenHash: hashToken('secret') }), 'secret'), true);
    assert.equal(verifyDurableToken(v4({ tokenHash: hashToken('secret') }), 'wrong'), false);
    assert.equal(verifyDurableToken(v4({ tokenHash: hashToken('secret'), expiresAt: Date.now() - 1 }), 'secret'), false);
  });

  it('isAllowedDurableAction: respects allowedActions (no best → no continue_best)', () => {
    const cp = v4({ allowedActions: ['revise_once', 'fail'] });
    assert.equal(isAllowedDurableAction(cp, 'continue_best'), false);
    assert.equal(isAllowedDurableAction(cp, 'fail'), true);
  });

  it('legacy checkpoint without allowedActions falls back to all three', () => {
    const legacy = { runner: 'v4', kind: 'gate', schemaVersion: 1, branchId: 'b', workNodeId: 'w', tokenHash: hashToken('t'), expiresAt: Date.now() + 1000, pauseReason: 'exhausted' };
    const cp = parseDurableCheckpoint(legacy) as HarnessCheckpoint;
    assert.deepEqual(allowedDurableActions(cp), ['continue_best', 'revise_once', 'fail']);
    assert.equal(isAllowedDurableAction(cp, 'continue_best'), true);
  });
});
