/**
 * CodexAgentService —— 用 OpenAI Codex CLI 驱动一个节点
 *
 * 实测命令（codex 0.145.0）：
 *   新会话: codex exec --json --sandbox <mode> --skip-git-repo-check \
 *             -m <model> -c approval_policy="never" \
 *             -c developer_instructions="<L0>" -- -
 *   resume:  codex exec resume <id> --json --skip-git-repo-check \
 *             -c sandbox_mode="<mode>" -c approval_policy="never" \
 *             -m <model> -c developer_instructions="<L0>" -- -
 *   prompt 经 stdin 传入（防 ps 泄露对话）。
 *
 * 借鉴 clowder-ai CodexAgentService（精简：去 L0-compiler 子进程/MCP/audit/image/liveness）。
 */
import { spawnCli, isCliError, isCliTimeout } from '../../utils/cli-spawn.js';
import type { CliSpawnOptions } from '../../utils/cli-types.js';
import type { AgentService, AgentServiceOptions } from '../AgentService.js';
import type { AgentMessage, MessageMetadata, NodeId } from '../types.js';
import type { NodeDescriptorV4 } from '../NodeDescriptor.js';
import type { NodeInstanceContext } from '../node-instance.js';
import { resolveInstanceDescriptorPaths } from '../node-instance.js';
import { codexEnv, ensureCodexHome, resolveCodexHomeCtx } from '../codex-home.js';
import { transformCodexEvent } from './codex-event-transform.js';

/** TOML 字符串转义：-c 的 value 部分按 TOML 解析，需引号+转义 */
function toTomlString(value: string): string {
  const escaped = value.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

const KILL_GRACE_NOTICE = 'CLI 异常退出';

type RunStatus = 'ok' | 'error' | 'resume-failed';

export class CodexAgentService implements AgentService {
  readonly nodeId: NodeId;
  readonly provider = 'codex';
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
    const sessionId = options?.sessionId;
    if (sessionId) {
      // 先尝试 resume；若陈旧 session 导致快速失败（无实质输出）则回退全新会话
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
   * suppressResumeError=true 时，若 resume 快速失败（exit 1 无实质输出），不 yield 错误，返回 'resume-failed' 供上层回退。
   */
  private async *runOnce(
    prompt: string,
    options: AgentServiceOptions | undefined,
    sessionId: string | undefined,
    suppressResumeError: boolean,
  ): AsyncGenerator<AgentMessage, RunStatus> {
    const model = this.descriptor.model;
    const metadata: MessageMetadata = { provider: 'openai', ...(model ? { model } : {}) };
    const cwd = options?.workingDirectory ?? this.descriptor.cli.cwd;
    const sandboxMode = this.descriptor.cli.sandboxMode;

    // per-node 项目内 CODEX_HOME（画布实例隔离）：session/记忆全存实例目录
    const codexHome = resolveCodexHomeCtx(this.ctx);
    ensureCodexHome(codexHome);

    // 公共 config 参数（-c key=value）
    const configArgs: string[] = ['-c', `approval_policy=${toTomlString('never')}`];
    if (this.compiledL0) {
      configArgs.push('-c', `developer_instructions=${toTomlString(this.compiledL0)}`);
    }

    let args: string[];
    if (sessionId) {
      // resume：用 -c sandbox_mode（resume 子命令不接受 --sandbox flag）
      args = [
        'exec',
        'resume',
        sessionId,
        '--json',
        '--skip-git-repo-check',
        '-c',
        `sandbox_mode=${toTomlString(sandboxMode)}`,
        ...configArgs,
        ...(model ? ['-m', model] : []),
        ...this.descriptor.cli.extraArgs,
        '--',
        '-',
      ];
    } else {
      args = [
        'exec',
        '--json',
        '--sandbox',
        sandboxMode,
        '--skip-git-repo-check',
        ...configArgs,
        ...(model ? ['-m', model] : []),
        ...this.descriptor.cli.extraArgs,
        '--',
        '-',
      ];
    }

    const spawnOpts: CliSpawnOptions = {
      command: this.descriptor.cli.command,
      args,
      cwd,
      stdinInput: prompt,
      env: codexEnv(codexHome),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
    };

    let sawSubstantiveOutput = false;
    let terminalYielded = false;

    try {
      for await (const event of spawnCli(spawnOpts)) {
        if (isCliTimeout(event)) {
          terminalYielded = true;
          yield {
            type: 'error',
            nodeId: this.nodeId,
            error: `Codex CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s)`,
            metadata,
            timestamp: Date.now(),
          };
          yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
          return 'error';
        }
        if (isCliError(event)) {
          // codex 0.98+ 成功后也 exit 1；有实质输出则抑制
          if (event.exitCode === 1 && event.signal === null && sawSubstantiveOutput) {
            continue;
          }
          // resume 快速失败（无实质输出）：陈旧 session，回退全新会话
          if (suppressResumeError && sessionId && !sawSubstantiveOutput) {
            return 'resume-failed';
          }
          terminalYielded = true;
          yield {
            type: 'error',
            nodeId: this.nodeId,
            error: `${KILL_GRACE_NOTICE} (code: ${event.exitCode ?? 'null'})`,
            metadata,
            timestamp: Date.now(),
          };
          yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
          return 'error';
        }

        // 跟踪实质输出（item.completed 产生 text/tool 结果）
        if (typeof event === 'object' && event !== null) {
          const e = event as Record<string, unknown>;
          if (e.type === 'item.completed') sawSubstantiveOutput = true;
        }

        const messages = transformCodexEvent(event, this.nodeId);
        for (const msg of messages) {
          if (msg.type === 'done' || msg.type === 'error') terminalYielded = true;
          yield msg;
        }
      }
      // 流正常结束但没收到 turn.completed → 兜底补一个 done
      if (!terminalYielded) {
        yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
      }
      return 'ok';
    } catch (err) {
      yield {
        type: 'error',
        nodeId: this.nodeId,
        error: `Codex 调用失败: ${(err as Error).message}`,
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
      return 'error';
    }
  }
}
