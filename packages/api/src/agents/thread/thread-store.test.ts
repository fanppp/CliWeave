import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../../utils/project-root.js';
import {
  createThread,
  readThread,
  listThreads,
  trashThread,
  readThreadEvents,
  openTurn,
  completeTurn,
  failTurn,
  abortPendingTurn,
  writePendingRun,
  readPendingRun,
  deletePendingRun,
  ThreadConflictError,
} from './thread-store.js';

const PID = '__thread_test__';
function projDir(): string {
  return join(getProjectRoot(), 'agents', 'projects', PID);
}

describe('thread-store', () => {
  before(() => {
    if (existsSync(projDir())) rmSync(projDir(), { recursive: true, force: true });
  });
  after(() => {
    if (existsSync(projDir())) rmSync(projDir(), { recursive: true, force: true });
  });

  it('createThread → revision 0, activeRunId null; openTurn(rev0) → revision 1 + activeRunId + turn_opened', async () => {
    const t = createThread(PID, '你好');
    assert.equal(t.revision, 0);
    assert.equal(t.activeRunId, null);
    const r = await openTurn(PID, t.id, 0, { runId: 'r1', userMessage: '你好' });
    assert.equal(r.seq, 1);
    assert.equal(r.revision, 1);
    const meta = readThread(PID, t.id);
    assert.equal(meta?.activeRunId, 'r1');
    assert.equal(meta?.revision, 1);
    const evs = readThreadEvents(PID, t.id);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].type, 'turn_opened');
  });

  it('revision lock：旧 expectedRevision → 409 ThreadConflictError', async () => {
    const t = createThread(PID, '锁');
    await openTurn(PID, t.id, 0, { runId: 'r', userMessage: 'm' }); // revision→1
    await assert.rejects(() => openTurn(PID, t.id, 0, { runId: 'r2', userMessage: 'm2' }), ThreadConflictError);
  });

  it('同一 Thread 同时只允许一个 active run → 409', async () => {
    const t = createThread(PID, '互斥');
    await openTurn(PID, t.id, 0, { runId: 'a1', userMessage: 'm' }); // activeRunId=a1, rev=1
    await assert.rejects(() => openTurn(PID, t.id, 1, { runId: 'a2', userMessage: 'm2' }), ThreadConflictError);
  });

  it('completeTurn → 清 activeRunId + revision+1 + turn_completed', async () => {
    const t = createThread(PID, '完成');
    const r = await openTurn(PID, t.id, 0, { runId: 'c1', userMessage: 'm' });
    await completeTurn(PID, t.id, 'c1', r.turnId, { finalArtifact: '产物', quality: { status: 'done', termination: 'completed' } });
    const meta = readThread(PID, t.id);
    assert.equal(meta?.activeRunId, null);
    assert.equal(meta?.revision, 2);
    const evs = readThreadEvents(PID, t.id);
    assert.equal(evs[1].type, 'turn_completed');
    assert.equal((evs[1] as { finalArtifact: string }).finalArtifact, '产物');
  });

  it('completeTurn 过期回调（activeRunId 不匹配）→ 静默忽略，不改 revision', async () => {
    const t = createThread(PID, '过期');
    const r = await openTurn(PID, t.id, 0, { runId: 'e1', userMessage: 'm' });
    const revBefore = readThread(PID, t.id)?.revision;
    // 用一个不匹配的 runId 调 completeTurn → 应被忽略
    await completeTurn(PID, t.id, 'WRONG', r.turnId, { finalArtifact: 'x' });
    assert.equal(readThread(PID, t.id)?.revision, revBefore);
    assert.equal(readThread(PID, t.id)?.activeRunId, 'e1'); // 仍活跃
  });

  it('failTurn(aborted) → 清 activeRunId + turn_failed', async () => {
    const t = createThread(PID, '失败');
    const r = await openTurn(PID, t.id, 0, { runId: 'f1', userMessage: 'm' });
    await failTurn(PID, t.id, 'f1', r.turnId, { status: 'aborted' });
    const meta = readThread(PID, t.id);
    assert.equal(meta?.activeRunId, null);
    const evs = readThreadEvents(PID, t.id);
    assert.equal(evs[1].type, 'turn_failed');
  });

  it('abortPendingTurn → turn_failed aborted + 清 activeRunId', async () => {
    const t = createThread(PID, '中止');
    const r = await openTurn(PID, t.id, 0, { runId: 'p1', userMessage: 'm' });
    await abortPendingTurn(PID, t.id, 'p1', r.turnId);
    const meta = readThread(PID, t.id);
    assert.equal(meta?.activeRunId, null);
    assert.equal(readThreadEvents(PID, t.id)[1].type, 'turn_failed');
  });

  it('多轮：seq 递增；continue 须传最新 revision', async () => {
    const t = createThread(PID, '多轮');
    const r1 = await openTurn(PID, t.id, 0, { runId: 'm1', userMessage: '第一轮' });
    await completeTurn(PID, t.id, 'm1', r1.turnId, { finalArtifact: 'a1' });
    const r2 = await openTurn(PID, t.id, 2, { runId: 'm2', userMessage: '第二轮' }); // 传最新 revision=2
    assert.equal(r2.seq, 2);
    assert.equal(r2.revision, 3);
  });

  it('pending run 持久化：write/read/delete（create↔start 之间重启不丢）', () => {
    writePendingRun({ runId: 'pr1', projectId: PID, threadId: 't', turnId: 'tu', prompt: '你好', threadRevision: 1, runMode: 'full', createdAt: 1 });
    const p = readPendingRun(PID, 'pr1');
    assert.ok(p);
    assert.equal(p?.prompt, '你好');
    assert.equal(p?.threadRevision, 1);
    deletePendingRun(PID, 'pr1');
    assert.equal(readPendingRun(PID, 'pr1'), null);
  });

  it('listThreads → 含本测试创建的 thread', async () => {
    const t = createThread(PID, '列表');
    const list = listThreads(PID);
    assert.ok(list.some((x) => x.id === t.id));
  });

  it('trashThread：有 active run → 拒绝；清空后可删', async () => {
    const t = createThread(PID, '回收');
    const r = await openTurn(PID, t.id, 0, { runId: 'tr1', userMessage: 'm' });
    assert.throws(() => trashThread(PID, t.id), /active run/);
    await abortPendingTurn(PID, t.id, 'tr1', r.turnId);
    trashThread(PID, t.id);
    assert.equal(readThread(PID, t.id), null);
  });
});
