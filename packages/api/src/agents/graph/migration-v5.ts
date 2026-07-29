/**
 * V4→V5 显式迁移服务（§1）。
 *
 * - preview：读 V4 源图 + roleMap → 候选 V5 图（getDefaultV5ProjectGraph 模板 + nodeKey 替换）+ 校验 + 哈希 + 复用/新建角色 + 短期 confirmToken。
 *   无 roleMap → requiresMapping（不得猜测后应用）。源图非 V4 → error。
 * - apply：重算源图哈希（不一致→409）；有活跃/暂停 run→409；staging 脚手架新建节点 + rubric + V5 校验；备份旧图 + 原子 forced 写 V5；journal committed。
 * - rollback：仅当当前图仍等于迁移产物（manifestHash 一致）+ 无活跃 run → 恢复 V4 备份；新建节点移入 trash；journal rolled_back。
 *
 * journal：agents/.graph-migrations.local.json（gitignored），重启可识别 staged/committed/rolled_back。
 * writeProjectGraph 拒绝任意 schema 变更；本服务用 writeProjectGraphForced 绕过。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getProjectRoot } from '../../utils/project-root.js';
import { instantiateNodeInstance, listProjectNodeInstances, trashNodeInstance } from '../project-storage.js';
import { readProjectGraph, writeProjectGraphForced, validateGraph, validateRunnable, type AnyGraph, type GraphV5 } from './graph.js';
import { getDefaultV5ProjectGraph, V5_ROLES } from './v5-workspace.js';
import { PROVIDERS } from '../register-providers.js';
import { hasActiveRuns } from '../run-registry.js';

export class MigrationError extends Error {
  constructor(message: string) { super(message); this.name = 'MigrationError'; }
}

const PREVIEW_TTL_MS = 30 * 60 * 1000; // 30min
export type MigrationRoleMap = Record<string, string>;

function hashJson(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

/** 候选 V5 图 = 7 lane 模板，按 roleMap 替换节点 nodeKey（缺省保留 canonical）。 */
export function buildMigrationV5Graph(roleMap: MigrationRoleMap): GraphV5 {
  const base = getDefaultV5ProjectGraph();
  const nodes = base.nodes.map((n) => ('agentNodeKey' in n && roleMap[n.id] ? { ...n, agentNodeKey: roleMap[n.id] } : n));
  return { ...base, nodes };
}

interface MigrationRecord {
  migrationId: string;
  projectId: string;
  status: 'staged' | 'committed' | 'rolled_back';
  sourceHash: string;
  manifestHash: string;
  roleMap: MigrationRoleMap;
  candidate: GraphV5;
  backup?: AnyGraph;
  confirmToken: string;
  expiresAt: number;
  createdAt: number;
  appliedAt?: number;
  rolledBackAt?: number;
}

function journalFile(): string {
  return join(getProjectRoot(), 'agents', '.graph-migrations.local.json');
}

function readJournal(): MigrationRecord[] {
  const f = journalFile();
  if (!existsSync(f)) return [];
  try {
    const arr = JSON.parse(readFileSync(f, 'utf-8').replace(/^\uFEFF/, ''));
    return Array.isArray(arr) ? (arr as MigrationRecord[]) : [];
  } catch {
    return [];
  }
}

function writeJournal(records: MigrationRecord[]): void {
  const f = journalFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(records, null, 2) + '\n', 'utf-8');
}

function existingNodeKeys(projectId: string): Set<string> {
  return new Set(listProjectNodeInstances(projectId).map((i) => i.nodeKey));
}

export interface MigrationPreview {
  sourceHash: string;
  candidate: GraphV5;
  reused: string[];
  created: string[];
  warnings: string[];
  manifestHash: string;
  confirmToken: string;
  expiresAt: number;
}
export type MigrationPreviewResult = MigrationPreview | { requiresMapping: true } | { error: string };

/** preview：构建候选 + 校验 + 哈希 + 写 staged journal 记录（带 confirmToken）。 */
export function previewMigration(projectId: string, roleMap?: MigrationRoleMap): MigrationPreviewResult {
  const source = readProjectGraph(projectId);
  if (source.schemaVersion !== 4) return { error: `source graph is V${source.schemaVersion}; migration requires a V4 graph` };
  if (!roleMap || Object.keys(roleMap).length === 0) return { requiresMapping: true };
  const candidate = buildMigrationV5Graph(roleMap);
  try {
    validateGraph(candidate);
    validateRunnable(candidate);
  } catch (e) {
    return { error: `candidate V5 graph invalid: ${(e as Error).message}` };
  }
  const sourceHash = hashJson(source);
  const manifestHash = hashJson({ sourceHash, roleMap, candidateHash: hashJson(candidate) });
  const existing = existingNodeKeys(projectId);
  const reused: string[] = [];
  const created: string[] = [];
  const warnings: string[] = [];
  for (const n of candidate.nodes) {
    if (!('agentNodeKey' in n)) continue;
    if (existing.has(n.agentNodeKey)) reused.push(n.agentNodeKey);
    else {
      created.push(n.agentNodeKey);
      if (!V5_ROLES.some((r) => r.nodeKey === n.agentNodeKey)) warnings.push(`new nodeKey '${n.agentNodeKey}' has no V5_ROLES metadata; apply will fail`);
    }
  }
  const confirmToken = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  const records = readJournal().filter((r) => !(r.projectId === projectId && r.status === 'staged'));
  records.push({ migrationId: randomUUID(), projectId, status: 'staged', sourceHash, manifestHash, roleMap, candidate, confirmToken, expiresAt, createdAt: Date.now() });
  writeJournal(records);
  return { sourceHash, candidate, reused, created, warnings, manifestHash, confirmToken, expiresAt };
}

export interface MigrationApplyResult {
  migrationId: string;
  newHash: string;
  created: string[];
  reused: string[];
}

/** apply：消费 confirmToken → 重算源哈希 + 活跃 run 校验 + 脚手架 + 备份 + forced 写 + journal committed。 */
export function applyMigration(projectId: string, confirmToken: string): MigrationApplyResult {
  const records = readJournal();
  const record = records.find((r) => r.projectId === projectId && r.status === 'staged' && r.confirmToken === confirmToken);
  if (!record) throw new MigrationError('staged migration not found for this confirmToken (re-preview)');
  if (record.expiresAt < Date.now()) throw new MigrationError('migration confirmToken expired; re-preview');
  const source = readProjectGraph(projectId);
  if (source.schemaVersion !== 4) throw new MigrationError(`source graph is no longer V4 (got V${source.schemaVersion})`);
  if (hashJson(source) !== record.sourceHash) throw new MigrationError('source graph changed since preview; re-preview');
  if (hasActiveRuns(projectId)) throw new MigrationError('project has active/paused runs; abort them first');
  // staging：脚手架新建节点（复用既有不动）
  const existing = existingNodeKeys(projectId);
  const created: string[] = [];
  for (const n of record.candidate.nodes) {
    if (!('agentNodeKey' in n)) continue;
    if (existing.has(n.agentNodeKey)) continue;
    const role = V5_ROLES.find((r) => r.nodeKey === n.agentNodeKey);
    if (!role) throw new MigrationError(`cannot scaffold '${n.agentNodeKey}': no V5_ROLES metadata`);
    const meta = PROVIDERS.find((p) => p.id === role.provider);
    if (!meta) throw new MigrationError(`provider '${role.provider}' not registered (for '${n.agentNodeKey}')`);
    const inst = instantiateNodeInstance(projectId, role.nodeKey, {
      name: role.name,
      command: meta.command,
      memoryHome: meta.memoryHome,
      ...(role.model ?? meta.defaultModel ? { model: role.model ?? meta.defaultModel } : {}),
      identity: role.identity,
    });
    if (role.decision) {
      const rubricFile = join(inst.nodeDir, 'config', 'rubric.json');
      if (!existsSync(rubricFile)) {
        mkdirSync(dirname(rubricFile), { recursive: true });
        writeFileSync(rubricFile, JSON.stringify({ schemaVersion: 1, name: `${role.name} rubric`, criteria: [{ id: 'correctness', description: '产物正确、完整并满足原始需求', required: true, weight: 1 }] }, null, 2) + '\n', 'utf-8');
      }
    }
    created.push(role.nodeKey);
  }
  validateGraph(record.candidate);
  validateRunnable(record.candidate);
  record.backup = source;
  writeProjectGraphForced(projectId, record.candidate);
  record.status = 'committed';
  record.appliedAt = Date.now();
  writeJournal(records);
  const reused = record.candidate.nodes.filter((n): n is Extract<GraphV5['nodes'][number], { agentNodeKey: string }> => 'agentNodeKey' in n).map((n) => n.agentNodeKey).filter((k) => existing.has(k));
  return { migrationId: record.migrationId, newHash: record.manifestHash, created, reused };
}

/** rollback：当前图仍==迁移产物 + 无活跃 run → 恢复 V4 备份；新建节点移 trash。 */
export function rollbackMigration(projectId: string, migrationId: string): void {
  const records = readJournal();
  const record = records.find((r) => r.migrationId === migrationId && r.projectId === projectId && r.status === 'committed');
  if (!record) throw new MigrationError('committed migration not found');
  if (!record.backup) throw new MigrationError('migration has no backup graph');
  const current = readProjectGraph(projectId);
  if (hashJson(current) !== hashJson(record.candidate)) throw new MigrationError('current graph differs from migration product; rollback refused (graph modified after migration)');
  if (hasActiveRuns(projectId)) throw new MigrationError('project has active/paused runs; abort them first');
  writeProjectGraphForced(projectId, record.backup);
  // 新建节点（candidate 中 backup 不含的 agentNodeKey）→ trash（不直接删除）。
  const backupKeys = new Set(record.backup.nodes.map((n) => (n as { agentNodeKey?: string }).agentNodeKey).filter((k): k is string => !!k));
  const candidateKeys = record.candidate.nodes.map((n) => (n as { agentNodeKey?: string }).agentNodeKey).filter((k): k is string => !!k);
  for (const k of candidateKeys) if (!backupKeys.has(k)) { try { trashNodeInstance(projectId, k); } catch { /* 节点可能已不存在；忽略 */ } }
  record.status = 'rolled_back';
  record.rolledBackAt = Date.now();
  writeJournal(records);
}
