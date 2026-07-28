import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../utils/project-root.js';
import { createThread, openTurn, completeTurn, pinMemory, unpinMemory } from './thread/thread-store.js';
import { buildThreadContext, buildServerContext } from './context-builder.js';

const PID = '__ctx_test__';
function projDir(): string {
  return join(getProjectRoot(), 'agents', 'projects', PID);
}

async function makeThreadWithTurns(n: number): Promise<{ threadId: string; turnIds: string[] }> {
  const t = createThread(PID, `ctx-${n}`);
  const turnIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await openTurn(PID, t.id, i === 0 ? 0 : i * 2, { runId: `r${i}`, userMessage: `用户消息${i}` });
    turnIds.push(r.turnId);
    await completeTurn(PID, t.id, `r${i}`, r.turnId, { finalArtifact: `回答${i}` });
  }
  return { threadId: t.id, turnIds };
}

describe('context-builder', () => {
  before(() => {
    if (existsSync(projDir())) rmSync(projDir(), { recursive: true, force: true });
  });
  after(() => {
    if (existsSync(projDir())) rmSync(projDir(), { recursive: true, force: true });
  });

  it('历史 turns 含 userMessage + finalArtifact；untrusted 包裹；serverContext 注入', async () => {
    const { threadId } = await makeThreadWithTurns(2);
    const sc = buildServerContext();
    const { prefix, snapshot } = buildThreadContext(PID, threadId, { serverContext: sc });
    assert.ok(prefix.includes('用户消息0') && prefix.includes('回答0'));
    assert.ok(prefix.includes('用户消息1') && prefix.includes('回答1'));
    assert.ok(prefix.includes('untrusted'), '历史包裹 untrusted 标记');
    assert.ok(prefix.includes('【服务端上下文'));
    assert.ok(prefix.includes(sc.timezone));
    assert.equal(snapshot.includedTurnIds.length, 2);
    assert.equal(snapshot.includedSummary, false, '首版 summary 留空');
    assert.equal(snapshot.policyVersion, 1);
  });

  it('最多 8 个 turns：建 10 个只含最近 8', async () => {
    const { threadId, turnIds } = await makeThreadWithTurns(10);
    const { prefix, snapshot } = buildThreadContext(PID, threadId, { serverContext: buildServerContext() });
    assert.equal(snapshot.includedTurnIds.length, 8);
    // 最近 8 = turnIds[2..9]
    assert.deepEqual(snapshot.includedTurnIds, turnIds.slice(2));
    assert.ok(!prefix.includes('用户消息0') && !prefix.includes('用户消息1'), '最旧两轮被裁');
    assert.ok(prefix.includes('用户消息9'), '最新轮保留');
  });

  it('预算超限：从最旧开始裁剪直到 fits（budgetTokens 极小→全裁）', async () => {
    const { threadId, turnIds } = await makeThreadWithTurns(3);
    const { prefix, snapshot } = buildThreadContext(PID, threadId, { serverContext: buildServerContext(), budgetTokens: 10 });
    // fixedOverhead(serverBlock+summaryBlock) 已远超 10 → turns 全裁
    assert.equal(snapshot.includedTurnIds.length, 0, 'turns 全被裁');
    assert.ok(prefix.includes('（无）'), '历史块标空');
    void turnIds;
  });

  it('当前未完成 turn（turn_opened 无 turn_completed）不入历史', async () => {
    const t = createThread(PID, 'current-open');
    const r = await openTurn(PID, t.id, 0, { runId: 'cur', userMessage: '本轮未完成' });
    // 不 completeTurn → 无 completed turn
    const { prefix, snapshot } = buildThreadContext(PID, t.id, { serverContext: buildServerContext() });
    assert.equal(snapshot.includedTurnIds.length, 0);
    assert.ok(!prefix.includes('本轮未完成'), '当前未完成 turn 不入历史');
    void r;
  });

  it('空 thread → 历史（无）', () => {
    const t = createThread(PID, 'empty');
    const { prefix, snapshot } = buildThreadContext(PID, t.id, { serverContext: buildServerContext() });
    assert.equal(snapshot.includedTurnIds.length, 0);
    assert.ok(prefix.includes('（无）'));
  });

  it('pin memory：memory_pinned 入 pinned 块；unpin 后移除', async () => {
    const { threadId, turnIds } = await makeThreadWithTurns(1);
    await pinMemory(PID, threadId, { memoryId: 'mem1', content: '重要约束X', sourceTurnIds: [turnIds[0]] });
    let { prefix, snapshot } = buildThreadContext(PID, threadId, { serverContext: buildServerContext() });
    assert.ok(prefix.includes('重要约束X'), 'pinned 内容注入');
    assert.deepEqual(snapshot.pinnedMemoryIds, ['mem1']);
    await unpinMemory(PID, threadId, 'mem1');
    ({ prefix, snapshot } = buildThreadContext(PID, threadId, { serverContext: buildServerContext() }));
    assert.ok(!prefix.includes('重要约束X'), 'unpin 后移除');
    assert.equal(snapshot.pinnedMemoryIds.length, 0);
  });

  it('serverContext.location 由调用方提供（不推断）', () => {
    const sc = buildServerContext('北京');
    assert.equal(sc.location, '北京');
    const sc2 = buildServerContext();
    assert.equal(sc2.location, undefined, '未提供则无 location');
  });

  it('contextPrefix 前置于 buildLegacyPrompt（walk 注入）—— 通过 snapshot 体现 serverContext 落 run_meta', async () => {
    const { threadId } = await makeThreadWithTurns(1);
    const sc = buildServerContext('上海');
    const { snapshot } = buildThreadContext(PID, threadId, { serverContext: sc });
    assert.equal(snapshot.serverContext.location, '上海');
    assert.equal(snapshot.serverContext.startedAt, sc.startedAt);
  });
});
