/**
 * per-node 项目内 Claude Code home（CLAUDE_CONFIG_DIR）
 * 让 claude 的 session/记忆存 agents/<node>/data/cli/.claude，不落全局 ~/.claude。
 * 凭证/settings 从全局 copy-on-missing。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureNodeTemp, nodeTempEnv, resolveNodeCliHome } from './cli-storage.js';
import type { NodeDescriptor } from './NodeDescriptor.js';

/** 全局 claude home（~/.claude 或 $CLAUDE_CONFIG_DIR） */
export function globalClaudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

/** 解析某节点的项目内 claude home（默认 agents/<id>/data/cli/.claude） */
export function resolveClaudeHome(descriptor: NodeDescriptor): string {
  return resolveNodeCliHome(descriptor, '.claude');
}

export function claudeEnv(home: string): Record<string, string> {
  return { CLAUDE_CONFIG_DIR: home, ...nodeTempEnv(home) };
}

/** claude 凭证/设置文件（copy-on-missing） */
const SHARED_FILES = ['.credentials.json', 'settings.json', 'settings.local.json'];

/** 确保项目内 claude home 可用 */
export function ensureClaudeHome(home: string): void {
  mkdirSync(home, { recursive: true });
  ensureNodeTemp(home);
  const gHome = globalClaudeHome();
  for (const name of SHARED_FILES) {
    const target = join(home, name);
    if (existsSync(target)) continue;
    const src = join(gHome, name);
    if (existsSync(src)) {
      try {
        copyFileSync(src, target);
      } catch {
        // 复制失败不致命
      }
    }
  }
}
