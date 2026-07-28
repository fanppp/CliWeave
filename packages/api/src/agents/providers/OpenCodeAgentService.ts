/**
 * OpenCodeAgentService —— 用 opencode CLI 驱动一个节点
 *
 * 实测命令（opencode 1.18.4）：
 *   opencode run --format json [-m provider/model] [-s <sessionID>] "<prompt>"
 *   prompt 作为位置参数传入；resume 用 -s；记忆=会话(opencode 自管)。
 */
import { spawnCli, isCliError, isCliTimeout } from '../../utils/cli-spawn.js';
import type { CliSpawnOptions, SpawnFn } from '../../utils/cli-types.js';
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
  /** 测试缝：注入 fake spawn（生产不传）。 */
  private readonly spawnFn?: SpawnFn;

  constructor(ctx: NodeInstanceContext, compiledL0: string | undefined, spawnFn?: SpawnFn) {
    this.ctx = ctx;
    this.descriptor = resolveInstanceDescriptorPaths(ctx);
    this.compiledL0 = compiledL0;
    this.nodeId = ctx.nodeKey;
    this.spawnFn = spawnFn;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const sessionId = options?.sessionId;
    if (sessionId) {
      // 先尝试 resume；若陈旧 session 快速失败（无实质输出）则发 session_fallback 诊断并回退全新会话
      const status = yield* this.runOnce(prompt, options, sessionId, true);
      if (status === 'resume-failed') {
        yield {
          type: 'session_fallback',
          nodeId: this.nodeId,
          previousSessionId: sessionId,
          reason: 'not_found',
          timestamp: Date.now(),
        };
        const fbOptions = options && options.invocationId ? { ...options, invocationId: `${options.invocationId}:fb` } : options;
        yield* this.runOnce(prompt, fbOptions, undefined, false);
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
    const metadata: MessageMetadata = { provider: 'opencode', ...(model ? { model } : {}) };
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
      ...(options?.runId ? { runId: options.runId } : {}),
    };

    let sawOutput = false;
    let terminalYielded = false;
    try {
      for await (const event of spawnCli(spawnOpts, this.spawnFn ? { spawnFn: this.spawnFn } : undefined)) {
        if (isCliTimeout(event)) {
          terminalYielded = true;
          yield { type: 'error', nodeId: this.nodeId, error: `opencode CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s)`, metadata, timestamp: Date.now() };
          yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
          return 'error';
        }
        if (isCliError(event)) {
          // resume 快速失败（无实质输出）：陈旧 session，回退全新会话
          if (suppressResumeError && sessionId && !sawOutput) {
            return 'resume-failed';
          }
          terminalYielded = true;
          yield { type: 'error', nodeId: this.nodeId, error: `opencode CLI 异常退出 (code: ${event.exitCode ?? 'null'})`, metadata, timestamp: Date.now() };
          yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
          return 'error';
        }
        for (const msg of transformOpenCodeEvent(event, this.nodeId)) {
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
      yield { type: 'error', nodeId: this.nodeId, error: `opencode 调用失败: ${(err as Error).message}`, metadata, timestamp: Date.now() };
      yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
      return 'error';
    }
  }
}

type RunStatus = 'ok' | 'error' | 'resume-failed';
