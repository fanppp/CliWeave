import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNodeInstanceAt } from './node-instance.js';
import { getActiveSessionCtx, setActiveSessionCtx } from './SessionChain.js';
import { invokeAgentWithPolicy } from './invoke-agent.js';
import type { AgentMessage } from './types.js';

/** 构造临时节点实例（V4 descriptor + active-session.json 预置）。 */
function makeCtx(): ReturnType<typeof readNodeInstanceAt> {
  const root = mkdtempSync(join(tmpdir(), 'as-'));
  const nodeDir = join(root, 'nodes', 'codex', 'test');
  mkdirSync(join(nodeDir, 'runtime'), { recursive: true });
  mkdirSync(join(nodeDir, 'config'), { recursive: true });
  writeFileSync(
    join(nodeDir, 'node.json'),
    JSON.stringify({
      schemaVersion: 4,
      localId: 'test',
      name: 'test',
      provider: 'codex',
      cli: { command: 'codex', sandboxMode: 'read-only', extraArgs: [], promptVia: 'stdin', cwd: '${PROJECT_PATH}' },
      storage: {
        config: { identityFile: 'config/identity.md', rulesFiles: [] },
        runtime: { activeSessionFile: 'runtime/active-session.json', resume: true },
        data: {},
      },
    }),
  );
  return readNodeInstanceAt({ projectId: 'test', projectDir: nodeDir, projectPath: root, nodeKey: 'codex:test' });
}

function activeSessionFile(ctx: ReturnType<typeof readNodeInstanceAt>): string {
  return join(ctx.nodeDir, ctx.descriptor.storage.runtime.activeSessionFile);
}
function snapshot(ctx: ReturnType<typeof readNodeInstanceAt>): { content: string; mtime: number } {
  const f = activeSessionFile(ctx);
  return { content: readFileSync(f, 'utf-8'), mtime: statSync(f).mtimeMs };
}
function fakeService(msgs: AgentMessage[]): { nodeId: string; provider: string; invoke(p: string): AsyncIterable<AgentMessage> } {
  return {
    nodeId: 'codex:test',
    provider: 'codex',
    async *invoke(_p: string): AsyncGenerator<AgentMessage> {
      for (const m of msgs) yield m;
    },
  };
}
const T = 1;
const init = (sid: string): AgentMessage => ({ type: 'session_init', nodeId: 'codex:test', sessionId: sid, timestamp: T });
const txt = (c: string): AgentMessage => ({ type: 'text', nodeId: 'codex:test', content: c, timestamp: T });
const done = (): AgentMessage => ({ type: 'done', nodeId: 'codex:test', timestamp: T });
const fallback = (prev: string): AgentMessage => ({ type: 'session_fallback', nodeId: 'codex:test', previousSessionId: prev, reason: 'not_found', timestamp: T });

describe('active-session.json 文件级双断言（graph 路径 fresh/resume 不触碰）', () => {
  it('fresh：session_init 不写 active-session；内容+mtime 不变', async () => {
    const ctx = makeCtx();
    writeFileSync(activeSessionFile(ctx), JSON.stringify({ sessionId: 'pre', updatedAt: T }));
    const before = snapshot(ctx);
    const outcome = await invokeAgentWithPolicy({
      service: fakeService([init('s1'), txt('hi'), done()]),
      nodeId: 'codex:test', prompt: 'p', policy: { mode: 'fresh', persistActive: false },
      workingDirectory: '/wd', onMessage: () => {},
      getActiveSession: () => getActiveSessionCtx(ctx),
      setActiveSession: (sid) => setActiveSessionCtx(ctx, sid),
    });
    const after = snapshot(ctx);
    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.sessionId, 's1', '捕获 fresh session_init 的 sessionId');
    assert.equal(after.content, before.content, 'active-session.json 内容不变');
    assert.equal(after.mtime, before.mtime, 'active-session.json mtime 不变');
  });

  it('resume（provider 内部 fresh fallback 折叠进流）：helper 不写 active-session；内容+mtime 不变', async () => {
    const ctx = makeCtx();
    writeFileSync(activeSessionFile(ctx), JSON.stringify({ sessionId: 'pre', updatedAt: T }));
    const before = snapshot(ctx);
    const outcome = await invokeAgentWithPolicy({
      service: fakeService([fallback('pre'), init('new'), txt('ok'), done()]),
      nodeId: 'codex:test', prompt: 'p', policy: { mode: 'resume', sessionId: 'pre', persistActive: false },
      workingDirectory: '/wd', onMessage: () => {},
      getActiveSession: () => getActiveSessionCtx(ctx),
      setActiveSession: (sid) => setActiveSessionCtx(ctx, sid),
    });
    const after = snapshot(ctx);
    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.resumeFallback, true);
    assert.equal(outcome.sessionId, 'new');
    assert.equal(after.content, before.content, 'active-session.json 内容不变');
    assert.equal(after.mtime, before.mtime, 'active-session.json mtime 不变');
  });

  it('active（对照组）：session_init 写回 active-session（确认写路径仍工作）', async () => {
    const ctx = makeCtx();
    writeFileSync(activeSessionFile(ctx), JSON.stringify({ sessionId: 'pre', updatedAt: T }));
    const outcome = await invokeAgentWithPolicy({
      service: fakeService([init('new'), txt('hi'), done()]),
      nodeId: 'codex:test', prompt: 'p', policy: { mode: 'active' },
      workingDirectory: '/wd', onMessage: () => {},
      getActiveSession: () => getActiveSessionCtx(ctx),
      setActiveSession: (sid) => setActiveSessionCtx(ctx, sid),
    });
    assert.equal(outcome.status, 'ok');
    const after = JSON.parse(readFileSync(activeSessionFile(ctx), 'utf-8'));
    assert.equal(after.sessionId, 'new', 'active 模式 session_init 写回 active-session');
  });
});
