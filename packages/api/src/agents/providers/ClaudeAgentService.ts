/**
 * ClaudeAgentService —— 用 Claude Code CLI 驱动一个节点
 *
 * 实测命令（claude 2.1.100）：
 *   claude -p --output-format stream-json --verbose --dangerously-skip-permissions \
 *         [--model <m>] [--append-system-prompt "<L0>"] [--resume <sid>]
 *   prompt 经 stdin 传入。
 *   记忆/会话存项目内 CLAUDE_CONFIG_DIR=agents/<node>/memory/.claude。
 */
import { spawnCli, isCliError, isCliTimeout } from '../../utils/cli-spawn.js';
import type { CliSpawnOptions } from '../../utils/cli-types.js';
import type { AgentService, AgentServiceOptions } from '../AgentService.js';
import type { AgentMessage, MessageMetadata, NodeId } from '../types.js';
import type { NodeDescriptor } from '../NodeDescriptor.js';
import { ensureClaudeHome, resolveClaudeHome } from '../claude-home.js';
import { transformClaudeEvent } from './claude-event-transform.js';

export class ClaudeAgentService implements AgentService {
  readonly nodeId: NodeId;
  readonly provider = 'claude';
  private readonly descriptor: NodeDescriptor;
  private readonly compiledL0: string | undefined;

  constructor(descriptor: NodeDescriptor, compiledL0: string | undefined) {
    this.descriptor = descriptor;
    this.compiledL0 = compiledL0;
    this.nodeId = descriptor.id;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const model = this.descriptor.model;
    const metadata: MessageMetadata = { provider: 'anthropic', ...(model ? { model } : {}) };
    const sessionId = options?.sessionId;
    const cwd = options?.workingDirectory ?? this.descriptor.cli.cwd;

    // per-node 项目内 claude home
    const claudeHome = resolveClaudeHome(this.descriptor);
    ensureClaudeHome(claudeHome);

    const args: string[] = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      ...(model ? ['--model', model] : []),
      ...(this.compiledL0 ? ['--append-system-prompt', this.compiledL0] : []),
      ...(sessionId ? ['--resume', sessionId] : []),
      ...this.descriptor.cli.extraArgs,
    ];

    const spawnOpts: CliSpawnOptions = {
      command: this.descriptor.cli.command,
      args,
      cwd,
      stdinInput: prompt,
      env: { CLAUDE_CONFIG_DIR: claudeHome },
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
    };

    let terminalYielded = false;
    try {
      for await (const event of spawnCli(spawnOpts)) {
        if (isCliTimeout(event)) {
          terminalYielded = true;
          yield { type: 'error', nodeId: this.nodeId, error: `Claude CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s)`, metadata, timestamp: Date.now() };
          yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
          return;
        }
        if (isCliError(event)) {
          terminalYielded = true;
          yield { type: 'error', nodeId: this.nodeId, error: `Claude CLI 异常退出 (code: ${event.exitCode ?? 'null'})`, metadata, timestamp: Date.now() };
          yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
          return;
        }
        for (const msg of transformClaudeEvent(event, this.nodeId)) {
          if (msg.type === 'done' || msg.type === 'error') terminalYielded = true;
          yield msg;
        }
      }
      if (!terminalYielded) {
        yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
      }
    } catch (err) {
      yield { type: 'error', nodeId: this.nodeId, error: `Claude 调用失败: ${(err as Error).message}`, metadata, timestamp: Date.now() };
      yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
    }
  }
}
