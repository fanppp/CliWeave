/**
 * opencode 会话 transcript 读取器
 * opencode 把会话存全局 SQLite(~/.local/share/opencode/opencode.db)，不是文件。
 * 用 `opencode export <sid>` 子进程读 JSON 再解析成 HistoryEntry。
 * （故 opencode 的记忆不落项目，这是 opencode 本身限制；active.json 仍记 sessionId）
 */
import { spawnSync } from 'node:child_process';
import type { HistoryEntry } from '../HistoryStore.js';

interface OpencodePart {
  type: string;
  text?: string;
  tool?: string;
  input?: unknown;
}
interface OpencodeMessage {
  info?: { role?: string; time?: { created?: number } };
  parts?: OpencodePart[];
}

/** 剥掉我注入的 L0 前缀（identity+rules + "\n\n---\n\n" + 真实 prompt） */
function stripL0Prefix(text: string): string {
  const idx = text.indexOf('\n\n---\n\n');
  if (idx >= 0) return text.slice(idx + '\n\n---\n\n'.length).trim();
  return text.trim();
}

/** 调 opencode export 读会话 JSON */
function exportSession(sessionId: string, command = 'opencode'): OpencodeMessage[] | null {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(command, ['export', sessionId], {
      encoding: 'utf-8',
      shell: process.platform === 'win32',
      timeout: 15_000,
    });
  } catch {
    return null;
  }
  if (result.error || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(String(result.stdout));
    return Array.isArray(parsed.messages) ? (parsed.messages as OpencodeMessage[]) : null;
  } catch {
    return null;
  }
}

export function readOpencodeTranscript(sessionId: string, command = 'opencode'): HistoryEntry[] {
  const messages = exportSession(sessionId, command);
  if (!messages) return [];
  const entries: HistoryEntry[] = [];
  for (const msg of messages) {
    const role = msg.info?.role;
    const ts = msg.info?.time?.created ?? Date.now();
    const parts = msg.parts ?? [];
    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string') {
        if (role === 'user') {
          const cleaned = stripL0Prefix(part.text);
          if (cleaned.length > 0) entries.push({ role: 'user', content: cleaned, timestamp: ts });
        } else if (role === 'assistant') {
          if (part.text.trim().length > 0) entries.push({ role: 'agent', type: 'text', content: part.text, timestamp: ts });
        }
      } else if (part.type === 'tool' && typeof part.tool === 'string') {
        let argsText = '';
        try {
          argsText = part.input ? JSON.stringify(part.input, null, 2) : '';
        } catch {
          argsText = String(part.input ?? '');
        }
        entries.push({ role: 'agent', type: 'tool_use', toolName: part.tool, content: argsText, timestamp: ts });
      }
      // reasoning/tool_output 等跳过
    }
  }
  return entries;
}

export interface SessionSummary {
  sessionId: string;
  startedAt: number;
  preview: string;
  messageCount: number;
}

/** opencode 会话列表：用 `opencode session list`（若支持 JSON） */
export function listOpencodeSessions(command = 'opencode'): SessionSummary[] {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(command, ['session', 'list'], { encoding: 'utf-8', shell: process.platform === 'win32', timeout: 10_000 });
  } catch {
    return [];
  }
  if (result.error || result.status !== 0) return [];
  try {
    const parsed = JSON.parse(String(result.stdout));
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    const out: SessionSummary[] = [];
    for (const s of arr as Array<Record<string, unknown>>) {
      const sid = typeof s.id === 'string' ? s.id : (typeof s.sessionID === 'string' ? s.sessionID : '');
      if (!sid) continue;
      out.push({
        sessionId: sid,
        startedAt: typeof s.createdAt === 'number' ? s.createdAt : (typeof s.time === 'object' && s.time ? Date.now() : Date.now()),
        preview: typeof s.title === 'string' ? s.title.slice(0, 60) : '(opencode 会话)',
        messageCount: typeof s.messageCount === 'number' ? s.messageCount : 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}
