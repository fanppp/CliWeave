/**
 * claude 会话 transcript 读取器
 * 读 per-node CLAUDE_CONFIG_DIR/projects/<cwd-hash>/<sessionId>.jsonl
 * 解析成 HistoryEntry（单一真相源 = claude 自己的会话记忆，resume 也用它）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryEntry } from '../HistoryStore.js';

function stripEnvContext(text: string): string {
  return text
    .replace(/<environment_details>[\s\S]*?<\/environment_details>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .trim();
}

/** 在 claudeHome/projects 下找含 sessionId 的 jsonl */
function findSessionFile(sessionId: string, claudeHome: string): string | undefined {
  const projectsDir = join(claudeHome, 'projects');
  if (!existsSync(projectsDir)) return undefined;
  const stack: string[] = [projectsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) {
          stack.push(full);
        } else if (entry.endsWith('.jsonl') && entry.includes(sessionId)) {
          return full;
        }
      } catch {
        // 跳过
      }
    }
  }
  return undefined;
}

/** 解析单个 claude 会话文件 → HistoryEntry[] */
function parseSessionFile(file: string): HistoryEntry[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const entries: HistoryEntry[] = [];
  let ts = Date.now();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof obj.timestamp === 'string') {
      const p = Date.parse(obj.timestamp);
      if (Number.isFinite(p)) ts = p;
    }
    const type = obj.type;
    if (type !== 'user' && type !== 'assistant') continue;
    const msg = obj.message as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== 'object') continue;
    const content = msg.content;

    // content 可能是字符串或数组
    if (typeof content === 'string') {
      if (type === 'user') {
        const cleaned = stripEnvContext(content);
        if (cleaned.length > 0) entries.push({ role: 'user', content: cleaned, timestamp: ts });
      } else {
        if (content.trim().length > 0) entries.push({ role: 'agent', type: 'text', content, timestamp: ts });
      }
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      const btype = b.type;
      if (btype === 'text' && typeof b.text === 'string') {
        if (type === 'user') {
          const cleaned = stripEnvContext(b.text);
          if (cleaned.length > 0) entries.push({ role: 'user', content: cleaned, timestamp: ts });
        } else {
          entries.push({ role: 'agent', type: 'text', content: b.text, timestamp: ts });
        }
      } else if (btype === 'tool_use' && typeof b.name === 'string') {
        let argsText = '';
        try {
          argsText = JSON.stringify(b.input ?? {}, null, 2);
        } catch {
          argsText = String(b.input ?? '');
        }
        entries.push({ role: 'agent', type: 'tool_use', toolName: b.name, content: argsText, timestamp: ts });
      }
      // thinking / tool_result 跳过
    }
  }
  return entries;
}

export function readClaudeTranscript(sessionId: string, claudeHome: string): HistoryEntry[] {
  const file = findSessionFile(sessionId, claudeHome);
  if (!file) return [];
  return parseSessionFile(file);
}

export interface SessionSummary {
  sessionId: string;
  startedAt: number;
  preview: string;
  messageCount: number;
}

/** 列出某节点项目内 claude 全部会话 */
export function listClaudeSessions(claudeHome: string): SessionSummary[] {
  const projectsDir = join(claudeHome, 'projects');
  if (!existsSync(projectsDir)) return [];
  const files: { file: string; mtime: number }[] = [];
  const stack: string[] = [projectsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) stack.push(full);
        else if (entry.endsWith('.jsonl')) files.push({ file: full, mtime: statSync(full).mtimeMs });
      } catch {
        // 跳过
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: SessionSummary[] = [];
  for (const { file } of files) {
    const m = file.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    const sessionId = m ? m[1] : file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '');
    const entries = parseSessionFile(file);
    const firstUser = entries.find((e) => e.role === 'user');
    out.push({
      sessionId,
      startedAt: entries[0]?.timestamp ?? Math.round(files.find((f) => f.file === file)!.mtime),
      preview: firstUser ? firstUser.content.slice(0, 60) : '(无用户消息)',
      messageCount: entries.length,
    });
  }
  return out;
}
