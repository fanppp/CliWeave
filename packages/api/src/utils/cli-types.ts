/**
 * CLI spawn 类型
 * 借鉴 clowder-ai cli-types.ts（精简：去掉 liveness/otel/span）。
 */
import type { Readable, Writable } from 'node:stream';

export interface CliSpawnOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  /** 超时毫秒；0 = 禁用。默认 5 分钟 */
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Override platform default shell handling. Native executables should use false. */
  shell?: boolean;
  /** prompt 经 stdin 传入（防 ps 泄露对话）。设此项则 stdio[0]='pipe' */
  stdinInput?: string;
  /** 调用追踪 id（图运行= subInvocationId）；spawnCli 据此登记/注销 PID（ChildProcessRegistry） */
  invocationId?: string;
  /** 父 run id（图运行= runId）；与 invocationId 一起登记子进程，供迁移活跃检查 */
  runId?: string;
}

export interface ChildProcessLike {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (err: Error) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio: ['ignore' | 'pipe', 'pipe', 'pipe'];
    shell?: boolean;
  },
) => ChildProcessLike;
