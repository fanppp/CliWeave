/**
 * AgentServiceFactory
 * 读 NodeDescriptor → 编译 L0 → 按 provider 选 AgentService 实现。
 * 加新 CLI = 写一个 provider 类 + registerProvider 注册。其余不动。
 */
import type { AgentService } from './AgentService.js';
import { compileL0 } from './L0Injector.js';
import { getActiveSession, setActiveSession, clearActiveSession } from './SessionChain.js';
import {
  type NodeDescriptor,
  readNodeDescriptor,
  resolveDescriptorPaths,
} from './NodeDescriptor.js';

export { getActiveSession, setActiveSession, clearActiveSession };

/** provider 工厂函数类型 */
export type ProviderFactory = (descriptor: NodeDescriptor, compiledL0: string | undefined) => AgentService | Promise<AgentService>;

/** provider 注册表。1.4 注册 codex，Phase 2 注册 claude/opencode/gemini。 */
const providers = new Map<string, ProviderFactory>();

/** 注册一个 provider（codex/claude/opencode/gemini…） */
export function registerProvider(provider: string, factory: ProviderFactory): void {
  providers.set(provider, factory);
}

export interface BuiltAgent {
  descriptor: NodeDescriptor;
  compiledL0: string | undefined;
  service: AgentService;
}

/**
 * 构建一个节点的 AgentService。
 */
export async function buildAgent(nodeId: string): Promise<BuiltAgent> {
  const descriptor = readNodeDescriptor(nodeId);
  const resolved = resolveDescriptorPaths(descriptor);
  const compiledL0 = compileL0(descriptor);

  const factory = providers.get(resolved.provider);
  if (!factory) {
    throw new Error(
      `Provider '${resolved.provider}' not registered. Node: ${nodeId}. (codex → task 1.4)`,
    );
  }
  const service = await factory(resolved, compiledL0);
  return { descriptor: resolved, compiledL0, service };
}
