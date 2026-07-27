/**
 * L0 注入器
 * 读节点的 identity.md + rules/*.md，编译成一个字符串（compiledL0）。
 * provider 按各自 CLI 方式注入（codex → --config developer_instructions=，
 * claude → system prompt）。借鉴 clowder-ai l0-compiler + compileDeveloperInstructionsArgs。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getProjectRoot } from '../utils/project-root.js';
import { resolveGlob } from '../utils/glob.js';
import type { NodeDescriptor } from './NodeDescriptor.js';
import { resolveDescriptorPaths } from './NodeDescriptor.js';
import type { NodeInstanceContext } from './node-instance.js';
import { resolveInstanceDescriptorPaths } from './node-instance.js';

/**
 * 编译节点的 L0（identity + rules）。
 * 返回 undefined 表示该节点没有 identity/rules。
 */
export function compileL0(descriptor: NodeDescriptor): string | undefined {
  const root = getProjectRoot();
  const resolved = resolveDescriptorPaths(descriptor);

  const parts: string[] = [];

  // 1. identity
  if (resolved.storage.config.identityFile) {
    const identityPath = resolve(root, resolved.storage.config.identityFile);
    try {
      const identity = readFileSync(identityPath, 'utf-8').trim();
      if (identity) parts.push(identity);
    } catch {
      // identity 文件缺失不致命，跳过
    }
  }

  // 2. rules
  const rulesFiles = resolved.storage.config.rulesFiles;
  const ruleContents: string[] = [];
  for (const pattern of rulesFiles) {
    for (const file of resolveGlob(pattern, root)) {
      try {
        const content = readFileSync(file, 'utf-8').trim();
        if (content) ruleContents.push(content);
      } catch {
        // 单个 rule 文件读失败跳过
      }
    }
  }
  if (ruleContents.length > 0) {
    parts.push('# 规则\n\n' + ruleContents.join('\n\n---\n\n'));
  }

  if (parts.length === 0) return undefined;
  return parts.join('\n\n---\n\n');
}

/**
 * 画布实例版：编译实例 L0。
 * identity 缺失 → 明确报错（运行时不应自动 scaffold；创建/迁移阶段负责建默认 identity）。
 * rules 单文件读失败仍跳过。
 */
export function compileL0Ctx(ctx: NodeInstanceContext): string | undefined {
  const resolved = resolveInstanceDescriptorPaths(ctx);
  const parts: string[] = [];

  // 1. identity（运行时缺失 = 损坏/Git 删除 → 报错）
  const identityPath = resolved.storage.config.identityFile;
  if (identityPath) {
    let identity: string;
    try {
      identity = readFileSync(identityPath, 'utf-8').trim();
    } catch (err) {
      throw new Error(`identity file missing/unreadable for ${ctx.instanceKey}: ${identityPath}: ${(err as Error).message}`);
    }
    if (identity) parts.push(identity);
  }

  // 2. rules
  const ruleContents: string[] = [];
  for (const pattern of resolved.storage.config.rulesFiles) {
    for (const file of resolveGlob(pattern, ctx.nodeDir)) {
      try {
        const content = readFileSync(file, 'utf-8').trim();
        if (content) ruleContents.push(content);
      } catch {
        // 单个 rule 文件读失败跳过
      }
    }
  }
  if (ruleContents.length > 0) {
    parts.push('# 规则\n\n' + ruleContents.join('\n\n---\n\n'));
  }

  if (parts.length === 0) return undefined;
  return parts.join('\n\n---\n\n');
}
