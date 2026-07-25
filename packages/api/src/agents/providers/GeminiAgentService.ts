/**
 * GeminiAgentService —— 用 gemini CLI 驱动一个节点（按 clowder-ai 文档实现，待实测校准）
 *
 * 命令（gemini-cli）：
 *   gemini -p "prompt" -o stream-json -y [--resume <sessionId>] [-i image]
 *   prompt 作为 -p 参数；resume 用 --resume。
 */
import { spawnCli, isCliError, isCliTimeout } from '../../utils/cli-spawn.js';
import type { CliSpawnOptions } from '../../utils/cli-types.js';
import type { AgentService, AgentServiceOptions } from '../AgentService.js';
import type { AgentMessage, MessageMetadata, NodeId } from '../types.js';
import { nodeKeyOf, type NodeDescriptor } from '../NodeDescriptor.js';
import { transformGeminiEvent } from './gemini-event-transform.js';

export class GeminiAgentService implements AgentService {
  readonly nodeId: NodeId;
  readonly provider = 'gemini';
  private readonly descriptor: NodeDescriptor;
  private readonly compiledL0: string | undefined;

  constructor(descriptor: NodeDescriptor, compiledL0: string | undefined) {
    this.descriptor = descriptor;
    this.compiledL0 = compiledL0;
    this.nodeId = nodeKeyOf(descriptor);
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const model = this.descriptor.model;
    const metadata: MessageMetadata = { provider: 'google', ...(model ? { model } : {}) };
    const sessionId = options?.sessionId;
    const cwd = options?.workingDirectory ?? this.descriptor.cli.cwd;

    const effectivePrompt = this.compiledL0 ? `${this.compiledL0}\n\n---\n\n${prompt}` : prompt;

    const args: string[] = [
      '-p',
      effectivePrompt,
      '-o',
      'stream-json',
      '-y',
      ...(sessionId ? ['--resume', sessionId] : []),
      ...this.descriptor.cli.extraArgs,
    ];

    const spawnOpts: CliSpawnOptions = {
      command: this.descriptor.cli.command,
      args,
      cwd,
      env: {},
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
    };

    let terminalYielded = false;
    try {
      for await (const event of spawnCli(spawnOpts)) {
        if (isCliTimeout(event)) {
          terminalYielded = true;
          yield { type: 'error', nodeId: this.nodeId, error: `Gemini CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s)`, metadata, timestamp: Date.now() };
          yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
          return;
        }
        if (isCliError(event)) {
          terminalYielded = true;
          yield { type: 'error', nodeId: this.nodeId, error: `Gemini CLI 异常退出 (code: ${event.exitCode ?? 'null'})`, metadata, timestamp: Date.now() };
          yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
          return;
        }
        for (const msg of transformGeminiEvent(event, this.nodeId)) {
          if (msg.type === 'done' || msg.type === 'error') terminalYielded = true;
          yield msg;
        }
      }
      if (!terminalYielded) {
        yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
      }
    } catch (err) {
      yield { type: 'error', nodeId: this.nodeId, error: `Gemini 调用失败: ${(err as Error).message}`, metadata, timestamp: Date.now() };
      yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
    }
  }
}
