/**
 * per-node 项目内 opencode home（经 XDG 环境变量重定向）
 * opencode 没有 CODEX_HOME 这种单一 home，但遵守 XDG_DATA_HOME/CONFIG/CACHE。
 * 设子进程 env 后，opencode 的 DB/sessions/skills/worktree 全落项目
 * agents/<node>/memory/.opencode/{data,config,cache}/opencode/。
 * auth.json 从全局 copy-on-missing。
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getProjectRoot } from '../utils/project-root.js';
import type { NodeDescriptor } from './NodeDescriptor.js';
import { resolveDescriptorPaths } from './NodeDescriptor.js';
/** 全局 opencode data 目录（~/.local/share/opencode） */
export function globalOpencodeDataDir(): string {
  return join(homedir(), '.local', 'share', 'opencode');
}

/** 解析某节点项目内 opencode base 目录（默认 agents/<id>/memory/.opencode） */
export function resolveOpencodeHome(descriptor: NodeDescriptor): string {
  const resolved = resolveDescriptorPaths(descriptor);
  const home = resolved.memory?.cliHome ?? join('agents', descriptor.id, 'memory', '.opencode');
  return resolve(getProjectRoot(), home);
}

/** 构造给 opencode 子进程的 env（XDG 指向项目内 + OPENCODE_CONFIG 指向 per-node 配置） */
export function opencodeXdgEnv(home: string, configPath?: string): Record<string, string> {
  const env: Record<string, string> = {
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
  };
  if (configPath) env.OPENCODE_CONFIG = configPath;
  return env;
}

/** 写 per-node opencode.json（用 instructions 注入 identity/rules，不污染 prompt） */
export function writeOpencodeConfig(descriptor: NodeDescriptor, home: string): string {
  const configDir = join(home, 'config', 'opencode');
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'opencode.json');
  const root = getProjectRoot();
  const resolved = resolveDescriptorPaths(descriptor);
  const toAbs = (p: string): string => resolve(root, p).replace(/\\/g, '/');
  const instructions: string[] = [];
  if (resolved.prompt?.identity) instructions.push(toAbs(resolved.prompt.identity));
  for (const pattern of resolved.rules?.files ?? []) {
    instructions.push(toAbs(pattern));
  }
  const cfg: Record<string, unknown> = { $schema: 'https://opencode.ai/config.json' };
  if (instructions.length > 0) cfg.instructions = instructions;
  if (descriptor.model) cfg.model = descriptor.model;
  cfg.permission = { edit: 'allow', bash: 'allow', write: 'allow' };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
  return configPath;
}

/** 确保项目内 opencode home 可用：建目录 + 复制 auth（缺失才复制） */
export function ensureOpencodeHome(home: string): void {
  const dataOpencode = join(home, 'data', 'opencode');
  mkdirSync(join(dataOpencode), { recursive: true });
  mkdirSync(join(home, 'config', 'opencode'), { recursive: true });
  mkdirSync(join(home, 'cache', 'opencode'), { recursive: true });

  const authTarget = join(dataOpencode, 'auth.json');
  if (!existsSync(authTarget)) {
    const src = join(globalOpencodeDataDir(), 'auth.json');
    if (existsSync(src)) {
      try {
        copyFileSync(src, authTarget);
      } catch {
        // 复制失败不致命
      }
    }
  }
}
