import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerRun,
  getRun,
  transitionRunStatus,
  abortRunEntry,
  removeRun,
  hasActiveRuns,
  listRunsByProject,
  registerSubInvocation,
  listSubInvocationsByRun,
  removeSubInvocation,
} from './run-registry.js';
import { registerPid, unregisterPid, hasActiveChildProcesses, listActiveChildProcesses, getPidBySubInvocation } from './child-process-registry.js';

/** 清理：本测试用固定 id，跑完移除避免污染其它测试。 */
function clearRun(id: string): void {
  removeRun(id);
}

describe('RunRegistry 终态与活跃检查', () => {
  it('transitionRunStatus 不覆盖终态（done/error/aborted 由调用方按事件设置）', () => {
    const id = 'rr-test-done';
    registerRun({ id, projectId: 'p', kind: 'graph', status: 'running', createdAt: Date.now() });
    transitionRunStatus(id, 'done');
    assert.equal(getRun(id)!.status, 'done');
    // 模拟 routes 修复：error 事件后置 error，不被后续 done 覆盖（调用方不再无脑写 done）
    transitionRunStatus(id, 'error');
    assert.equal(getRun(id)!.status, 'error');
    clearRun(id);
  });

  it('abortRunEntry：活跃态→aborted + controller.abort()', () => {
    const id = 'rr-test-abort';
    registerRun({ id, projectId: 'p', kind: 'graph', status: 'running', createdAt: Date.now() });
    let aborted = false;
    getRun(id)!.controller = new AbortController();
    getRun(id)!.controller!.signal.addEventListener('abort', () => { aborted = true; });
    assert.ok(abortRunEntry(id));
    assert.equal(getRun(id)!.status, 'aborted');
    assert.ok(aborted);
    clearRun(id);
  });

  it('hasActiveRuns：pending/running/paused 视为活跃；done/error/aborted 不活跃', () => {
    const id = 'rr-test-active';
    registerRun({ id, projectId: 'p-active', kind: 'graph', status: 'running', createdAt: Date.now() });
    assert.ok(hasActiveRuns('p-active'));
    transitionRunStatus(id, 'done');
    assert.ok(!hasActiveRuns('p-active'));
    clearRun(id);
  });

  it('sub-invocation：register/list/remove', () => {
    const sub = 'run-x:n1:1:abc';
    registerSubInvocation({ subInvocationId: sub, parentRunId: 'run-x', projectId: 'p', instanceKey: 'p:codex:n1', createdAt: Date.now() });
    assert.equal(listSubInvocationsByRun('run-x').length, 1);
    removeSubInvocation(sub);
    assert.equal(listSubInvocationsByRun('run-x').length, 0);
  });
});

describe('ChildProcessRegistry PID 登记（迁移活跃检查）', () => {
  beforeEach(() => {
    // 清空已知子进程
    for (const e of listActiveChildProcesses()) unregisterPid(e.subInvocationId);
  });

  it('registerPid 后 hasActiveChildProcesses=true；unregister 后=false', () => {
    assert.ok(!hasActiveChildProcesses());
    registerPid('run-y:n1:1:z', 4242, 'run-y');
    assert.ok(hasActiveChildProcesses());
    assert.equal(getPidBySubInvocation('run-y:n1:1:z'), 4242);
    unregisterPid('run-y:n1:1:z');
    assert.ok(!hasActiveChildProcesses());
  });

  it('unregister 未知 id 不报错（幂等，spawnCli finally 安全调用）', () => {
    unregisterPid('nonexistent');
    assert.ok(!hasActiveChildProcesses());
  });
});
