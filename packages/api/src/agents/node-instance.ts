/**
 * NodeInstanceContext —— 画布作用域节点实例的运行时上下文。
 *
 * V4 descriptor 的 storage 字段是相对 nodeDir 的 tail；本模块负责把 (projectId, nodeKey)
 * 解析为完整 ctx（nodeDir 绝对 + projectPath 绝对 + V4 descriptor），供 Factory/底层
 * helper（cli-storage/SessionChain/L0Injector/codex-home…）使用，避免各模块重新猜 nodeDir。
 *
 * readNodeInstanceAt 是低层函数（projectDir 作为入参），正常读取与迁移 staging 验证共用。
 * 高层 readProjectNodeInstance（推导 projectDir + projectPath）见 project-storage.ts。
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { getProjectRoot } from '../utils/project-root.js';
import { nodeKeyOf, NodeDescriptorV4Schema, type NodeDescriptorV4 } from './NodeDescriptor.js';
import { formatInstanceKey, type InstanceKey } from './instance-key.js';

/** 画布节点实例根：agents/projects/<projectId>/nodes */
export function projectNodesDir(projectId: string): string {
  return join(getProjectRoot(), 'agents', 'projects', projectId, 'nodes');
}

/** 单个节点实例目录：agents/projects/<projectId>/nodes/<provider>/<localId> */
export function nodeInstanceDir(projectId: string, provider: string, localId: string): string {
  return join(projectNodesDir(projectId), provider, localId);
}

export interface NodeInstanceContext {
  projectId: string;
  nodeKey: string; // provider:localId
  instanceKey: InstanceKey; // projectId:nodeKey
  nodeDir: string; // 绝对实例目录
  projectPath: string; // 绝对，cwd 唯一来源
  descriptor: NodeDescriptorV4;
}

/** 校验 V4 storage tail 解析后落在 nodeDir 内（防 ../ 逃逸）。 */
export function assertNodeInstanceOwnership(ctx: NodeInstanceContext): void {
  const { nodeDir, descriptor } = ctx;
  const inside = (label: string, tail: string): void => {
    const target = resolve(nodeDir, tail);
    const rel = relative(nodeDir, target);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
    throw new Error(`${label} must stay inside node dir ${nodeDir}: ${target}`);
  };
  inside('identityFile', descriptor.storage.config.identityFile);
  for (const f of descriptor.storage.config.rulesFiles) inside('rulesFiles', f);
  inside('activeSessionFile', descriptor.storage.runtime.activeSessionFile);
  if (descriptor.storage.data.cliHome) inside('cliHome', descriptor.storage.data.cliHome);
}

/** 把 V4 tail 解析为绝对路径 + cli.cwd=projectPath，供 provider/底层 helper 使用。 */
export function resolveInstanceDescriptorPaths(ctx: NodeInstanceContext): NodeDescriptorV4 {
  const { nodeDir, projectPath, descriptor } = ctx;
  return {
    ...descriptor,
    cli: { ...descriptor.cli, cwd: projectPath },
    storage: {
      config: {
        identityFile: resolve(nodeDir, descriptor.storage.config.identityFile),
        rulesFiles: descriptor.storage.config.rulesFiles.map((f) => resolve(nodeDir, f)),
      },
      runtime: {
        ...descriptor.storage.runtime,
        activeSessionFile: resolve(nodeDir, descriptor.storage.runtime.activeSessionFile),
      },
      data: descriptor.storage.data.cliHome
        ? { cliHome: resolve(nodeDir, descriptor.storage.data.cliHome) }
        : {},
    },
  };
}

/**
 * 在指定实例目录读取 V4 节点实例。低层函数：projectDir 作为入参（= nodeDir），
 * 正常读取（readProjectNodeInstance）与迁移 staging 验证共用，故不在内部推导目录。
 */
export function readNodeInstanceAt(opts: {
  projectId: string;
  projectDir: string; // 绝对实例目录（= nodeDir）
  projectPath: string; // 绝对
  nodeKey: string;
}): NodeInstanceContext {
  const { projectId, projectDir, projectPath, nodeKey } = opts;
  const file = join(projectDir, 'node.json');
  if (!existsSync(file)) {
    throw new Error(`node instance not found: ${projectId}:${nodeKey} (at ${file})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`node instance descriptor is not valid JSON: ${file}: ${(err as Error).message}`);
  }
  const descriptor = NodeDescriptorV4Schema.parse(raw);
  const expected = nodeKeyOf(descriptor);
  if (expected !== nodeKey) {
    throw new Error(`instance key mismatch: expected ${nodeKey}, descriptor is ${expected} (at ${file})`);
  }
  const ctx: NodeInstanceContext = {
    projectId,
    nodeKey,
    instanceKey: formatInstanceKey(projectId, nodeKey),
    nodeDir: projectDir,
    projectPath,
    descriptor,
  };
  assertNodeInstanceOwnership(ctx);
  return ctx;
}
