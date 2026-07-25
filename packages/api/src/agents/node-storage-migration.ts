import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { getProjectRoot } from '../utils/project-root.js';

interface LegacyDescriptor {
  schemaVersion?: number;
  id?: string;
  name?: string;
  provider?: string;
  cli?: unknown;
  model?: string;
  prompt?: { identity?: string };
  rules?: { files?: string[] };
  skills?: unknown;
  memory?: {
    session?: { resume?: boolean; dir?: string };
    cliHome?: string;
  };
  storage?: unknown;
}

const PROVIDER_HOMES: Record<string, string> = {
  codex: '.codex',
  claude: '.claude',
  opencode: '.opencode',
  gemini: '.gemini',
};

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameFile(left: string, right: string): boolean {
  if (!statSync(left).isFile() || !statSync(right).isFile()) return false;
  return readFileSync(left).equals(readFileSync(right));
}

function moveWithoutOverwrite(source: string, target: string): void {
  if (samePath(source, target) || !existsSync(source)) return;
  if (existsSync(target)) {
    if (sameFile(source, target)) {
      rmSync(source, { force: true });
      return;
    }
    throw new Error(`Node storage migration conflict: ${source} -> ${target}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  renameSync(source, target);
}

function removeEmpty(path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) return;
  const placeholder = join(path, '.gitkeep');
  if (existsSync(placeholder)) rmSync(placeholder, { force: true });
  try {
    rmdirSync(path);
  } catch {
    // Non-empty legacy directories are deliberately preserved.
  }
}

function projectPath(path: string): string {
  return resolve(getProjectRoot(), path.replace('${PROJECT_ROOT}', getProjectRoot()));
}

function writeDescriptor(id: string, descriptor: unknown): void {
  const file = join(getProjectRoot(), 'agents', `${id}.json`);
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf-8');
  renameSync(temp, file);
}

/** Convert the v1 descriptor and node folders to the v2 storage layout. */
export function migrateLegacyNodeLayout(id: string, value: unknown): unknown {
  const raw = value as LegacyDescriptor;
  if (raw.schemaVersion === 2 && raw.storage) {
    const nodeDir = join(getProjectRoot(), 'agents', id);
    removeEmpty(join(nodeDir, 'sessions'));
    const legacyMemory = join(nodeDir, 'memory');
    removeEmpty(legacyMemory);
    if (existsSync(legacyMemory)) {
      moveWithoutOverwrite(legacyMemory, join(nodeDir, 'data', 'cli', '.legacy-v1'));
    }
    return value;
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    raw.id !== id ||
    typeof raw.name !== 'string' ||
    typeof raw.provider !== 'string' ||
    !raw.cli ||
    typeof raw.cli !== 'object'
  ) return value;

  const root = getProjectRoot();
  const nodeDir = join(root, 'agents', id);
  const identityTarget = join(nodeDir, 'config', 'identity.md');
  const rulesTarget = join(nodeDir, 'config', 'rules');
  const activeTarget = join(nodeDir, 'runtime', 'active-session.json');
  const providerHome = PROVIDER_HOMES[raw.provider] ?? `.${raw.provider}`;
  const cliTarget = join(nodeDir, 'data', 'cli', providerHome);

  const identitySource = projectPath(raw.prompt?.identity ?? `agents/${id}/identity.md`);
  moveWithoutOverwrite(identitySource, identityTarget);

  const legacyRules = join(nodeDir, 'rules');
  moveWithoutOverwrite(legacyRules, rulesTarget);

  const sessionDir = projectPath(raw.memory?.session?.dir ?? `agents/${id}/sessions`);
  moveWithoutOverwrite(join(sessionDir, 'active.json'), activeTarget);
  removeEmpty(sessionDir);

  const cliSource = projectPath(raw.memory?.cliHome ?? `agents/${id}/memory/${providerHome}`);
  moveWithoutOverwrite(cliSource, cliTarget);

  // Preserve older split-XDG leftovers under the private CLI data root.
  const legacyMemory = join(nodeDir, 'memory');
  if (!existsSync(cliSource) && existsSync(legacyMemory)) {
    removeEmpty(legacyMemory);
    if (existsSync(legacyMemory)) {
      moveWithoutOverwrite(legacyMemory, join(nodeDir, 'data', 'cli', '.legacy-v1'));
    }
  }

  const descriptor = {
    schemaVersion: 2,
    id,
    name: raw.name,
    provider: raw.provider,
    cli: raw.cli,
    ...(raw.model !== undefined ? { model: raw.model } : {}),
    storage: {
      config: {
        identityFile: `agents/${id}/config/identity.md`,
        rulesFiles: [`agents/${id}/config/rules/*.md`],
      },
      runtime: {
        activeSessionFile: `agents/${id}/runtime/active-session.json`,
        resume: raw.memory?.session?.resume ?? true,
      },
      data: { cliHome: `agents/${id}/data/cli/${basename(cliTarget)}` },
    },
    ...(raw.skills !== undefined ? { skills: raw.skills } : {}),
  };

  writeDescriptor(id, descriptor);
  removeEmpty(legacyMemory);
  return descriptor;
}

/** Read-only compatibility descriptor used while Windows has the legacy CLI home locked. */
export function normalizeLockedLegacyDescriptor(id: string, value: unknown): unknown {
  const raw = value as LegacyDescriptor;
  if (
    !raw ||
    typeof raw !== 'object' ||
    raw.id !== id ||
    typeof raw.name !== 'string' ||
    typeof raw.provider !== 'string' ||
    !raw.cli ||
    typeof raw.cli !== 'object'
  ) return value;

  const nodeDir = join(getProjectRoot(), 'agents', id);
  const providerHome = PROVIDER_HOMES[raw.provider] ?? `.${raw.provider}`;
  const configIdentity = join(nodeDir, 'config', 'identity.md');
  const configRules = join(nodeDir, 'config', 'rules');
  const runtimeActive = join(nodeDir, 'runtime', 'active-session.json');

  return {
    schemaVersion: 2,
    migrationPending: true,
    id,
    name: raw.name,
    provider: raw.provider,
    cli: raw.cli,
    ...(raw.model !== undefined ? { model: raw.model } : {}),
    storage: {
      config: {
        identityFile: existsSync(configIdentity)
          ? `agents/${id}/config/identity.md`
          : raw.prompt?.identity ?? `agents/${id}/identity.md`,
        rulesFiles: existsSync(configRules)
          ? [`agents/${id}/config/rules/*.md`]
          : raw.rules?.files ?? [`agents/${id}/rules/*.md`],
      },
      runtime: {
        activeSessionFile: existsSync(runtimeActive)
          ? `agents/${id}/runtime/active-session.json`
          : `${raw.memory?.session?.dir ?? `agents/${id}/sessions`}/active.json`,
        resume: raw.memory?.session?.resume ?? true,
      },
      data: {
        cliHome: raw.memory?.cliHome ?? `agents/${id}/memory/${providerHome}`,
      },
    },
    ...(raw.skills !== undefined ? { skills: raw.skills } : {}),
  };
}

/** Reserved shared storage roots. This function never creates them. */
export function resolveSharedStorageRoot(scope: 'project' | `team:${string}`): string {
  if (scope === 'project') return join(getProjectRoot(), 'shared', 'project');
  const teamId = scope.slice('team:'.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(teamId)) throw new Error(`Invalid team scope: ${scope}`);
  return join(getProjectRoot(), 'shared', 'teams', teamId);
}
