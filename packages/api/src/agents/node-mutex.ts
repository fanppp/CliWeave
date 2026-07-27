/**
 * per-node async 互斥锁
 * 同一个 CLI 节点同时只能有一个活跃调用（单节点聊天 / 图运行 / 另一次图运行），
 * 否则 --resume 同一 session 会导致 CLI 历史交错、active.json 后写覆盖、进程异常。
 * 所有调用入口（/api/messages、/api/graph/run）必须经过 withNodeLock。
 */
const locks = new Map<string, Promise<void>>();

/**
 * 串行执行 fn 期间持有该节点的锁。fn 返回后释放，下一个等待者获得锁。
 * 不同节点并行不阻塞；同节点并行排队。
 */
export async function withNodeLock<T>(nodeKey: string, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = locks.get(nodeKey) ?? Promise.resolve();
  locks.set(nodeKey, next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // 若本节点锁已无人接续（map 仍指向本次 next），清理以释放内存
    if (locks.get(nodeKey) === next) locks.delete(nodeKey);
  }
}
