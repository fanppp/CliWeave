import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRunStatus } from './graph-run-store.js';
import type { PersistedRunEvent } from '../../infrastructure/websocket/SocketManager.js';

const checkpoint = { type: 'branch_checkpoint', runId: 'r', branchId: 'b', payload: { tokenHash: 'hash' } } as const;

describe('graph run durable status replay', () => {
  it('derives paused from an internal checkpoint without persisting the raw public token', () => {
    const events: PersistedRunEvent[] = [checkpoint, { type: 'run_state', runId: 'r', phase: 'paused', payload: { branchId: 'b' } }];
    assert.equal(deriveRunStatus(events), 'paused');
  });

  it('does not recover a consumed checkpoint, and terminal events win', () => {
    const consumed: PersistedRunEvent[] = [checkpoint, { type: 'run_state', runId: 'r', phase: 'resume_token_consumed', payload: { tokenHash: 'hash' } }];
    assert.equal(deriveRunStatus(consumed), 'unknown');
    assert.equal(deriveRunStatus([...consumed, { type: 'run_error', runId: 'r', error: 'failed' }]), 'error');
  });

  it('allows a later checkpoint after resume to become paused again', () => {
    const events: PersistedRunEvent[] = [checkpoint, { type: 'run_state', runId: 'r', phase: 'resume_token_consumed', payload: {} }, checkpoint];
    assert.equal(deriveRunStatus(events), 'paused');
  });
});
