/** Provider-scoped node descriptors stored at agents/<provider>/<localId>/node.json. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { getProjectRoot, resolvePathVars } from '../utils/project-root.js';
import {
  migrateFlatNodeHierarchy,
  migrateLegacyNodeLayout,
  normalizeLockedFlatDescriptor,
} from './node-storage-migration.js';

const ProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'invalid provider id');
const LocalIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'invalid local node id');

export const NodeDescriptorSchema = z.object({
  schemaVersion: z.literal(3),
  migrationPending: z.boolean().optional(),
  localId: LocalIdSchema,
  name: z.string().trim().min(1),
  provider: ProviderIdSchema,
  cli: z.object({
    command: z.string(),
    sandboxMode: z.string().default('danger-full-access'),
    extraArgs: z.array(z.string()).default([]),
    promptVia: z.enum(['stdin', 'argv']).default('stdin'),
    cwd: z.string().default('${PROJECT_ROOT}'),
  }),
  model: z.string().optional(),
  storage: z.object({
    config: z.object({
      identityFile: z.string(),
      rulesFiles: z.array(z.string()).default([]),
    }),
    runtime: z.object({
      activeSessionFile: z.string(),
      resume: z.boolean().default(true),
    }),
    data: z.object({ cliHome: z.string().optional() }),
  }),
  skills: z.object({ mcp: z.array(z.record(z.unknown())).default([]) }).optional(),
});

export type NodeDescriptor = z.infer<typeof NodeDescriptorSchema>;

export interface ParsedNodeKey {
  provider: string;
  localId: string;
}

export function formatNodeKey(provider: string, localId: string): string {
  return `${ProviderIdSchema.parse(provider)}:${LocalIdSchema.parse(localId)}`;
}

export function parseNodeKey(nodeKey: string): ParsedNodeKey {
  const separator = nodeKey.indexOf(':');
  if (separator <= 0 || separator !== nodeKey.lastIndexOf(':')) throw new Error(`Invalid node key: ${nodeKey}`);
  return {
    provider: ProviderIdSchema.parse(nodeKey.slice(0, separator)),
    localId: LocalIdSchema.parse(nodeKey.slice(separator + 1)),
  };
}

export function nodeKeyOf(descriptor: { provider: string; localId: string }): string {
  return formatNodeKey(descriptor.provider, descriptor.localId);
}

function agentsDir(): string {
  return join(getProjectRoot(), 'agents');
}

export function nodeRoot(descriptor: Pick<NodeDescriptor, 'provider' | 'localId'>): string {
  return join(agentsDir(), descriptor.provider, descriptor.localId);
}

function descriptorFile(nodeKey: string): string {
  const { provider, localId } = parseNodeKey(nodeKey);
  return join(agentsDir(), provider, localId, 'node.json');
}

function assertInside(label: string, root: string, path: string): void {
  const target = resolve(getProjectRoot(), resolvePathVars(path));
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
  throw new Error(`${label} must stay inside ${relative(getProjectRoot(), root)}: ${target}`);
}

export function assertNodeStorageOwnership(descriptor: NodeDescriptor): void {
  const root = descriptor.migrationPending
    ? join(agentsDir(), descriptor.localId)
    : nodeRoot(descriptor);
  if (descriptor.migrationPending) {
    assertInside('identityFile', root, descriptor.storage.config.identityFile);
    for (const file of descriptor.storage.config.rulesFiles) assertInside('rulesFiles', root, file);
    assertInside('activeSessionFile', root, descriptor.storage.runtime.activeSessionFile);
    if (descriptor.storage.data.cliHome) assertInside('cliHome', root, descriptor.storage.data.cliHome);
    return;
  }
  assertInside('identityFile', join(root, 'config'), descriptor.storage.config.identityFile);
  for (const file of descriptor.storage.config.rulesFiles) assertInside('rulesFiles', join(root, 'config'), file);
  assertInside('activeSessionFile', join(root, 'runtime'), descriptor.storage.runtime.activeSessionFile);
  if (descriptor.storage.data.cliHome) assertInside('cliHome', join(root, 'data', 'cli'), descriptor.storage.data.cliHome);
}

function parseDescriptor(nodeKey: string, raw: unknown): NodeDescriptor {
  const descriptor = NodeDescriptorSchema.parse(raw);
  if (nodeKeyOf(descriptor) !== nodeKey) {
    throw new Error(`Node descriptor key mismatch: expected ${nodeKey}, got ${nodeKeyOf(descriptor)}`);
  }
  assertNodeStorageOwnership(descriptor);
  return descriptor;
}

/** Read a node, retrying flat-layout migration when necessary. */
export function readNodeDescriptor(nodeKey: string): NodeDescriptor {
  const key = parseNodeKey(nodeKey);
  const filePath = descriptorFile(nodeKey);
  if (existsSync(filePath)) return parseDescriptor(nodeKey, JSON.parse(readFileSync(filePath, 'utf-8')) as unknown);

  const flatFile = join(agentsDir(), `${key.localId}.json`);
  if (!existsSync(flatFile)) throw new Error(`Node descriptor not found: ${filePath}`);
  const raw: unknown = JSON.parse(readFileSync(flatFile, 'utf-8'));
  if ((raw as { provider?: unknown }).provider !== key.provider) throw new Error(`Node descriptor not found: ${nodeKey}`);
  try {
    const v2 = migrateLegacyNodeLayout(key.localId, raw);
    return parseDescriptor(nodeKey, migrateFlatNodeHierarchy(key.localId, v2));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EBUSY') throw error;
    console.warn(`[storage] node ${nodeKey} is using its flat CLI home; migration will retry later`);
    return parseDescriptor(nodeKey, normalizeLockedFlatDescriptor(key.localId, raw));
  }
}

export function writeNodeDescriptor(nodeKey: string, descriptor: NodeDescriptor): void {
  const parsed = parseDescriptor(nodeKey, descriptor);
  const filePath = descriptorFile(nodeKey);
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
  renameSync(tempPath, filePath);
}

export function listNodeDescriptors(): NodeDescriptor[] {
  const descriptors = new Map<string, NodeDescriptor>();
  const root = agentsDir();
  if (!existsSync(root)) return [];

  for (const provider of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const providerDir = join(root, provider.name);
    for (const node of readdirSync(providerDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const file = join(providerDir, node.name, 'node.json');
      if (!existsSync(file)) continue;
      const nodeKey = `${provider.name}:${node.name}`;
      try {
        descriptors.set(nodeKey, parseDescriptor(nodeKey, JSON.parse(readFileSync(file, 'utf-8')) as unknown));
      } catch (error) {
        console.error(`[storage] node unavailable: ${nodeKey}:`, error);
      }
    }
  }

  for (const file of readdirSync(root).filter((name) => name.endsWith('.json') && name !== 'graph.json')) {
    const localId = file.slice(0, -'.json'.length);
    try {
      const raw = JSON.parse(readFileSync(join(root, file), 'utf-8')) as { provider?: unknown };
      if (typeof raw.provider !== 'string') continue;
      const nodeKey = formatNodeKey(raw.provider, localId);
      if (!descriptors.has(nodeKey)) descriptors.set(nodeKey, readNodeDescriptor(nodeKey));
    } catch (error) {
      console.error(`[storage] flat node unavailable: ${file}:`, error);
    }
  }
  return [...descriptors.values()];
}

export function migrateAllNodeStorageLayouts(): string[] {
  const failures: string[] = [];
  listNodeDescriptors();
  for (const file of readdirSync(agentsDir()).filter((name) => name.endsWith('.json') && name !== 'graph.json')) {
    if (existsSync(join(agentsDir(), file))) failures.push(`${file}: migration deferred`);
  }
  return failures;
}

export function resolveDescriptorPaths(descriptor: NodeDescriptor): NodeDescriptor {
  return {
    ...descriptor,
    cli: { ...descriptor.cli, cwd: resolvePathVars(descriptor.cli.cwd) },
    storage: {
      config: {
        identityFile: resolvePathVars(descriptor.storage.config.identityFile),
        rulesFiles: descriptor.storage.config.rulesFiles.map(resolvePathVars),
      },
      runtime: {
        ...descriptor.storage.runtime,
        activeSessionFile: resolvePathVars(descriptor.storage.runtime.activeSessionFile),
      },
      data: descriptor.storage.data.cliHome
        ? { cliHome: resolvePathVars(descriptor.storage.data.cliHome) }
        : {},
    },
  };
}

// ── V4 schema：画布作用域节点实例（storage tail 相对 nodeDir；cli.cwd 占位 ${PROJECT_PATH}） ──
// V3（根相对全路径）仅用于迁移读取；新节点一律写 V4。
const V4CliSchema = z.object({
  command: z.string(),
  sandboxMode: z.string().default('danger-full-access'),
  extraArgs: z.array(z.string()).default([]),
  promptVia: z.enum(['stdin', 'argv']).default('stdin'),
  cwd: z.string().default('${PROJECT_PATH}'), // 占位，运行时由 NodeInstanceContext.projectPath 覆盖
});
const V4StorageConfigSchema = z.object({
  identityFile: z.string(), // tail，相对 nodeDir
  rulesFiles: z.array(z.string()).default([]),
});
const V4StorageRuntimeSchema = z.object({
  activeSessionFile: z.string(), // tail
  resume: z.boolean().default(true),
});
const V4StorageDataSchema = z.object({ cliHome: z.string().optional() }); // tail
const V4StorageSchema = z.object({
  config: V4StorageConfigSchema,
  runtime: V4StorageRuntimeSchema,
  data: V4StorageDataSchema,
});
export const NodeDescriptorV4Schema = z
  .object({
    schemaVersion: z.literal(4),
    localId: LocalIdSchema,
    name: z.string().trim().min(1),
    provider: ProviderIdSchema,
    cli: V4CliSchema,
    model: z.string().optional(),
    storage: V4StorageSchema,
    skills: z.object({ mcp: z.array(z.record(z.unknown())).default([]) }).optional(),
  })
  .strict();
export type NodeDescriptorV4 = z.infer<typeof NodeDescriptorV4Schema>;

