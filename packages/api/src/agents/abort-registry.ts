/**
 * 共享 AbortController 注册表
 * 用 invocationId（单节点）或 runId（图运行）作为 key，注册一个 AbortController，
 * 供 POST /abort 端点在用户点击"停止"时远程中止正在执行的 CLI 子进程。
 */
const controllers = new Map<string, AbortController>();

export function registerAbort(id: string): AbortController {
  const controller = new AbortController();
  controllers.set(id, controller);
  return controller;
}

/** 中止指定 id 的运行。返回是否找到并触发了 abort。 */
export function abortRun(id: string): boolean {
  const controller = controllers.get(id);
  if (!controller) return false;
  if (!controller.signal.aborted) controller.abort();
  return true;
}

/** 运行结束后清理注册项（释放内存）。 */
export function unregisterAbort(id: string): void {
  controllers.delete(id);
}
