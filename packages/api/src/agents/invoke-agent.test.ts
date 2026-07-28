import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { invokeAgentWithPolicy } from './invoke-agent.js';
import type { AgentMessage } from './types.js';
import type { SessionPolicy } from './session-policy.js';

/** 构造 fake service：按预设 AgentMessage 序列 yield（模拟 provider 的整条流，含内部 fallback 折叠）。 */
function fakeService(msgs: AgentMessage[]): { nodeId: string; provider: string; invoke(p: string, o?: { sessionId?: string }): AsyncIterable<AgentMessage>; seenSessionId: string | undefined } {
  let seenSessionId: string | undefined;
  const service = {
    nodeId: 'n' as const,
    provider: 'test',
    invoke(_prompt: string, opts?: { sessionId?: string }): AsyncIterable<AgentMessage> {
      seenSessionId = opts?.sessionId;
      return (async function* (): AsyncGenerator<AgentMessage> {
        for (const m of msgs) yield m;
      })();
    },
    get seenSessionId(): string | undefined { return seenSessionId; },
  };
  return service;
}

function ts(): number { return 1; }

function msgInit(sid: string): AgentMessage { return { type: 'session_init', nodeId: 'n', sessionId: sid, timestamp: ts() }; }
function msgText(c: string): AgentMessage { return { type: 'text', nodeId: 'n', content: c, timestamp: ts() }; }
function msgErr(e: string): AgentMessage { return { type: 'error', nodeId: 'n', error: e, timestamp: ts() }; }
function msgDone(): AgentMessage { return { type: 'done', nodeId: 'n', timestamp: ts() }; }
function msgFallback(prev: string): AgentMessage { return { type: 'session_fallback', nodeId: 'n', previousSessionId: prev, reason: 'not_found', timestamp: ts() }; }

async function run(policy: SessionPolicy, msgs: AgentMessage[], opts: { getActiveSession?: () => string | undefined; setActiveSession?: (s: string) => void } = {}) {
  const service = fakeService(msgs);
  const streamed: AgentMessage[] = [];
  const outcome = await invokeAgentWithPolicy({
    service, nodeId: 'n', prompt: 'p', policy,
    workingDirectory: '/wd',
    onMessage: (m) => streamed.push(m),
    getActiveSession: opts.getActiveSession,
    setActiveSession: opts.setActiveSession,
  });
  return { outcome, streamed };
}

describe('invokeAgentWithPolicy', () => {
  it('fresh：不调 active-session；session_init 不落盘；返回 ok+sessionId', async () => {
    let activeGet = 0, activeSet = 0;
    const { outcome, streamed } = await run(
      { mode: 'fresh', persistActive: false },
      [msgInit('s1'), msgText('hi'), msgDone()],
      { getActiveSession: () => (activeGet++, undefined), setActiveSession: () => (activeSet++, undefined) },
    );
    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.finalText, 'hi');
    assert.equal(outcome.sessionId, 's1');
    assert.equal(activeGet, 0, 'fresh 不读 active-session');
    assert.equal(activeSet, 0, 'fresh 不写 active-session');
    // session_init/done 被吞；只流出 text
    assert.deepEqual(streamed.map((m) => m.type), ['text']);
  });

  it('active：读旧 sessionId 作 resume；session_init 写回 active-session', async () => {
    let setSid = '';
    const { outcome } = await run(
      { mode: 'active' },
      [msgInit('new'), msgText('hi'), msgDone()],
      { getActiveSession: () => 'old', setActiveSession: (s) => { setSid = s; } },
    );
    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.sessionId, 'new');
    assert.equal(setSid, 'new', 'active 模式 session_init 写回 active-session');
  });

  it('resume 成功：传 policy.sessionId；无 session_fallback；resumeFallback=false', async () => {
    const service = fakeService([msgInit('new'), msgText('hi'), msgDone()]);
    const outcome = await invokeAgentWithPolicy({
      service, nodeId: 'n', prompt: 'p', policy: { mode: 'resume', sessionId: 'old', persistActive: false },
      workingDirectory: '/wd', onMessage: () => {},
    });
    assert.equal(service.seenSessionId, 'old', 'resume 传 policy.sessionId');
    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.resumeFallback, undefined);
  });

  it('session_fallback 后 fresh 成功 → resumeFallback:true + 新 sessionId + 唯一终态 ok', async () => {
    const { outcome, streamed } = await run(
      { mode: 'resume', sessionId: 'old', persistActive: false },
      [msgFallback('old'), msgInit('new'), msgText('ok'), msgDone()],
    );
    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.finalText, 'ok');
    assert.equal(outcome.sessionId, 'new');
    assert.equal(outcome.resumeFallback, true);
    // 流出：session_fallback(诊断) + text；session_init/done 被吞；无 error
    assert.deepEqual(streamed.map((m) => m.type), ['session_fallback', 'text']);
  });

  it('fallback fresh 也失败 → 只一个 error 终态', async () => {
    const { outcome, streamed } = await run(
      { mode: 'resume', sessionId: 'old', persistActive: false },
      [msgFallback('old'), msgErr('boom'), msgDone()],
    );
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.error, 'boom');
    assert.equal(outcome.resumeFallback, true);
    // error 被吞（不中途流出）；只流出 session_fallback 诊断
    assert.deepEqual(streamed.map((m) => m.type), ['session_fallback']);
  });

  it('有实质输出后 error → 不发 session_fallback、不重试、一个 error 终态', async () => {
    const { outcome, streamed } = await run(
      { mode: 'resume', sessionId: 'old', persistActive: false },
      [msgText('partial'), msgErr('crash'), msgDone()],
    );
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.error, 'crash');
    assert.equal(outcome.resumeFallback, undefined, '无 session_fallback → 不置 resumeFallback');
    // text 流出；error 被吞（不中途流出）
    assert.deepEqual(streamed.map((m) => m.type), ['text']);
  });

  it('无任何 text 输出 → error（"produced no valid text output"）', async () => {
    const { outcome } = await run(
      { mode: 'fresh', persistActive: false },
      [msgInit('s1'), msgDone()],
    );
    assert.equal(outcome.status, 'error');
    assert.match(outcome.error ?? '', /produced no valid text output/);
  });
});
