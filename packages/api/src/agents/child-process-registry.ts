/**
 * ChildProcessRegistry —— CliWeave 启动的 CLI 子进程登记表（尽力而为）。
 *
 * 限制（必须文档化，不承诺孤儿发现）：
 * - 内存 registry 仅识别当前 API 生命周期内的子进程。
 * - Windows shell:true 的 PID 可能只是 cmd.exe，未必是最终 CLI。
 * - API 崩溃后的外部孤儿无法可靠自动识别。
 *
 * 迁移规则：
 * - registry 阻止迁移当前已知子进程（hasActiveChildProcesses → 拒绝）。
 * - 复制/验证遇文件锁 → 保留 staging + 失败，不写完成标记。
 * - CLI migrate 明确要求先停所有 CLI/API。
 */
export interface ChildProcessEntry {
  subInvocationId: string;
  pid: number;
  parentRunId: string;
  startedAt: number;
}

const byPid = new Map<number, ChildProcessEntry>();
const bySub = new Map<string, number>();

export function registerPid(subInvocationId: string, pid: number, parentRunId: string): void {
  const entry: ChildProcessEntry = { subInvocationId, pid, parentRunId, startedAt: Date.now() };
  byPid.set(pid, entry);
  bySub.set(subInvocationId, pid);
}

export function unregisterPid(subInvocationId: string): void {
  const pid = bySub.get(subInvocationId);
  if (pid !== undefined) {
    byPid.delete(pid);
    bySub.delete(subInvocationId);
  }
}

export function getPidBySubInvocation(subInvocationId: string): number | undefined {
  return bySub.get(subInvocationId);
}

export function listActiveChildProcesses(): ChildProcessEntry[] {
  return [...byPid.values()];
}

/** 是否有已知活跃子进程——迁移前置检查。 */
export function hasActiveChildProcesses(): boolean {
  return byPid.size > 0;
}
