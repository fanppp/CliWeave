/**
 * per-node 项目内 opencode home（经 XDG 环境变量重定向）
 * opencode 没有 CODEX_HOME 这种单一 home，但遵守 XDG_DATA_HOME/CONFIG/CACHE。
 * 设子进程 env 后，opencode 的 DB/sessions/skills/worktree 全落项目
 * agents/<node>/data/cli/.opencode/{data,config,cache}/opencode/。
 * auth.json 从全局 copy-on-missing。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { getProjectRoot } from '../utils/project-root.js';
import { ensureNodeTemp, nodeTempEnv, resolveInstanceCliHome, resolveNodeCliHome } from './cli-storage.js';
import type { NodeDescriptor } from './NodeDescriptor.js';
import { resolveDescriptorPaths } from './NodeDescriptor.js';
import type { NodeInstanceContext } from './node-instance.js';
import { resolveInstanceDescriptorPaths } from './node-instance.js';
/** 全局 opencode data 目录（~/.local/share/opencode） */
export function globalOpencodeDataDir(): string {
  return join(homedir(), '.local', 'share', 'opencode');
}

/** 解析某节点项目内 opencode base 目录（默认 agents/<id>/data/cli/.opencode） */
export function resolveOpencodeHome(descriptor: NodeDescriptor): string {
  return resolveNodeCliHome(descriptor, '.opencode');
}

/** 画布实例版：解析 ctx 对应实例的 opencode base 目录。 */
export function resolveOpencodeHomeCtx(ctx: NodeInstanceContext): string {
  return resolveInstanceCliHome(ctx, '.opencode');
}

/** 构造给 opencode 子进程的 env（XDG 指向项目内 + OPENCODE_CONFIG 指向 per-node 配置） */
export function opencodeXdgEnv(home: string, configPath?: string): Record<string, string> {
  const env: Record<string, string> = {
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_STATE_HOME: join(home, 'state'),
    ...nodeTempEnv(home),
  };
  if (configPath) env.OPENCODE_CONFIG = configPath;
  return env;
}

export interface OpencodeInvocation {
  command: string;
  shell: boolean;
}

const invocationCache = new Map<string, OpencodeInvocation>();

/** Resolve the Windows npm shim to the native executable so it remains the managed child process. */
export function resolveOpencodeInvocation(command: string): OpencodeInvocation {
  if (process.platform !== 'win32') return { command, shell: false };
  const cacheKey = `${command}\0${process.env.PATH ?? ''}`;
  const cached = invocationCache.get(cacheKey);
  if (cached && (cached.shell || existsSync(cached.command))) return cached;
  if (extname(command).toLowerCase() === '.exe' && existsSync(command)) {
    const invocation = { command, shell: false };
    invocationCache.set(cacheKey, invocation);
    return invocation;
  }

  const lookup = extname(command) ? command : `${command}.cmd`;
  const found = spawnSync('where.exe', [lookup], { encoding: 'utf-8', shell: false });
  if (found.status === 0) {
    for (const shim of String(found.stdout).split(/\r?\n/).filter(Boolean)) {
      const native = join(dirname(shim.trim()), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
      if (existsSync(native)) {
        const invocation = { command: native, shell: false };
        invocationCache.set(cacheKey, invocation);
        return invocation;
      }
    }
  }
  const invocation = { command, shell: true };
  invocationCache.set(cacheKey, invocation);
  return invocation;
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
  if (resolved.storage.config.identityFile) instructions.push(toAbs(resolved.storage.config.identityFile));
  for (const pattern of resolved.storage.config.rulesFiles) {
    instructions.push(toAbs(pattern));
  }
  const cfg: Record<string, unknown> = { $schema: 'https://opencode.ai/config.json' };
  if (instructions.length > 0) cfg.instructions = instructions;
  if (descriptor.model) {
    cfg.model = descriptor.model;
    cfg.small_model = descriptor.model;
  }
  // Snapshotting the workspace recursively scans per-node CLI homes and can deadlock its internal git repo.
  cfg.snapshot = false;
  cfg.watcher = { ignore: ['agents/*/data/cli/**', 'agents/*/runtime/**', 'shared/**/runtime/**'] };
  cfg.permission = { edit: 'allow', bash: 'allow', write: 'allow' };
  const content = JSON.stringify(cfg, null, 2);
  try {
    if (readFileSync(configPath, 'utf-8') === content) return configPath;
  } catch {
    // Missing/unreadable config is rewritten below.
  }
  writeFileSync(configPath, content, 'utf-8');
  return configPath;
}

/** 画布实例版：写 per-node opencode.json（instructions 用 ctx 解析后的绝对路径）。 */
export function writeOpencodeConfigCtx(ctx: NodeInstanceContext, home: string): string {
  const configDir = join(home, 'config', 'opencode');
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'opencode.json');
  const resolved = resolveInstanceDescriptorPaths(ctx);
  const toAbs = (p: string): string => p.replace(/\\/g, '/');
  const instructions: string[] = [];
  if (resolved.storage.config.identityFile) instructions.push(toAbs(resolved.storage.config.identityFile));
  for (const pattern of resolved.storage.config.rulesFiles) instructions.push(toAbs(pattern));
  const cfg: Record<string, unknown> = { $schema: 'https://opencode.ai/config.json' };
  if (instructions.length > 0) cfg.instructions = instructions;
  if (ctx.descriptor.model) {
    cfg.model = ctx.descriptor.model;
    cfg.small_model = ctx.descriptor.model;
  }
  cfg.snapshot = false;
  cfg.watcher = { ignore: ['agents/*/data/cli/**', 'agents/*/runtime/**', 'shared/**/runtime/**'] };
  cfg.permission = { edit: 'allow', bash: 'allow', write: 'allow' };
  const content = JSON.stringify(cfg, null, 2);
  try {
    if (readFileSync(configPath, 'utf-8') === content) return configPath;
  } catch {
    // Missing/unreadable config is rewritten below.
  }
  writeFileSync(configPath, content, 'utf-8');
  return configPath;
}

/** 确保项目内 opencode home 可用：建目录 + 复制 auth（缺失才复制） */
export function ensureOpencodeHome(home: string): void {
  const dataOpencode = join(home, 'data', 'opencode');
  mkdirSync(join(dataOpencode), { recursive: true });
  mkdirSync(join(home, 'config', 'opencode'), { recursive: true });
  mkdirSync(join(home, 'cache', 'opencode'), { recursive: true });
  mkdirSync(join(home, 'state', 'opencode'), { recursive: true });
  ensureNodeTemp(home);

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
