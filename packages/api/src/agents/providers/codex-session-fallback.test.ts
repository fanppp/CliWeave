import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { readNodeInstanceAt } from '../node-instance.js';
import { listActiveChildProcesses } from '../child-process-registry.js';
import { CodexAgentService } from './CodexAgentService.js';
import type { ChildProcessLike, SpawnFn } from '../../utils/cli-types.js';
import type { AgentMessage } from '../types.js';

function makeCtx(): ReturnType<typeof readNodeInstanceAt> {
  const root = mkdtempSync(join(tmpdir(), 'codex-fb-'));
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

interface Scenario {
  lines: string[];
  exitCode: number;
}
/**
 * 按顺序消费 scenario 的 fake spawn：stdout 产 NDJSON 行后 on 'end' 触发 exit(code)。
 * 在 'end' 时刻 snapshot ChildProcessRegistry 的活跃 subInvocationId（register 在 for-await 前、unregister 在 finally，
 * 故 'end' 时仍可观测），用于验证 fresh 调用用了 :fb 独立审计 ID。
 */
function fakeSpawn(scenarios: Scenario[], capturedSubIds: string[]): SpawnFn {
  let i = 0;
  return () => {
    const sc = scenarios[i++] ?? { lines: [], exitCode: 0 };
    const exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
    const stdout = Readable.from(sc.lines.map((l) => `${l}\n`));
    stdout.on('end', () => {
      // 'end' 时刻 registry 仍有本次 spawn 的登记（unregister 在 finally 之后）
      for (const e of listActiveChildProcesses()) capturedSubIds.push(e.subInvocationId);
      for (const l of exitListeners) l(sc.exitCode, null);
    });
    const child = {
      stdin: null,
      stdout,
      stderr: Readable.from([]),
      pid: 100 + i,
      kill: () => false,
      on(event: string, listener: (...a: unknown[]) => void) {
        if (event === 'exit') exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
        return child;
      },
      once(event: string, listener: (...a: unknown[]) => void) {
        if (event === 'exit') exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
        return child;
      },
    };
    return child as unknown as ChildProcessLike;
  };
}

const threadStarted = (tid: string): string => JSON.stringify({ type: 'thread.started', thread_id: tid });
const agentMsg = (t: string): string => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: t } });
const turnCompleted = (): string => JSON.stringify({ type: 'turn.completed' });

async function collect(svc: CodexAgentService, prompt: string, opts: { sessionId?: string; invocationId?: string; runId?: string; workingDirectory: string }): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const m of svc.invoke(prompt, opts)) out.push(m);
  return out;
}

describe('CodexAgentService session_fallback 协议', () => {
  it('resume 不可用（无实质输出）→ 发 session_fallback + fresh（用 :fb 审计 ID）成功', async () => {
    const ctx = makeCtx();
    const capturedSubIds: string[] = [];
    const spawn = fakeSpawn([
      { lines: [], exitCode: 1 }, // resume attempt：无输出 + exit 1 → resume-failed
      { lines: [threadStarted('new'), agentMsg('ok'), turnCompleted()], exitCode: 0 }, // fresh
    ], capturedSubIds);
    const svc = new CodexAgentService(ctx, undefined, (cmd, args, opts) => spawn(cmd, args, opts));
    const msgs = await collect(svc, 'p', { sessionId: 'old', invocationId: 'inv1', runId: 'run1', workingDirectory: ctx.projectPath });

    const fb = msgs.find((m) => m.type === 'session_fallback') as Extract<AgentMessage, { type: 'session_fallback' }> | undefined;
    assert.ok(fb, 'emit session_fallback');
    assert.equal(fb?.previousSessionId, 'old');
    assert.ok(msgs.some((m) => m.type === 'session_init' && m.sessionId === 'new'), 'fresh session_init');
    assert.ok(msgs.some((m) => m.type === 'text' && m.content === 'ok'), 'fresh text');
    assert.ok(msgs.some((m) => m.type === 'done'), 'done');
    // 两次物理调用 attempt ID 不同：fresh 用 inv1:fb（registry 'end' 时刻观测）
    assert.ok(capturedSubIds.includes('inv1'), 'resume 调用登记 inv1');
    assert.ok(capturedSubIds.includes('inv1:fb'), 'fresh 调用用 inv1:fb 独立审计 ID');
  });

  it('resume 有实质输出后 error（exit≠1）→ 不发 session_fallback、不重试 fresh', async () => {
    const ctx = makeCtx();
    let calls = 0;
    const spawn = fakeSpawn([
      // resume：先产 agent_message（sawSubstantiveOutput=true）再 exit 2（非 exit-1 抑制）→ error，不回退
      { lines: [agentMsg('partial')], exitCode: 2 },
    ], []);
    const svc = new CodexAgentService(ctx, undefined, (cmd, args, opts) => {
      calls++;
      return spawn(cmd, args, opts);
    });
    const msgs = await collect(svc, 'p', { sessionId: 'old', invocationId: 'inv1', runId: 'run1', workingDirectory: ctx.projectPath });

    assert.equal(calls, 1, '只调用一次（有实质输出后不重试）');
    assert.ok(!msgs.some((m) => m.type === 'session_fallback'), '无 session_fallback');
    assert.ok(msgs.some((m) => m.type === 'error'), '报错（不抑制）');
  });
});
