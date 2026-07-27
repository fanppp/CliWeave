/**
 * project-migration —— 从事务式把 legacy 全局节点目录迁移为画布作用域 default 项目。
 *
 * journal 状态机（agents/.migrations.local.json，gitignored 本机私有）：
 *   detected → staging → committed → verified（仅 verified 算完成）
 * 每步原子写 journal；中断后按 state 恢复（staging→续移/回滚；committed 未 verified→补验）。
 *
 * - MOVE（rename）每个 agents/<p>/<l>/ → staging/nodes/<p>/<l>/（含 data 记忆），V3 descriptor 改写为 V4 tail。
 * - graph.json + graph-runs 一并迁入；写 project.json + project.local.json(path=${PROJECT_ROOT})。
 * - 文件锁（CLI 占用）→ 保留 staging + 失败，不写 verified。
 * - git-bootstrap：clone 后 projects/default 存在但无 marker → 视为已迁移，写 verified(source:git-bootstrap)。
 *
 * 启动时 detect + git-bootstrap 自动标记；完整迁移经 CLI/HTTP 受控执行（不在启动路径自动 move）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve as pathResolve } from 'node:path';
import { getProjectRoot } from '../utils/project-root.js';
import { DEFAULT_PROJECT_ID, projectDir, projectGraphFile, projectLocalFile, projectMetaFile, projectRunsDir, projectTrashDir } from './project-storage.js';
import { nodeInstanceDir, projectNodesDir, readNodeInstanceAt } from './node-instance.js';
import { nodeKeyOf, NodeDescriptorSchema, type NodeDescriptor } from './NodeDescriptor.js';
import { parseNodeKey } from './NodeDescriptor.js';
import { PROVIDERS } from './register-providers.js';
import { hasActiveChildProcesses } from './child-process-registry.js';
import { hasActiveRuns } from './run-registry.js';

export const CURRENT_MIGRATION_VERSION = 1;

export type MigrationState = 'detected' | 'staging' | 'committed' | 'verified';
export type MigrationSource = 'migrate' | 'git-bootstrap' | 'fresh';

export interface MigrationJournal {
  version: number;
  state: MigrationState;
  source?: MigrationSource;
  ts: number;
  manifestHash?: string;
}

function journalFile(): string {
  return join(getProjectRoot(), 'agents', '.migrations.local.json');
}
function agentsRoot(): string {
  return join(getProjectRoot(), 'agents');
}
function stagingDir(): string {
  return join(agentsRoot(), 'projects', '.staging-default');
}

export function readMigrationJournal(): MigrationJournal | null {
  const f = journalFile();
  if (!existsSync(f)) return null;
  try {
    const raw = JSON.parse(readFileSync(f, 'utf-8')) as Partial<MigrationJournal>;
    if (typeof raw.version === 'number' && typeof raw.state === 'string') {
      return { version: raw.version, state: raw.state as MigrationState, source: raw.source, ts: raw.ts ?? 0, manifestHash: raw.manifestHash };
    }
  } catch {
    // 损坏 journal 忽略
  }
  return null;
}

function writeMigrationJournal(j: MigrationJournal): void {
  const f = journalFile();
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n', 'utf-8');
  renameSync(tmp, f);
}

export type BootstrapState = 'verified' | 'needs-migration' | 'git-bootstrap' | 'fresh' | 'inconsistent';

/** 检测当前迁移状态。 */
export function detectBootstrapState(): BootstrapState {
  const journal = readMigrationJournal();
  if (journal?.state === 'verified') return 'verified';
  const defaultExists = existsSync(projectDir(DEFAULT_PROJECT_ID)) && existsSync(projectMetaFile(DEFAULT_PROJECT_ID));
  const legacyGraphExists = existsSync(join(agentsRoot(), 'graph.json'));
  if (defaultExists) {
    // default 存在但未 verified → git-bootstrap（clone 后）或中断恢复
    return 'git-bootstrap';
  }
  if (legacyGraphExists) return 'needs-migration';
  return 'fresh';
}

interface LegacyNodeSource {
  nodeKey: string;
  provider: string;
  localId: string;
  sourceDir: string;
}

function listLegacyNodes(): LegacyNodeSource[] {
  const root = agentsRoot();
  if (!existsSync(root)) return [];
  const out: LegacyNodeSource[] = [];
  for (const provider of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'projects')) {
    const providerDir = join(root, provider.name);
    for (const node of readdirSync(providerDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const file = join(providerDir, node.name, 'node.json');
      if (!existsSync(file)) continue;
      out.push({ nodeKey: `${provider.name}:${node.name}`, provider: provider.name, localId: node.name, sourceDir: join(providerDir, node.name) });
    }
  }
  return out;
}

function memoryHomeFor(descriptor: NodeDescriptor): string {
  // 优先从 V3 cliHome 提取 basename；否则用 PROVIDERS 默认
  const v3CliHome = descriptor.storage.data.cliHome;
  if (v3CliHome) {
    const parts = v3CliHome.replace(/\\/g, '/').split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return PROVIDERS.find((p) => p.id === descriptor.provider)?.memoryHome ?? `.${descriptor.provider}`;
}

/** 把 V3 descriptor 改写为 V4 tail 形式（相对 nodeDir）。 */
function rewriteV3ToV4(descriptor: NodeDescriptor): Record<string, unknown> {
  const memHome = memoryHomeFor(descriptor);
  return {
    schemaVersion: 4,
    localId: descriptor.localId,
    name: descriptor.name,
    provider: descriptor.provider,
    cli: {
      command: descriptor.cli.command,
      sandboxMode: descriptor.cli.sandboxMode,
      extraArgs: descriptor.cli.extraArgs,
      promptVia: descriptor.cli.promptVia,
      cwd: '${PROJECT_PATH}',
    },
    ...(descriptor.model ? { model: descriptor.model } : {}),
    storage: {
      config: { identityFile: 'config/identity.md', rulesFiles: ['config/rules/*.md'] },
      runtime: { activeSessionFile: 'runtime/active-session.json', resume: descriptor.storage.runtime.resume },
      data: { cliHome: `data/cli/${memHome}` },
    },
    ...(descriptor.skills ? { skills: descriptor.skills } : {}),
  };
}

export interface MigrationResult {
  status: 'skipped' | 'migrated' | 'git-bootstrap' | 'fresh' | 'blocked';
  reason?: string;
  movedNodes?: number;
}

/** 主迁移入口（事务式）。需调用方先确保无活跃运行/子进程。 */
export function migrateProjectScoped(): MigrationResult {
  const journal = readMigrationJournal();
  if (journal?.state === 'verified') return { status: 'skipped', reason: 'already verified' };

  // 活跃运行/子进程 → 拒绝
  if (hasActiveChildProcesses()) return { status: 'blocked', reason: 'active CLI child processes; stop all CLI/API first' };
  if (hasActiveRuns(DEFAULT_PROJECT_ID)) return { status: 'blocked', reason: 'active runs in default project' };

  const state = detectBootstrapState();
  if (state === 'fresh') {
    writeMigrationJournal({ version: CURRENT_MIGRATION_VERSION, state: 'verified', source: 'fresh', ts: Date.now() });
    return { status: 'fresh' };
  }
  if (state === 'git-bootstrap') {
    // clone 后 default 存在但无 marker → 标记 verified（待绑 local-path）
    if (!validateDefaultProjectV4()) return { status: 'blocked', reason: 'default project exists but is not valid V4 (mixed V3/V4?)' };
    writeMigrationJournal({ version: CURRENT_MIGRATION_VERSION, state: 'verified', source: 'git-bootstrap', ts: Date.now() });
    return { status: 'git-bootstrap' };
  }
  if (state !== 'needs-migration') return { status: 'skipped', reason: `state=${state}` };

  // needs-migration：事务式迁移
  const staging = stagingDir();
  const legacyNodes = listLegacyNodes();
  const legacyGraph = join(agentsRoot(), 'graph.json');
  const legacyRuns = join(agentsRoot(), 'graph-runs');

  // 1. detected
  if (!journal || journal.state === 'detected') {
    writeMigrationJournal({ version: CURRENT_MIGRATION_VERSION, state: 'detected', source: 'migrate', ts: Date.now(), manifestHash: undefined });
  }

  // 2. staging：续移剩余节点（若 staging 已存在则跳过已迁的）
  if (!existsSync(staging)) mkdirSync(staging, { recursive: true });
  mkdirSync(join(staging, 'nodes'), { recursive: true });
  mkdirSync(join(staging, 'graph-runs'), { recursive: true });
  writeMigrationJournal({ version: CURRENT_MIGRATION_VERSION, state: 'staging', source: 'migrate', ts: Date.now() });

  let moved = 0;
  for (const src of legacyNodes) {
    const target = join(staging, 'nodes', src.provider, src.localId);
    if (existsSync(target)) continue; // 已迁（resume）
    // 读 V3 descriptor（从 source node.json）
    let v3: NodeDescriptor;
    try {
      v3 = NodeDescriptorSchema.parse(JSON.parse(readFileSync(join(src.sourceDir, 'node.json'), 'utf-8')));
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      writeMigrationJournal({ version: CURRENT_MIGRATION_VERSION, state: 'detected', source: 'migrate', ts: Date.now() });
      return { status: 'blocked', reason: `failed to parse V3 descriptor ${src.nodeKey}: ${(err as Error).message}` };
    }
    if (nodeKeyOf(v3) !== src.nodeKey) {
      return { status: 'blocked', reason: `descriptor key mismatch for ${src.nodeKey}` };
    }
    // MOVE（rename）源目录 → staging。文件锁 → 失败保留 staging。
    try {
      mkdirSync(dirname(target), { recursive: true });
      renameSync(src.sourceDir, target);
    } catch (err) {
      return { status: 'blocked', reason: `move failed (file locked?) for ${src.nodeKey}: ${(err as Error).message}` };
    }
    // 改写 node.json 为 V4
    const v4 = rewriteV3ToV4(v3);
    const nodeFile = join(target, 'node.json');
    const tmp = `${nodeFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(v4, null, 2) + '\n', 'utf-8');
    renameSync(tmp, nodeFile);
    moved++;
  }

  // 3. graph.json → staging
  if (existsSync(legacyGraph)) {
    const text = readFileSync(legacyGraph, 'utf-8').replace(/^\uFEFF/, '');
    writeFileSync(join(staging, 'graph.json'), text, 'utf-8');
  }
  // 4. graph-runs → staging
  if (existsSync(legacyRuns)) {
    for (const f of readdirSync(legacyRuns).filter((x) => x.endsWith('.jsonl'))) {
      try {
        renameSync(join(legacyRuns, f), join(staging, 'graph-runs', f));
      } catch {
        // 单文件失败继续
      }
    }
  }
  // 5. project meta + local
  writeFileSync(join(staging, 'project.json'), JSON.stringify({ schemaVersion: 1, id: DEFAULT_PROJECT_ID, name: '默认', createdAt: Date.now() }, null, 2) + '\n', 'utf-8');
  writeFileSync(join(staging, 'project.local.json'), JSON.stringify({ path: getProjectRoot() }, null, 2) + '\n', 'utf-8');

  // 6. 验证 staging（逐节点 readNodeInstanceAt + 图）
  const projectPath = getProjectRoot();
  for (const src of legacyNodes) {
    const dir = join(staging, 'nodes', src.provider, src.localId);
    try {
      readNodeInstanceAt({ projectId: DEFAULT_PROJECT_ID, projectDir: dir, projectPath, nodeKey: src.nodeKey });
    } catch (err) {
      return { status: 'blocked', reason: `staging validation failed for ${src.nodeKey}: ${(err as Error).message}` };
    }
  }

  // 7. committed（rename 前）
  writeMigrationJournal({ version: CURRENT_MIGRATION_VERSION, state: 'committed', source: 'migrate', ts: Date.now() });

  // 8. 原子 rename staging → projects/default
  const finalDir = projectDir(DEFAULT_PROJECT_ID);
  if (existsSync(finalDir)) {
    return { status: 'blocked', reason: `projects/default already exists but journal not verified (inconsistent); manual intervention needed` };
  }
  try {
    renameSync(staging, finalDir);
  } catch (err) {
    return { status: 'blocked', reason: `final rename failed: ${(err as Error).message}` };
  }

  // 9. 验证最终 + 写 verified
  if (!validateDefaultProjectV4()) {
    return { status: 'blocked', reason: 'final validation failed' };
  }
  writeMigrationJournal({ version: CURRENT_MIGRATION_VERSION, state: 'verified', source: 'migrate', ts: Date.now() });
  return { status: 'migrated', movedNodes: moved };
}

/** 校验 default 项目为合法 V4（图可读 + 至少一个实例可读 或 空图）。 */
function validateDefaultProjectV4(): boolean {
  try {
    const graphFile = projectGraphFile(DEFAULT_PROJECT_ID);
    if (!existsSync(graphFile)) return true; // 空图允许
    // 图可解析（复用 graph.ts 的 readProjectGraph 会循环 import，这里轻量校验：JSON 合法 + 含 inputNode）
    const raw = JSON.parse(readFileSync(graphFile, 'utf-8')) as { inputNode?: unknown };
    if (typeof raw.inputNode !== 'string') return false;
    // 抽样一个 agent 实例可读
    const nodesRoot = projectNodesDir(DEFAULT_PROJECT_ID);
    if (existsSync(nodesRoot)) {
      for (const provider of readdirSync(nodesRoot, { withFileTypes: true }).filter((e) => e.isDirectory())) {
        const providerDir = join(nodesRoot, provider.name);
        for (const node of readdirSync(providerDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
          const file = join(providerDir, node.name, 'node.json');
          if (!existsSync(file)) continue;
          const d = JSON.parse(readFileSync(file, 'utf-8')) as { schemaVersion?: number };
          if (d.schemaVersion !== 4) return false;
          return true; // 一个合法 V4 即可
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

// 兼容旧导出（迁移脚本/调试用）
void projectTrashDir;
void parseNodeKey;
void statSync;
