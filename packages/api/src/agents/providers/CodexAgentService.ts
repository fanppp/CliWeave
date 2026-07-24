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
import type { NodeDescriptor } from '../NodeDescriptor.js';
import { ensureCodexHome, resolveCodexHome } from '../codex-home.js';
import { transformCodexEvent } from './codex-event-transform.js';

/** TOML 字符串转义：-c 的 value 部分按 TOML 解析，需引号+转义 */
function toTomlString(value: string): string {
  const escaped = value.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

const KILL_GRACE_NOTICE = 'CLI 异常退出';

export class CodexAgentService implements AgentService {
  readonly nodeId: NodeId;
  readonly provider = 'codex';
  private readonly descriptor: NodeDescriptor;
  private readonly compiledL0: string | undefined;

  constructor(descriptor: NodeDescriptor, compiledL0: string | undefined) {
    this.descriptor = descriptor;
    this.compiledL0 = compiledL0;
    this.nodeId = descriptor.id;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const model = this.descriptor.model;
    const metadata: MessageMetadata = { provider: 'openai', ...(model ? { model } : {}) };
    const sessionId = options?.sessionId;
    const cwd = options?.workingDirectory ?? this.descriptor.cli.cwd;
    const sandboxMode = this.descriptor.cli.sandboxMode;

    // per-node 项目内 CODEX_HOME：session/记忆全存本项目，不落全局 ~/.codex
    const codexHome = resolveCodexHome(this.descriptor);
    ensureCodexHome(codexHome);

    // 公共 config 参数（-c key=value）
    const configArgs: string[] = [
      '-c',
      `approval_policy=${toTomlString('never')}`,
    ];
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
      env: { CODEX_HOME: codexHome },
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
          return;
        }
        if (isCliError(event)) {
          // codex 0.98+ 成功后也 exit 1；有实质输出则抑制
          if (event.exitCode === 1 && event.signal === null && sawSubstantiveOutput) {
            continue;
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
          return;
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
    } catch (err) {
      yield {
        type: 'error',
        nodeId: this.nodeId,
        error: `Codex 调用失败: ${(err as Error).message}`,
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', nodeId: this.nodeId, metadata, timestamp: Date.now() };
    }
  }
}
