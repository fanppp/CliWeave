/**
 * transcript 调度器：按 provider 选对应的 transcript reader + session lister。
 * 加新 CLI = 在这里加一个 case + 写该 CLI 的 transcript reader。
 */
import type { HistoryEntry } from './HistoryStore.js';
import type { NodeDescriptor } from './NodeDescriptor.js';
import { resolveCodexHome } from './codex-home.js';
import { listCodexSessions, readCodexTranscript } from './providers/codex-transcript.js';
import { resolveClaudeHome } from './claude-home.js';
import { listClaudeSessions, readClaudeTranscript } from './providers/claude-transcript.js';
import { listOpencodeSessions, readOpencodeTranscript } from './providers/opencode-transcript.js';

export interface SessionSummary {
  sessionId: string;
  startedAt: number;
  preview: string;
  messageCount: number;
}

export function readNodeTranscript(descriptor: NodeDescriptor, sessionId: string): HistoryEntry[] {
  switch (descriptor.provider) {
    case 'codex':
      return readCodexTranscript(sessionId, resolveCodexHome(descriptor));
    case 'claude':
      return readClaudeTranscript(sessionId, resolveClaudeHome(descriptor));
    case 'opencode':
      return readOpencodeTranscript(sessionId, descriptor.cli.command);
    default:
      return [];
  }
}

export function listNodeSessions(descriptor: NodeDescriptor): SessionSummary[] {
  switch (descriptor.provider) {
    case 'codex':
      return listCodexSessions(resolveCodexHome(descriptor));
    case 'claude':
      return listClaudeSessions(resolveClaudeHome(descriptor));
    case 'opencode':
      return listOpencodeSessions(descriptor.cli.command);
    default:
      return [];
  }
}
