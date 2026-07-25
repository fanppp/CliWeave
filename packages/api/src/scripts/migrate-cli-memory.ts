import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrateAllNodeStorageLayouts, readNodeDescriptor } from '../agents/NodeDescriptor.js';
import { ensureCodexHome, resolveCodexHome } from '../agents/codex-home.js';
import { ensureClaudeHome, resolveClaudeHome } from '../agents/claude-home.js';
import { ensureOpencodeHome, opencodeXdgEnv, resolveOpencodeHome, resolveOpencodeInvocation } from '../agents/opencode-home.js';
import { getProjectRoot } from '../utils/project-root.js';

const apply = process.argv.includes('--apply');
const root = getProjectRoot();
let planned = 0;
let copied = 0;

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function walkFiles(dir: string, suffix?: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      try {
        if (statSync(full).isDirectory()) stack.push(full);
        else if (!suffix || entry.endsWith(suffix)) out.push(full);
      } catch {
        // A concurrently updated CLI file can disappear; skip it.
      }
    }
  }
  return out;
}

function transcriptMetadata(file: string): { cwd?: string; originator?: string } {
  let lines: string[];
  try {
    lines = readFileSync(file, 'utf-8').split('\n').slice(0, 100);
  } catch {
    return {};
  }
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const payload = obj.payload as Record<string, unknown> | undefined;
      const cwd = [obj.cwd, obj.directory, payload?.cwd, payload?.directory].find((value) => typeof value === 'string');
      const originator = [obj.originator, payload?.originator].find((value) => typeof value === 'string');
      if (cwd || originator) return {
        ...(typeof cwd === 'string' ? { cwd } : {}),
        ...(typeof originator === 'string' ? { originator } : {}),
      };
    } catch {
      // Ignore non-JSON or partial lines.
    }
  }
  return {};
}

function copyMissing(source: string, target: string): void {
  if (existsSync(target)) return;
  planned++;
  console.log(`${apply ? 'COPY' : 'WOULD COPY'} ${relative(root, source)} -> ${relative(root, target)}`);
  if (!apply) return;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
  copied++;
}

function migrateCodex(): void {
  const descriptor = readNodeDescriptor('codex-node');
  const targetHome = resolveCodexHome(descriptor);
  const sourceSessions = join(homedir(), '.codex', 'sessions');
  if (apply) ensureCodexHome(targetHome);
  for (const file of walkFiles(sourceSessions, '.jsonl')) {
    const meta = transcriptMetadata(file);
    if (!meta.cwd || !samePath(meta.cwd, root) || meta.originator !== 'codex_exec') continue;
    copyMissing(file, join(targetHome, 'sessions', relative(sourceSessions, file)));
  }
}

function migrateClaude(): void {
  const descriptor = readNodeDescriptor('claude-node');
  const targetProjects = join(resolveClaudeHome(descriptor), 'projects');
  const sourceProjects = join(homedir(), '.claude', 'projects');
  if (apply) ensureClaudeHome(resolveClaudeHome(descriptor));
  if (!existsSync(sourceProjects)) return;
  for (const projectDirName of readdirSync(sourceProjects)) {
    const projectDir = join(sourceProjects, projectDirName);
    if (!statSync(projectDir).isDirectory()) continue;
    const belongsHere = walkFiles(projectDir, '.jsonl').some((file) => {
      const { cwd } = transcriptMetadata(file);
      return cwd !== undefined && samePath(cwd, root);
    });
    if (belongsHere) copyMissing(projectDir, join(targetProjects, projectDirName));
  }
}

interface OpenCodeSession {
  id?: string;
  directory?: string;
}

function globalOpenCodeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) delete env[name];
  return env;
}

function runOpenCode(args: string[], env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  const invocation = resolveOpencodeInvocation('opencode');
  return spawnSync(invocation.command, args, {
    encoding: 'utf-8',
    shell: invocation.shell,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
}

function listOpenCodeSessions(env: NodeJS.ProcessEnv): OpenCodeSession[] {
  const result = runOpenCode(['session', 'list', '--format', 'json'], env);
  if (result.status !== 0) return [];
  try {
    const parsed = JSON.parse(String(result.stdout));
    return Array.isArray(parsed) ? parsed as OpenCodeSession[] : [];
  } catch {
    return [];
  }
}

function migrateOpenCodeSource(label: string, sourceEnv: NodeJS.ProcessEnv, targetHome: string): void {
  const targetEnv = { ...process.env, ...opencodeXdgEnv(targetHome) };
  const existing = new Set(listOpenCodeSessions(targetEnv).map((session) => session.id).filter(Boolean));
  for (const session of listOpenCodeSessions(sourceEnv)) {
    if (!session.id || !session.directory || !samePath(session.directory, root) || existing.has(session.id)) continue;
    planned++;
    console.log(`${apply ? 'IMPORT' : 'WOULD IMPORT'} opencode ${session.id} from ${label}`);
    if (!apply) continue;
    const exported = runOpenCode(['export', session.id], sourceEnv);
    if (exported.status !== 0 || !String(exported.stdout).trim()) {
      console.warn(`SKIP opencode ${session.id}: export failed`);
      continue;
    }
    const tempDir = join(targetHome, 'migration-tmp');
    const tempFile = join(tempDir, `${session.id}.json`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(tempFile, String(exported.stdout), 'utf-8');
    const imported = runOpenCode(['import', tempFile], targetEnv);
    rmSync(tempFile, { force: true });
    if (imported.status === 0) {
      copied++;
      existing.add(session.id);
    } else {
      console.warn(`SKIP opencode ${session.id}: import failed`);
    }
  }
}

function migrateOpenCode(): void {
  const descriptor = readNodeDescriptor('opencode-node');
  const targetHome = resolveOpencodeHome(descriptor);
  if (apply) ensureOpencodeHome(targetHome);
  migrateOpenCodeSource('global XDG data', globalOpenCodeEnv(), targetHome);

  const legacyRoots = [
    join(root, 'agents', descriptor.id, 'memory'),
    join(root, 'agents', descriptor.id, 'data', 'cli', '.legacy-v1'),
  ];
  for (const legacyRoot of legacyRoots) {
    const legacyDb = join(legacyRoot, '.local', 'share', 'opencode', 'opencode.db');
    if (!existsSync(legacyDb)) continue;
    migrateOpenCodeSource(`legacy XDG data at ${relative(root, legacyRoot)}`, {
      ...process.env,
      XDG_DATA_HOME: join(legacyRoot, '.local', 'share'),
      XDG_CONFIG_HOME: join(legacyRoot, '.config'),
      XDG_CACHE_HOME: join(legacyRoot, '.cache'),
      XDG_STATE_HOME: join(legacyRoot, '.local', 'state'),
    }, targetHome);
  }
}

console.log(`CLI memory migration (${apply ? 'apply' : 'dry-run'}) for ${root}`);
if (apply) migrateAllNodeStorageLayouts();
migrateCodex();
migrateClaude();
migrateOpenCode();
console.log(`Summary: ${planned} item(s) ${apply ? `planned, ${copied} copied/imported` : 'would be copied/imported'}. Source data is never deleted.`);
