/**
 * transcript 调度器：按 provider 选对应的 transcript reader + session lister。
 * 加新 CLI = 在这里加一个 case + 写该 CLI 的 transcript reader。
 */
import type { HistoryEntry } from './types.js';
import type { NodeDescriptor } from './NodeDescriptor.js';
import type { NodeInstanceContext } from './node-instance.js';
import { resolveCodexHome, resolveCodexHomeCtx } from './codex-home.js';
import { listCodexSessions, readCodexTranscript } from './providers/codex-transcript.js';
import { resolveClaudeHome, resolveClaudeHomeCtx } from './claude-home.js';
import { listClaudeSessions, readClaudeTranscript } from './providers/claude-transcript.js';
import { opencodeXdgEnv, resolveOpencodeHome, resolveOpencodeHomeCtx } from './opencode-home.js';
import { listOpencodeSessions, readOpencodeTranscript } from './providers/opencode-transcript.js';

export interface SessionSummary {
  sessionId: string;
  startedAt: number;
  preview: string;
  messageCount: number;
}

export async function readNodeTranscript(descriptor: NodeDescriptor, sessionId: string): Promise<HistoryEntry[]> {
  switch (descriptor.provider) {
    case 'codex':
      return readCodexTranscript(sessionId, resolveCodexHome(descriptor));
    case 'claude':
      return readClaudeTranscript(sessionId, resolveClaudeHome(descriptor));
    case 'opencode': {
      const xdg = opencodeXdgEnv(resolveOpencodeHome(descriptor));
      return readOpencodeTranscript(sessionId, descriptor.cli.command, xdg);
    }
    default:
      return [];
  }
}

export async function listNodeSessions(descriptor: NodeDescriptor): Promise<SessionSummary[]> {
  switch (descriptor.provider) {
    case 'codex':
      return listCodexSessions(resolveCodexHome(descriptor));
    case 'claude':
      return listClaudeSessions(resolveClaudeHome(descriptor));
    case 'opencode': {
      const xdg = opencodeXdgEnv(resolveOpencodeHome(descriptor));
      return listOpencodeSessions(descriptor.cli.command, xdg);
    }
    default:
      return [];
  }
}

/** 画布实例版：按 ctx 解析实例的 CLI home，读 transcript。 */
export async function readNodeTranscriptCtx(ctx: NodeInstanceContext, sessionId: string): Promise<HistoryEntry[]> {
  switch (ctx.descriptor.provider) {
    case 'codex':
      return readCodexTranscript(sessionId, resolveCodexHomeCtx(ctx));
    case 'claude':
      return readClaudeTranscript(sessionId, resolveClaudeHomeCtx(ctx));
    case 'opencode': {
      const xdg = opencodeXdgEnv(resolveOpencodeHomeCtx(ctx));
      return readOpencodeTranscript(sessionId, ctx.descriptor.cli.command, xdg);
    }
    default:
      return [];
  }
}

/** 画布实例版：列实例的会话。 */
export async function listNodeSessionsCtx(ctx: NodeInstanceContext): Promise<SessionSummary[]> {
  switch (ctx.descriptor.provider) {
    case 'codex':
      return listCodexSessions(resolveCodexHomeCtx(ctx));
    case 'claude':
      return listClaudeSessions(resolveClaudeHomeCtx(ctx));
    case 'opencode': {
      const xdg = opencodeXdgEnv(resolveOpencodeHomeCtx(ctx));
      return listOpencodeSessions(ctx.descriptor.cli.command, xdg);
    }
    default:
      return [];
  }
}
