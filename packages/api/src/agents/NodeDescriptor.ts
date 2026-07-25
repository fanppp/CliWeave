/** Node configuration stored in agents/<id>.json. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { getProjectRoot, resolvePathVars } from '../utils/project-root.js';
import { migrateLegacyNodeLayout, normalizeLockedLegacyDescriptor } from './node-storage-migration.js';

export const NodeDescriptorSchema = z.object({
  schemaVersion: z.literal(2),
  migrationPending: z.boolean().optional(),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'invalid node id'),
  name: z.string(),
  provider: z.string(),
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
    data: z.object({
      cliHome: z.string().optional(),
    }),
  }),
  skills: z.object({ mcp: z.array(z.record(z.unknown())).default([]) }).optional(),
});

export type NodeDescriptor = z.infer<typeof NodeDescriptorSchema>;

function agentsDir(): string {
  return join(getProjectRoot(), 'agents');
}

function descriptorFile(id: string): string {
  return join(agentsDir(), `${id}.json`);
}

function assertInside(label: string, root: string, path: string): void {
  const target = resolve(getProjectRoot(), resolvePathVars(path));
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
  throw new Error(`${label} must stay inside ${relative(getProjectRoot(), root)}: ${target}`);
}

export function assertNodeStorageOwnership(descriptor: NodeDescriptor): void {
  const nodeRoot = resolve(getProjectRoot(), 'agents', descriptor.id);
  if (descriptor.migrationPending) {
    assertInside('identityFile', nodeRoot, descriptor.storage.config.identityFile);
    for (const file of descriptor.storage.config.rulesFiles) assertInside('rulesFiles', nodeRoot, file);
    assertInside('activeSessionFile', nodeRoot, descriptor.storage.runtime.activeSessionFile);
    if (descriptor.storage.data.cliHome) assertInside('cliHome', nodeRoot, descriptor.storage.data.cliHome);
    return;
  }
  const configRoot = join(nodeRoot, 'config');
  const runtimeRoot = join(nodeRoot, 'runtime');
  const cliRoot = join(nodeRoot, 'data', 'cli');
  assertInside('identityFile', configRoot, descriptor.storage.config.identityFile);
  for (const file of descriptor.storage.config.rulesFiles) assertInside('rulesFiles', configRoot, file);
  assertInside('activeSessionFile', runtimeRoot, descriptor.storage.runtime.activeSessionFile);
  if (descriptor.storage.data.cliHome) assertInside('cliHome', cliRoot, descriptor.storage.data.cliHome);
}

function parseDescriptor(id: string, raw: unknown): NodeDescriptor {
  const descriptor = NodeDescriptorSchema.parse(raw);
  if (descriptor.id !== id) {
    throw new Error(`Node descriptor id mismatch: expected ${id}, got ${descriptor.id}`);
  }
  assertNodeStorageOwnership(descriptor);
  return descriptor;
}

/** Read a v2 descriptor. Startup migration runs before application routes are registered. */
export function readNodeDescriptor(id: string): NodeDescriptor {
  const filePath = descriptorFile(id);
  if (!existsSync(filePath)) throw new Error(`Node descriptor not found: ${filePath}`);
  const raw: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
  const parsed = NodeDescriptorSchema.safeParse(raw);
  if (parsed.success) return parseDescriptor(id, parsed.data);
  try {
    return parseDescriptor(id, migrateLegacyNodeLayout(id, raw));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EBUSY') throw error;
    console.warn(`[storage] node ${id} is using its legacy CLI home; migration will retry later`);
    return parseDescriptor(id, normalizeLockedLegacyDescriptor(id, raw));
  }
}

/** Atomically write a validated descriptor. */
export function writeNodeDescriptor(id: string, descriptor: NodeDescriptor): void {
  const parsed = NodeDescriptorSchema.parse(descriptor);
  if (parsed.id !== id) throw new Error(`Node descriptor id mismatch: expected ${id}, got ${parsed.id}`);
  assertNodeStorageOwnership(parsed);
  const dir = agentsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = descriptorFile(id);
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
  renameSync(tempPath, filePath);
}

/** List v2 descriptors. */
export function listNodeDescriptors(): NodeDescriptor[] {
  const dir = agentsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json') && file !== 'graph.json')
    .flatMap((file) => {
      try {
        return [readNodeDescriptor(file.slice(0, -'.json'.length))];
      } catch (error) {
        console.error(`[storage] node unavailable: ${file}:`, error);
        return [];
      }
    });
}

/** Run startup migration for every descriptor. */
export function migrateAllNodeStorageLayouts(): string[] {
  const dir = agentsDir();
  if (!existsSync(dir)) return [];
  const failures: string[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'graph.json')) {
    const id = file.slice(0, -'.json'.length);
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      parseDescriptor(id, migrateLegacyNodeLayout(id, raw));
    } catch (error) {
      failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

/** Resolve path variables without changing the descriptor's storage ownership. */
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
      data: {
        ...(descriptor.storage.data.cliHome
          ? { cliHome: resolvePathVars(descriptor.storage.data.cliHome) }
          : {}),
      },
    },
  };
}
