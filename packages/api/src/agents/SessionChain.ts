/**
 * per-node 会话链
 * 存/取每个节点的当前活跃 sessionId，供 CLI --resume 续上下文。
 * 借鉴 clowder-ai SessionChainStore（精简：每节点一个 active.json）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getProjectRoot } from '../utils/project-root.js';
import type { NodeDescriptor } from './NodeDescriptor.js';
import { resolveDescriptorPaths } from './NodeDescriptor.js';

interface ActiveSession {
  sessionId: string;
  updatedAt: number;
}

function sessionsDir(descriptor: NodeDescriptor): string {
  const resolved = resolveDescriptorPaths(descriptor);
  const dir = resolved.memory?.session?.dir ?? join('agents', descriptor.id, 'sessions');
  return resolve(getProjectRoot(), dir);
}

/** 读取节点当前活跃 sessionId（用于 resume） */
export function getActiveSession(descriptor: NodeDescriptor): string | undefined {
  if (descriptor.memory?.session?.resume === false) return undefined;
  const dir = sessionsDir(descriptor);
  const file = join(dir, 'active.json');
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

/** 记录节点新会话的 sessionId（来自 CLI session_init 事件） */
export function setActiveSession(descriptor: NodeDescriptor, sessionId: string): void {
  if (descriptor.memory?.session?.resume === false) return;
  const dir = sessionsDir(descriptor);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, 'active.json');
  const data: ActiveSession = { sessionId, updatedAt: Date.now() };
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/** 清除节点活跃会话（重置） */
export function clearActiveSession(descriptor: NodeDescriptor): void {
  const dir = sessionsDir(descriptor);
  const file = join(dir, 'active.json');
  if (existsSync(file)) writeFileSync(file, '{}\n', 'utf-8');
}
