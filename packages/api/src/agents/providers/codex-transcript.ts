/**
 * codex 会话 transcript 读取器
 * 直接读 per-node 项目内 CODEX_HOME/sessions/ 下的 rollout-<ts>-<sessionId>.jsonl
 * 单一真相源 = codex 自己的会话记忆（resume 也用它），全部存在本项目里。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryEntry } from '../HistoryStore.js';

/** 递归找含 sessionId 的 rollout 文件（在指定 codexHome/sessions 下） */
function findRolloutFile(sessionId: string, codexHome: string): string | undefined {
  const sessionsDir = join(codexHome, 'sessions');
  if (!existsSync(sessionsDir)) return undefined;
  const stack: string[] = [sessionsDir];
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

/** 从文件名提取 sessionId（rollout-<ts>-<sessionId>.jsonl） */
function extractRolloutSessionId(file: string): string | undefined {
  const base = file.split(/[\\/]/).pop() ?? '';
  const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m ? m[1] : undefined;
}

/** 从 user 消息文本里剥掉 codex 自动注入的包裹 */
function stripEnvContext(text: string): string {
  return text
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/g, '')
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/g, '')
    .replace(/<multi_agent_mode>[\s\S]*?<\/multi_agent_mode>/g, '')
    .trim();
}

/** 解析单个 rollout 文件 → HistoryEntry[] */
function parseRolloutFile(file: string): HistoryEntry[] {
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
      const parsed = Date.parse(obj.timestamp);
      if (Number.isFinite(parsed)) ts = parsed;
    }
    if (obj.type !== 'response_item') continue;
    const payload = obj.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') continue;
    const pType = payload.type;

    if (pType === 'message') {
      const role = payload.role;
      const content = payload.content;
      if (!Array.isArray(content)) continue;
      const texts = content
        .filter((c) => typeof c === 'object' && c !== null)
        .map((c) => (c as Record<string, unknown>).text)
        .filter((t): t is string => typeof t === 'string');
      const joined = texts.join('\n');
      if (joined.trim().length === 0) continue;
      if (role === 'user') {
        const cleaned = stripEnvContext(joined);
        if (cleaned.length > 0) entries.push({ role: 'user', content: cleaned, timestamp: ts });
      } else if (role === 'assistant') {
        entries.push({ role: 'agent', type: 'text', content: joined, timestamp: ts });
      }
    } else if (pType === 'function_call') {
      const name = typeof payload.name === 'string' ? payload.name : 'tool';
      let argsText = '';
      if (typeof payload.arguments === 'string') {
        try {
          argsText = JSON.stringify(JSON.parse(payload.arguments), null, 2);
        } catch {
          argsText = payload.arguments;
        }
      }
      entries.push({ role: 'agent', type: 'tool_use', toolName: name, content: argsText, timestamp: ts });
    } else if (pType === 'function_call_output') {
      const output = payload.output;
      let text = '';
      if (typeof output === 'string') text = output;
      else if (output && typeof output === 'object') text = JSON.stringify(output);
      entries.push({ role: 'agent', type: 'tool_result', content: text.slice(0, 2000), timestamp: ts });
    }
  }
  return entries;
}

/** 读取某 codex 会话的对话记录（用户+Agent+工具），从 per-node codexHome */
export function readCodexTranscript(sessionId: string, codexHome: string): HistoryEntry[] {
  const file = findRolloutFile(sessionId, codexHome);
  if (!file) return [];
  return parseRolloutFile(file);
}

export interface SessionSummary {
  sessionId: string;
  startedAt: number;
  preview: string;
  messageCount: number;
}

/** 列出某节点项目内的全部 codex 会话（按时间倒序） */
export function listCodexSessions(codexHome: string): SessionSummary[] {
  const sessionsDir = join(codexHome, 'sessions');
  if (!existsSync(sessionsDir)) return [];
  const files: { file: string; mtime: number }[] = [];
  const stack: string[] = [sessionsDir];
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
        } else if (entry.endsWith('.jsonl')) {
          files.push({ file: full, mtime: statSync(full).mtimeMs });
        }
      } catch {
        // 跳过
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const summaries: SessionSummary[] = [];
  for (const { file } of files) {
    const sessionId = extractRolloutSessionId(file);
    if (!sessionId) continue;
    const entries = parseRolloutFile(file);
    const firstUser = entries.find((e) => e.role === 'user');
    summaries.push({
      sessionId,
      startedAt: entries[0]?.timestamp ?? Math.round(files.find((f) => f.file === file)?.mtime ?? Date.now()),
      preview: firstUser ? firstUser.content.slice(0, 60) : '(无用户消息)',
      messageCount: entries.length,
    });
  }
  return summaries;
}
