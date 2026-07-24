/**
 * 项目根解析
 * 找到含 agents/ 目录的根（monorepo 根 = pnpm-workspace.yaml 所在）。
 * 借鉴 clowder-ai utils/monorepo-root.ts，精简版。
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let cachedRoot: string | null = null;

export function getProjectRoot(start: string = process.cwd()): string {
  if (cachedRoot) return cachedRoot;
  let current = resolve(start);
  for (;;) {
    if (existsSync(resolve(current, 'agents'))) {
      cachedRoot = current;
      return current;
    }
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) {
      cachedRoot = current;
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      // 回退到 cwd
      cachedRoot = resolve(start);
      return cachedRoot;
    }
    current = parent;
  }
}

/** 把路径变量如 ${PROJECT_ROOT} 替换为实际值 */
export function resolvePathVars(path: string): string {
  return path.replace('${PROJECT_ROOT}', getProjectRoot());
}
