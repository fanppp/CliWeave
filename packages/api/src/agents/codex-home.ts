/**
 * per-node 项目内 CODEX_HOME 管理
 * 让 codex 的 session/记忆全存本项目 agents/<node>/data/cli/.codex/，不落全局 ~/.codex。
 * auth.json + config.toml 从全局 copy-on-missing（首次复制，之后 codex 自行刷新 token）。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureNodeTemp, nodeTempEnv, resolveNodeCliHome } from './cli-storage.js';
import type { NodeDescriptor } from './NodeDescriptor.js';

/** 全局 codex home（~/.codex 或 $CODEX_HOME） */
export function globalCodexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

/** 解析某节点的项目内 CODEX_HOME（默认 agents/<id>/data/cli/.codex） */
export function resolveCodexHome(descriptor: NodeDescriptor): string {
  return resolveNodeCliHome(descriptor, '.codex');
}

export function codexEnv(codexHome: string): Record<string, string> {
  return { CODEX_HOME: codexHome, ...nodeTempEnv(codexHome) };
}

/** 从全局 copy-on-missing：auth.json + config.toml + skills 等运行所需文件 */
const SHARED_FILES = ['auth.json', 'config.toml'];

/** 确保项目内 CODEX_HOME 可用：建目录 + 复制 auth/config（缺失才复制） */
export function ensureCodexHome(codexHome: string): void {
  mkdirSync(join(codexHome, 'sessions'), { recursive: true });
  ensureNodeTemp(codexHome);
  const gHome = globalCodexHome();
  for (const name of SHARED_FILES) {
    const target = join(codexHome, name);
    if (existsSync(target)) continue; // 已有就不覆盖（codex 会自己刷新 token）
    const src = join(gHome, name);
    if (existsSync(src)) {
      try {
        copyFileSync(src, target);
      } catch {
        // 复制失败不致命（可能 auth 用 env 或其它方式）
      }
    }
  }
}
