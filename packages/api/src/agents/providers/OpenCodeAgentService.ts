/**
 * OpenCodeAgentService —— 用 opencode CLI 驱动一个节点
 *
 * 实测命令（opencode 1.18.4）：
 *   opencode run --format json [-m provider/model] [-s <sessionID>] "<prompt>"
 *   prompt 作为位置参数传入；resume 用 -s；记忆=会话(opencode 自管)。
 */
import { spawnCli, isCliError, isCliTimeout } from '../../utils/cli-spawn.js';
import type { CliSpawnOptions } from '../../utils/cli-types.js';
import type { AgentService, AgentServiceOptions } from '../AgentService.js';
import type { AgentMessage, MessageMetadata, NodeId } from '../types.js';
import type { NodeDescriptorV4 } from '../NodeDescriptor.js';
import type { NodeInstanceContext } from '../node-instance.js';
import { resolveInstanceDescriptorPaths } from '../node-instance.js';
import { ensureOpencodeHome, opencodeXdgEnv, resolveOpencodeHomeCtx, resolveOpencodeInvocation, writeOpencodeConfigCtx } from '../opencode-home.js';
import { transformOpenCodeEvent } from './opencode-event-transform.js';

export class OpenCodeAgentService implements AgentService {
  readonly nodeId: NodeId;
  readonly provider = 'opencode';
  private readonly ctx: NodeInstanceContext;
  private readonly descriptor: NodeDescriptorV4;
  private readonly compiledL0: string | undefined;

  constructor(ctx: NodeInstanceContext, compiledL0: string | undefined) {
    this.ctx = ctx;
    this.descriptor = resolveInstanceDescriptorPaths(ctx);
    this.compiledL0 = compiledL0;
    this.nodeId = ctx.nodeKey;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const model = this.descriptor.model;
    const metadata: MessageMetadata = { provider: 'opencode', ...(model ? { model } : {}) };
    const sessionId = options?.sessionId;
    const cwd = options?.workingDirectory ?? this.descriptor.cli.cwd;

    // per-node 项目内 opencode home（画布实例隔离；XDG 重定向，DB/sessions/skills 全落实例）
    const opencodeHome = resolveOpencodeHomeCtx(this.ctx);
    ensureOpencodeHome(opencodeHome);
    writeOpencodeConfigCtx(this.ctx, opencodeHome);

    const args: string[] = [
      'run',
      '--format',
      'json',
      ...(model ? ['-m', model] : []),
      ...(sessionId ? ['-s', sessionId] : []),
      ...this.descriptor.cli.extraArgs,
    ];

    const invocation = resolveOpencodeInvocation(this.descriptor.cli.command);
    const spawnOpts: CliSpawnOptions = {
      command: invocation.command,
      shell: invocation.shell,
      args,
      cwd,
      stdinInput: prompt,
      env: opencodeXdgEnv(opencodeHome),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
    };

    let terminalYielded = false;
    try {
      for await (const event of spawnCli(spawnOpts)) {
        if (isCliTimeout(event)) {
          yield { type: 'error', nodeId: this.nodeId, error: `opencode CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s)`, metadata, timestamp: Date.now() };
          yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
          return;
        }
        if (isCliError(event)) {
          yield { type: 'error', nodeId: this.nodeId, error: `opencode CLI 异常退出 (code: ${event.exitCode ?? 'null'})`, metadata, timestamp: Date.now() };
          yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
          return;
        }
        for (const msg of transformOpenCodeEvent(event, this.nodeId)) {
          if (msg.type === 'done' || msg.type === 'error') terminalYielded = true;
          yield msg;
        }
      }
      if (!terminalYielded) {
        yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
      }
    } catch (err) {
      yield { type: 'error', nodeId: this.nodeId, error: `opencode 调用失败: ${(err as Error).message}`, metadata, timestamp: Date.now() };
      yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
    }
  }
}
