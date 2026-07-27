/**
 * ClaudeAgentService —— 用 Claude Code CLI 驱动一个节点
 *
 * 实测命令（claude 2.1.100）：
 *   claude -p --output-format stream-json --verbose --dangerously-skip-permissions \
 *         [--model <m>] [--append-system-prompt "<L0>"] [--resume <sid>]
 *   prompt 经 stdin 传入。
 *   记忆/会话存项目内 CLAUDE_CONFIG_DIR=agents/<node>/data/cli/.claude。
 */
import { spawnCli, isCliError, isCliTimeout } from '../../utils/cli-spawn.js';
import type { CliSpawnOptions } from '../../utils/cli-types.js';
import type { AgentService, AgentServiceOptions } from '../AgentService.js';
import type { AgentMessage, MessageMetadata, NodeId } from '../types.js';
import { nodeKeyOf, type NodeDescriptor } from '../NodeDescriptor.js';
import { claudeEnv, ensureClaudeHome, resolveClaudeHome } from '../claude-home.js';
import { transformClaudeEvent } from './claude-event-transform.js';

type RunStatus = 'ok' | 'error' | 'resume-failed';

export class ClaudeAgentService implements AgentService {
  readonly nodeId: NodeId;
  readonly provider = 'claude';
  private readonly descriptor: NodeDescriptor;
  private readonly compiledL0: string | undefined;

  constructor(descriptor: NodeDescriptor, compiledL0: string | undefined) {
    this.descriptor = descriptor;
    this.compiledL0 = compiledL0;
    this.nodeId = nodeKeyOf(descriptor);
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const sessionId = options?.sessionId;
    if (sessionId) {
      // 先尝试 resume；若陈旧 session 快速失败（无实质输出）则回退全新会话
      const status = yield* this.runOnce(prompt, options, sessionId, true);
      if (status === 'resume-failed') {
        yield {
          type: 'system_info',
          nodeId: this.nodeId,
          content: 'resume 失败（会话已陈旧），已回退到全新会话',
          timestamp: Date.now(),
        };
        yield* this.runOnce(prompt, options, undefined, false);
      }
      return;
    }
    yield* this.runOnce(prompt, options, undefined, false);
  }

  /**
   * 单次执行（resume 或 fresh）。
   * suppressResumeError=true 时，若 resume 快速失败（无实质输出），不 yield 错误，返回 'resume-failed' 供上层回退。
   */
  private async *runOnce(
    prompt: string,
    options: AgentServiceOptions | undefined,
    sessionId: string | undefined,
    suppressResumeError: boolean,
  ): AsyncGenerator<AgentMessage, RunStatus> {
    const model = this.descriptor.model;
    const metadata: MessageMetadata = { provider: 'anthropic', ...(model ? { model } : {}) };
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
      env: claudeEnv(claudeHome),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
    };

    let sawOutput = false;
    let terminalYielded = false;
    try {
      for await (const event of spawnCli(spawnOpts)) {
        if (isCliTimeout(event)) {
          terminalYielded = true;
          yield { type: 'error', nodeId: this.nodeId, error: `Claude CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s)`, metadata, timestamp: Date.now() };
          yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
          return 'error';
        }
        if (isCliError(event)) {
          // resume 快速失败（无实质输出）：陈旧 session，回退全新会话
          if (suppressResumeError && sessionId && !sawOutput) {
            return 'resume-failed';
          }
          terminalYielded = true;
          yield { type: 'error', nodeId: this.nodeId, error: `Claude CLI 异常退出 (code: ${event.exitCode ?? 'null'})`, metadata, timestamp: Date.now() };
          yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
          return 'error';
        }
        for (const msg of transformClaudeEvent(event, this.nodeId)) {
          if (msg.type === 'text' || msg.type === 'tool_use' || msg.type === 'tool_result') sawOutput = true;
          if (msg.type === 'done' || msg.type === 'error') terminalYielded = true;
          yield msg;
        }
      }
      if (!terminalYielded) {
        yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
      }
      return 'ok';
    } catch (err) {
      yield { type: 'error', nodeId: this.nodeId, error: `Claude 调用失败: ${(err as Error).message}`, metadata, timestamp: Date.now() };
      yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
      return 'error';
    }
  }
}
