/**
 * AgentService 接口
 * 每个 CLI provider 实现此接口。任意 CLI 能成为节点 = 实现这个接口。
 * 借鉴 clowder-ai AgentService (invoke(): AsyncIterable<AgentMessage>)。
 */
import type { AgentMessage } from './types.js';

export interface AgentServiceOptions {
  /** 恢复的会话 id（per-node resume） */
  sessionId?: string;
  /** CLI 工作目录 */
  workingDirectory?: string;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 该节点编译后的 L0（identity + rules），由 provider 按 CLI 方式注入 */
  compiledL0?: string;
  /** 调用追踪 id（日志/超时诊断） */
  invocationId?: string;
}

export interface AgentService {
  /** 节点 id */
  readonly nodeId: string;
  /** provider 类型标识，如 'codex' / 'claude' / 'opencode' */
  readonly provider: string;
  /**
   * 调用 CLI，流式产出 AgentMessage。
   * 第一个 yield 通常是 session_init（含新 sessionId，供下次 resume）。
   */
  invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage>;
}
