import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { getProjectRoot } from '../utils/project-root.js';
import type { NodeDescriptor } from './NodeDescriptor.js';
import { nodeRoot, resolveDescriptorPaths } from './NodeDescriptor.js';

/** Resolve a provider home and reject paths outside this node's private CLI data directory. */
export function resolveNodeCliHome(descriptor: NodeDescriptor, defaultDir: string): string {
  const root = getProjectRoot();
  const privateRoot = nodeRoot(descriptor);
  const cliRoot = resolve(privateRoot, 'data', 'cli');
  const configured = resolveDescriptorPaths(descriptor).storage.data.cliHome;
  const home = resolve(root, configured ?? join(privateRoot, 'data', 'cli', defaultDir));
  const allowedRoot = descriptor.migrationPending
    ? resolve(root, 'agents', descriptor.localId)
    : cliRoot;
  const rel = relative(allowedRoot, home);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return home;
  throw new Error(`CLI home must stay inside ${relative(root, cliRoot)}: ${home}`);
}

/** Keep CLI-owned temporary files with the node instead of the OS user profile. */
export function nodeTempEnv(home: string): Record<string, string> {
  const temp = join(home, 'tmp');
  return { TEMP: temp, TMP: temp, TMPDIR: temp };
}

export function ensureNodeTemp(home: string): void {
  mkdirSync(join(home, 'tmp'), { recursive: true });
}
