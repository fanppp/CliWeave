/**
 * per-node 历史对话存储
 * 仅用于显示；真实记忆在 CLI 的 resume 会话里。
 * 存 agents/<node>/sessions/history.jsonl（每行一条 JSON）。
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getProjectRoot } from '../utils/project-root.js';
import type { NodeDescriptor } from './NodeDescriptor.js';
import { resolveDescriptorPaths } from './NodeDescriptor.js';

export interface HistoryEntry {
  role: 'user' | 'agent';
  content: string;
  type?: string;
  toolName?: string;
  timestamp: number;
}

function historyFile(descriptor: NodeDescriptor): string {
  const resolved = resolveDescriptorPaths(descriptor);
  const dir = resolved.memory?.session?.dir ?? join('agents', descriptor.id, 'sessions');
  return resolve(getProjectRoot(), dir, 'history.jsonl');
}

/** 追加一条历史（用户消息或 Agent 消息） */
export function appendHistory(descriptor: NodeDescriptor, entry: HistoryEntry): void {
  const file = historyFile(descriptor);
  const dir = resolve(file, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
}

/** 读取某节点全部历史 */
export function readHistory(descriptor: NodeDescriptor): HistoryEntry[] {
  const file = historyFile(descriptor);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
    const entries: HistoryEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as HistoryEntry);
      } catch {
        // 损坏行跳过
      }
    }
    return entries;
  } catch {
    return [];
  }
}
