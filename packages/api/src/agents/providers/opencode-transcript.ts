/** OpenCode transcript reader backed by the project-local native CLI database. */
import { spawn } from 'node:child_process';
import type { HistoryEntry } from '../types.js';
import { resolveOpencodeInvocation } from '../opencode-home.js';

interface OpencodePart {
  type?: string;
  text?: string;
  tool?: string;
  input?: unknown;
}

interface OpencodeMessage {
  info?: { role?: string; time?: { created?: number } };
  parts?: OpencodePart[];
}

interface CacheEntry<T> {
  expiresAt: number;
  value: Promise<T>;
}

const CACHE_TTL_MS = 1_000;
const exportCache = new Map<string, CacheEntry<OpencodeMessage[] | null>>();
const sessionsCache = new Map<string, CacheEntry<SessionSummary[]>>();

function cacheKey(command: string, env: Record<string, string>, suffix = ''): string {
  return `${command}\0${env.XDG_DATA_HOME ?? ''}\0${suffix}`;
}

function cached<T>(cache: Map<string, CacheEntry<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const value = load();
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, value });
  void value.catch(() => cache.delete(key));
  return value;
}

function runJson(command: string, args: string[], xdgEnv: Record<string, string>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve) => {
    const invocation = resolveOpencodeInvocation(command);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, args, {
        shell: invocation.shell,
        windowsHide: true,
        env: { ...process.env, ...xdgEnv },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        child.kill();
        finish(null);
      } else {
        chunks.push(chunk);
      }
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) return finish(null);
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown);
      } catch {
        finish(null);
      }
    });
  });
}

function stripL0Prefix(text: string): string {
  const marker = '\n\n---\n\n';
  const index = text.lastIndexOf(marker);
  return index >= 0 ? text.slice(index + marker.length).trim() : text.trim();
}

async function exportSession(
  sessionId: string,
  command = 'opencode',
  xdgEnv: Record<string, string> = {},
): Promise<OpencodeMessage[] | null> {
  try {
    return await cached(exportCache, cacheKey(command, xdgEnv, sessionId), async () => {
      const parsed = await runJson(command, ['export', sessionId], xdgEnv, 10_000) as Record<string, unknown> | null;
      return parsed && Array.isArray(parsed.messages) ? parsed.messages as OpencodeMessage[] : null;
    });
  } catch {
    exportCache.delete(cacheKey(command, xdgEnv, sessionId));
    return null;
  }
}

export async function readOpencodeTranscript(
  sessionId: string,
  command = 'opencode',
  xdgEnv: Record<string, string> = {},
): Promise<HistoryEntry[]> {
  const messages = await exportSession(sessionId, command, xdgEnv);
  if (!messages) return [];
  const entries: HistoryEntry[] = [];
  for (const msg of messages) {
    const role = msg.info?.role;
    const timestamp = msg.info?.time?.created ?? Date.now();
    for (const part of Array.isArray(msg.parts) ? msg.parts : []) {
      if (part.type === 'text' && typeof part.text === 'string') {
        if (role === 'user') {
          const content = stripL0Prefix(part.text);
          if (content) entries.push({ role: 'user', content, timestamp });
        } else if (role === 'assistant' && part.text.trim()) {
          entries.push({ role: 'agent', type: 'text', content: part.text, timestamp });
        }
      } else if (part.type === 'tool' && typeof part.tool === 'string') {
        let content = '';
        try {
          content = part.input ? JSON.stringify(part.input, null, 2) : '';
        } catch {
          content = String(part.input ?? '');
        }
        entries.push({ role: 'agent', type: 'tool_use', toolName: part.tool, content, timestamp });
      }
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

export async function listOpencodeSessions(
  command = 'opencode',
  xdgEnv: Record<string, string> = {},
): Promise<SessionSummary[]> {
  const key = cacheKey(command, xdgEnv);
  try {
    return await cached(sessionsCache, key, async () => {
      const parsed = await runJson(command, ['session', 'list', '--format', 'json'], xdgEnv, 5_000) as unknown;
      const sessions: Array<Record<string, unknown>> = Array.isArray(parsed)
        ? parsed.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>).sessions)
          ? ((parsed as Record<string, unknown>).sessions as unknown[])
              .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
          : [];
      return sessions.flatMap((session) => {
      const sessionId = typeof session.id === 'string'
        ? session.id
        : typeof session.sessionID === 'string' ? session.sessionID : '';
      if (!sessionId) return [];
      return [{
        sessionId,
        startedAt: typeof session.created === 'number'
          ? session.created
          : typeof session.createdAt === 'number' ? session.createdAt : Date.now(),
        preview: typeof session.title === 'string' ? session.title.slice(0, 60) : '(opencode 会话)',
        messageCount: typeof session.messageCount === 'number' ? session.messageCount : 0,
      }];
      });
    });
  } catch {
    sessionsCache.delete(key);
    return [];
  }
}
