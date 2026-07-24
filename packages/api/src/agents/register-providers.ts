/**
 * provider 注册：启动时把所有已实现的 provider 注册进工厂。
 * 加新 CLI = 在这里 registerProvider 一行 + 写 provider 类。
 */
import { registerProvider } from './AgentServiceFactory.js';
import { CodexAgentService } from './providers/CodexAgentService.js';
import { ClaudeAgentService } from './providers/ClaudeAgentService.js';
import { OpenCodeAgentService } from './providers/OpenCodeAgentService.js';
import { GeminiAgentService } from './providers/GeminiAgentService.js';

let registered = false;

/** 启动时调用一次，注册所有 provider */
export function registerAllProviders(): void {
  if (registered) return;
  registered = true;

  registerProvider('codex', (descriptor, compiledL0) => new CodexAgentService(descriptor, compiledL0));
  registerProvider('claude', (descriptor, compiledL0) => new ClaudeAgentService(descriptor, compiledL0));
  registerProvider('opencode', (descriptor, compiledL0) => new OpenCodeAgentService(descriptor, compiledL0));
  registerProvider('gemini', (descriptor, compiledL0) => new GeminiAgentService(descriptor, compiledL0));
}
