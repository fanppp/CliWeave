/**
 * per-node 会话链
 * 存/取每个节点的当前活跃 sessionId，供 CLI --resume 续上下文。
 * 借鉴 clowder-ai SessionChainStore（精简：每节点一个 active.json）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getProjectRoot } from '../utils/project-root.js';
import type { NodeDescriptor } from './NodeDescriptor.js';
import { resolveDescriptorPaths } from './NodeDescriptor.js';
import type { NodeInstanceContext } from './node-instance.js';

interface ActiveSession {
  sessionId: string;
  updatedAt: number;
}

function activeSessionFile(descriptor: NodeDescriptor): string {
  const resolved = resolveDescriptorPaths(descriptor);
  return resolve(getProjectRoot(), resolved.storage.runtime.activeSessionFile);
}

/** 画布实例版：active session 文件（ctx.nodeDir + V4 tail）。 */
function activeSessionFileCtx(ctx: NodeInstanceContext): string {
  return resolve(ctx.nodeDir, ctx.descriptor.storage.runtime.activeSessionFile);
}

/** 读取节点当前活跃 sessionId（用于 resume） */
export function getActiveSession(descriptor: NodeDescriptor): string | undefined {
  if (!descriptor.storage.runtime.resume) return undefined;
  const file = activeSessionFile(descriptor);
  if (!existsSync(file)) return undefined;
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    if (
      typeof data === 'object' &&
      data !== null &&
      typeof (data as ActiveSession).sessionId === 'string'
    ) {
      return (data as ActiveSession).sessionId;
    }
  } catch {
    // 损坏的 active.json 忽略，下次会重新建会话
  }
  return undefined;
}

/** 画布实例版：读取实例当前活跃 sessionId。 */
export function getActiveSessionCtx(ctx: NodeInstanceContext): string | undefined {
  if (!ctx.descriptor.storage.runtime.resume) return undefined;
  const file = activeSessionFileCtx(ctx);
  if (!existsSync(file)) return undefined;
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    if (
      typeof data === 'object' &&
      data !== null &&
      typeof (data as ActiveSession).sessionId === 'string'
    ) {
      return (data as ActiveSession).sessionId;
    }
  } catch {
    // 损坏的 active.json 忽略
  }
  return undefined;
}

/** 记录节点新会话的 sessionId（来自 CLI session_init 事件） */
export function setActiveSession(descriptor: NodeDescriptor, sessionId: string): void {
  if (!descriptor.storage.runtime.resume) return;
  const file = activeSessionFile(descriptor);
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data: ActiveSession = { sessionId, updatedAt: Date.now() };
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/** 画布实例版：记录实例新会话的 sessionId。 */
export function setActiveSessionCtx(ctx: NodeInstanceContext, sessionId: string): void {
  if (!ctx.descriptor.storage.runtime.resume) return;
  const file = activeSessionFileCtx(ctx);
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data: ActiveSession = { sessionId, updatedAt: Date.now() };
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/** 清除节点活跃会话（重置） */
export function clearActiveSession(descriptor: NodeDescriptor): void {
  const file = activeSessionFile(descriptor);
  if (existsSync(file)) writeFileSync(file, '{}\n', 'utf-8');
}

/** 画布实例版：清除实例活跃会话。 */
export function clearActiveSessionCtx(ctx: NodeInstanceContext): void {
  const file = activeSessionFileCtx(ctx);
  if (existsSync(file)) writeFileSync(file, '{}\n', 'utf-8');
}
