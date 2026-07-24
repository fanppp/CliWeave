/**
 * provider 注册：启动时把所有已实现的 provider 注册进工厂。
 * 加新 CLI = 在这里 registerProvider 一行 + 写 provider 类。
 */
import { registerProvider } from './AgentServiceFactory.js';
import { CodexAgentService } from './providers/CodexAgentService.js';

let registered = false;

/** 启动时调用一次，注册所有 provider */
export function registerAllProviders(): void {
  if (registered) return;
  registered = true;

  registerProvider('codex', (descriptor, compiledL0) => new CodexAgentService(descriptor, compiledL0));

  // Phase 2:
  // registerProvider('claude', (d, l0) => new ClaudeAgentService(d, l0));
  // registerProvider('opencode', (d, l0) => new OpenCodeAgentService(d, l0));
  // registerProvider('gemini', (d, l0) => new GeminiAgentService(d, l0));
}
