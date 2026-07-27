/**
 * AgentServiceFactory
 * 读画布节点实例（V4 ctx）→ 编译 L0 → 按 provider 选 AgentService 实现。
 * 加新 CLI = 写一个 provider 类 + registerProvider 注册。其余不动。
 */
import type { AgentService } from './AgentService.js';
import { compileL0Ctx } from './L0Injector.js';
import { readProjectNodeInstance } from './project-storage.js';
import type { NodeInstanceContext } from './node-instance.js';
import { getActiveSessionCtx, setActiveSessionCtx, clearActiveSessionCtx } from './SessionChain.js';

export { getActiveSessionCtx, setActiveSessionCtx, clearActiveSessionCtx };
export type { NodeInstanceContext };

/** provider 工厂函数类型：拿 ctx + compiledL0 构造 service。 */
export type ProviderFactory = (ctx: NodeInstanceContext, compiledL0: string | undefined) => AgentService | Promise<AgentService>;

/** provider 注册表。 */
const providers = new Map<string, ProviderFactory>();

/** 注册一个 provider（codex/claude/opencode/gemini…） */
export function registerProvider(provider: string, factory: ProviderFactory): void {
  providers.set(provider, factory);
}

export interface BuiltAgent {
  ctx: NodeInstanceContext;
  compiledL0: string | undefined;
  service: AgentService;
}

/**
 * 构建一个画布节点实例的 AgentService。
 */
export async function buildAgent(projectId: string, nodeKey: string): Promise<BuiltAgent> {
  const ctx = readProjectNodeInstance(projectId, nodeKey);
  const compiledL0 = compileL0Ctx(ctx);

  const factory = providers.get(ctx.descriptor.provider);
  if (!factory) {
    throw new Error(
      `Provider '${ctx.descriptor.provider}' not registered. Instance: ${ctx.instanceKey}.`,
    );
  }
  const service = await factory(ctx, compiledL0);
  return { ctx, compiledL0, service };
}
