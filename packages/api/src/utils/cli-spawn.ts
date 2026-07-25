/**
 * CLI 进程管理器
 * spawn 子进程 → 解析 NDJSON → yield 事件。处理超时/SIGKILL/stderr/abort。
 * 借鉴 clowder-ai cli-spawn.ts（精简：去 liveness/otel/span/stream-error 收集）。
 *
 * Windows: codex 是 codex.cmd，用 shell:true 让 cmd.exe 解析。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import type { CliSpawnOptions, ChildProcessLike, SpawnFn } from './cli-types.js';
import { isParseError, parseNDJSON } from './ndjson-parser.js';

const IS_WINDOWS = process.platform === 'win32';
const KILL_GRACE_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

function resolveTimeout(ms: number | undefined): number {
  if (ms === undefined) return DEFAULT_TIMEOUT_MS;
  if (Number.isFinite(ms) && ms >= 0) return ms;
  return DEFAULT_TIMEOUT_MS;
}

export interface CliErrorEvent {
  __cliError: true;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  message: string;
  command: string;
}
export interface CliTimeoutEvent {
  __cliTimeout: true;
  timeoutMs: number;
  message: string;
  command: string;
}

export function isCliError(value: unknown): value is CliErrorEvent {
  return typeof value === 'object' && value !== null && '__cliError' in value;
}
export function isCliTimeout(value: unknown): value is CliTimeoutEvent {
  return typeof value === 'object' && value !== null && '__cliTimeout' in value;
}

export async function* spawnCli(
  options: CliSpawnOptions,
  deps?: { spawnFn?: SpawnFn },
): AsyncGenerator<unknown> {
  const doSpawn: SpawnFn = deps?.spawnFn ?? defaultSpawn;
  const timeoutMs = resolveTimeout(options.timeoutMs);

  const child = doSpawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdio: [options.stdinInput != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    ...((options.shell ?? IS_WINDOWS) ? { shell: true } : { shell: false }),
  });

  // prompt 经 stdin
  if (options.stdinInput != null && child.stdin) {
    child.stdin.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        console.error('[cli-spawn] stdin write error:', err.message);
      }
    });
    child.stdin.write(options.stdinInput);
    child.stdin.end();
  }

  // 状态
  let killed = false;
  let timedOut = false;
  let childExited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let stderrBuffer = '';

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const resetTimeout = (): void => {
    if (timeoutMs === 0) return;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);
    timeoutTimer.unref();
  };
  if (timeoutMs > 0) resetTimeout();

  function killChild(): void {
    if (killed || childExited) return;
    killed = true;
    child.kill('SIGTERM');
    const esc = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    esc.unref();
    child.on('exit', () => clearTimeout(esc));
  }

  child.once('exit', (code, signal) => {
    childExited = true;
    exitCode = code;
    exitSignal = signal;
  });
  child.once('error', (err: Error) => {
    console.error('[cli-spawn] spawn error:', err.message);
    if (!childExited) {
      childExited = true;
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
  });

  const abortHandler = (): void => killChild();
  if (options.signal) {
    if (options.signal.aborted) killChild();
    else options.signal.addEventListener('abort', abortHandler, { once: true });
  }

  const exitHandler = (): void => {
    if (!childExited && child.pid !== undefined) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };
  process.on('exit', exitHandler);

  try {
    if (!child.stdout) throw new Error(`CLI ${options.command} has no stdout`);

    for await (const event of parseNDJSON(child.stdout)) {
      if (isParseError(event)) {
        console.warn('[cli-spawn] non-JSON output:', (event as { line: string }).line);
        continue;
      }
      resetTimeout();
      yield event;
    }

    // 等 stdio 关闭，拿到完整 exit code
    if (!childExited) {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(() => resolve(), 2_000).unref();
      });
    }

    if (timedOut) {
      yield {
        __cliTimeout: true,
        timeoutMs,
        message: `CLI 响应超时 (${Math.round(timeoutMs / 1000)}s)`,
        command: options.command,
      } satisfies CliTimeoutEvent;
    } else if (!killed && (exitCode !== 0 || exitSignal !== null)) {
      // 异常退出（非自杀）
      console.error(`[cli-spawn] ${options.command} exited code=${exitCode} signal=${exitSignal}`);
      if (stderrBuffer.trim()) {
        console.error(`[cli-spawn] stderr (dev only):\n${stderrBuffer.slice(-800)}`);
      }
      yield {
        __cliError: true,
        exitCode,
        signal: exitSignal,
        message: `CLI 异常退出 (code: ${exitCode ?? 'null'})`,
        command: options.command,
      } satisfies CliErrorEvent;
    }
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (options.signal) options.signal.removeEventListener('abort', abortHandler);
    process.off('exit', exitHandler);
    killChild();
  }
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio: ['ignore' | 'pipe', 'pipe', 'pipe'];
    shell?: boolean;
  },
): ChildProcessLike {
  return nodeSpawn(command, args as string[], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio,
    ...(opts.shell !== undefined ? { shell: opts.shell } : {}),
  }) as unknown as ChildProcessLike;
}
