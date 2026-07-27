/**
 * project-storage —— 画布（项目）存储与节点实例化。
 *
 * - project.json = {schemaVersion,id,name,createdAt}（tracked）；project.local.json = {path}（gitignored，本机）。
 * - M5：path 不可改（PUT 禁改 path）；local-path 仅当缺失时允许绑定（bindLocalPath）。
 * - path 校验：绝对、拒 UNC/设备/非目录；realpathSync.native() 规范化后存。
 * - 节点实例 V4：从 catalog 信息在画布内实例化（独立 config/runtime/data/cli）；不存在"建实例不入图"的独立接口。
 * - 删除走 trash（可恢复），不递归删记忆/凭据；default 禁删。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getProjectRoot } from '../utils/project-root.js';
import { ProjectIdSchema } from './instance-key.js';
import { nodeInstanceDir, projectNodesDir, readNodeInstanceAt, type NodeInstanceContext } from './node-instance.js';
import { parseNodeKey } from './NodeDescriptor.js';

// ── schemas ─────────────────────────────────────────────────────
const ProjectMetaSchema = z.object({
  schemaVersion: z.literal(1),
  id: ProjectIdSchema,
  name: z.string().trim().min(1),
  createdAt: z.number().int().nonnegative(),
});
export type ProjectMeta = z.infer<typeof ProjectMetaSchema>;

const ProjectLocalSchema = z.object({ path: z.string().min(1) });
export type ProjectLocal = z.infer<typeof ProjectLocalSchema>;

export const DEFAULT_PROJECT_ID = 'default';

// ── dirs ────────────────────────────────────────────────────────
export function projectsDir(): string {
  return join(getProjectRoot(), 'agents', 'projects');
}
export function projectDir(id: string): string {
  return join(projectsDir(), id);
}
export function projectMetaFile(id: string): string {
  return join(projectDir(id), 'project.json');
}
export function projectLocalFile(id: string): string {
  return join(projectDir(id), 'project.local.json');
}
export function projectGraphFile(id: string): string {
  return join(projectDir(id), 'graph.json');
}
export function projectRunsDir(id: string): string {
  return join(projectDir(id), 'graph-runs');
}
export function projectTrashDir(id: string): string {
  return join(projectDir(id), '.trash');
}

// ── path 校验（point 4/5）──────────────────────────────────────
const WIN_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 校验 project.path：绝对、拒 UNC/设备/非目录；返回 realpath 规范化结果。 */
export function validateProjectPath(path: string): string {
  if (typeof path !== 'string' || path.trim().length === 0) throw new Error('project path is required');
  if (!isAbsolute(path)) throw new Error(`project path must be absolute: ${path}`);
  if (path.startsWith('\\\\') || path.startsWith('//')) throw new Error(`UNC paths not allowed: ${path}`);
  if (process.platform === 'win32') {
    const base = basename(path).split('.')[0];
    if (WIN_DEVICE.test(base)) throw new Error(`device path not allowed: ${path}`);
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    throw new Error(`project path not accessible (must exist): ${path}`);
  }
  if (!st.isDirectory()) throw new Error(`project path must be a directory: ${path}`);
  try {
    return realpathSync.native(path);
  } catch {
    return path; // realpath 失败（权限等）仍接受原绝对路径
  }
}

// ── projectId ───────────────────────────────────────────────────
/** 服务端生成 projectId：proj-<uuid 去横线>，无新依赖。 */
export function generateProjectId(): string {
  return `proj-${randomUUID().replace(/-/g, '')}`;
}

// ── 读取 ────────────────────────────────────────────────────────
export function readProjectMeta(id: string): ProjectMeta {
  const f = projectMetaFile(id);
  if (!existsSync(f)) throw new Error(`project not found: ${id}`);
  return ProjectMetaSchema.parse(JSON.parse(readFileSync(f, 'utf-8')));
}

export function readProjectLocal(id: string): ProjectLocal | undefined {
  const f = projectLocalFile(id);
  if (!existsSync(f)) return undefined;
  try {
    return ProjectLocalSchema.parse(JSON.parse(readFileSync(f, 'utf-8')));
  } catch {
    return undefined;
  }
}

export interface ProjectListItem {
  id: string;
  name: string;
  createdAt: number;
  path?: string;
  /** local 缺失或 realpath 不存在 → true，listProjects 不抛错。 */
  pathMissing?: boolean;
}

export function listProjects(): ProjectListItem[] {
  const dir = projectsDir();
  if (!existsSync(dir)) return [];
  const out: ProjectListItem[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const metaFile = projectMetaFile(entry.name);
    if (!existsSync(metaFile)) continue;
    let meta: ProjectMeta;
    try {
      meta = ProjectMetaSchema.parse(JSON.parse(readFileSync(metaFile, 'utf-8')));
    } catch (e) {
      console.error(`[projects] skip ${entry.name}:`, (e as Error).message);
      continue;
    }
    const local = readProjectLocal(entry.name);
    let path: string | undefined;
    let pathMissing: boolean | undefined;
    if (local) {
      path = local.path;
      try {
        if (!existsSync(realpathSync.native(local.path))) pathMissing = true;
      } catch {
        pathMissing = true;
      }
    } else {
      pathMissing = true;
    }
    out.push({ id: meta.id, name: meta.name, createdAt: meta.createdAt, path, pathMissing });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

// ── 写入 ────────────────────────────────────────────────────────
function writeProjectMetaAtomic(id: string, meta: ProjectMeta): void {
  const f = projectMetaFile(id);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
  renameSync(tmp, f);
}

function writeProjectLocalAtomic(id: string, local: ProjectLocal): void {
  const f = projectLocalFile(id);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(local, null, 2) + '\n', 'utf-8');
  renameSync(tmp, f);
}

export function createProject(name: string, path: string, id?: string): ProjectMeta {
  const pid = id ?? generateProjectId();
  ProjectIdSchema.parse(pid);
  if (existsSync(projectDir(pid))) throw new Error(`project already exists: ${pid}`);
  const realPath = validateProjectPath(path);
  mkdirSync(projectNodesDir(pid), { recursive: true });
  mkdirSync(projectRunsDir(pid), { recursive: true });
  const meta: ProjectMeta = { schemaVersion: 1, id: pid, name: name.trim(), createdAt: Date.now() };
  writeProjectMetaAtomic(pid, meta);
  writeProjectLocalAtomic(pid, { path: realPath });
  return meta;
}

/** 重命名（M5：path 不可改，仅 name 可改）。 */
export function renameProject(id: string, name: string): ProjectMeta {
  const meta = readProjectMeta(id);
  const updated: ProjectMeta = { ...meta, name: name.trim() };
  writeProjectMetaAtomic(id, updated);
  return updated;
}

/**
 * 绑定本机 path：仅当 project.local.json 缺失时允许（M5 不允许改绑）。
 * default 同样适用（换机器后重新绑定）。
 */
export function bindLocalPath(id: string, path: string): void {
  readProjectMeta(id); // 存在性
  if (readProjectLocal(id)) throw new Error(`local path already bound (M5: rebind not allowed); create a new project instead`);
  const realPath = validateProjectPath(path);
  writeProjectLocalAtomic(id, { path: realPath });
}

/**
 * 解析项目工作目录（cwd 唯一来源）。local 缺失或目录不存在 → 抛错。
 * 每次运行前调用以重检目录是否仍存在。
 */
export function resolveProjectPath(id: string): string {
  const local = readProjectLocal(id);
  if (!local) throw new Error(`project ${id} has no local path bound (PUT /api/projects/:id/local-path)`);
  let real: string;
  try {
    real = realpathSync.native(local.path);
  } catch {
    throw new Error(`project path not accessible: ${local.path}`);
  }
  if (!existsSync(real)) throw new Error(`project path missing: ${local.path}`);
  return real;
}

// ── 删除（trash）────────────────────────────────────────────────
export function trashProject(id: string): void {
  if (id === DEFAULT_PROJECT_ID) throw new Error('default project cannot be deleted');
  const dir = projectDir(id);
  if (!existsSync(dir)) throw new Error(`project not found: ${id}`);
  const trash = join(projectsDir(), '.trash', `${id}-${Date.now().toString(36)}`);
  mkdirSync(dirname(trash), { recursive: true });
  renameSync(dir, trash);
}

// ── 节点实例 ────────────────────────────────────────────────────
export interface InstantiateNodeOptions {
  name: string;
  command: string;
  memoryHome: string;
  model?: string;
  identity?: string;
  sandboxMode?: string;
}

/** 在画布内实例化一个 V4 节点实例（独立 config/runtime/data/cli）。 */
export function instantiateNodeInstance(projectId: string, nodeKey: string, opts: InstantiateNodeOptions): NodeInstanceContext {
  const { provider, localId } = parseNodeKey(nodeKey);
  const dir = nodeInstanceDir(projectId, provider, localId);
  if (existsSync(join(dir, 'node.json'))) {
    throw new Error(`node instance already exists: ${projectId}:${nodeKey}`);
  }
  const projectPath = resolveProjectPath(projectId);
  mkdirSync(join(dir, 'config', 'rules'), { recursive: true });
  mkdirSync(join(dir, 'runtime'), { recursive: true });

  const descriptor = {
    schemaVersion: 4 as const,
    localId,
    name: opts.name,
    provider,
    cli: {
      command: opts.command,
      sandboxMode: opts.sandboxMode ?? 'danger-full-access',
      extraArgs: [] as string[],
      promptVia: 'stdin' as const,
      cwd: '${PROJECT_PATH}',
    },
    ...(opts.model ? { model: opts.model } : {}),
    storage: {
      config: { identityFile: 'config/identity.md', rulesFiles: ['config/rules/*.md'] },
      runtime: { activeSessionFile: 'runtime/active-session.json', resume: true },
      data: { cliHome: `data/cli/${opts.memoryHome}` },
    },
  };

  const nodeFile = join(dir, 'node.json');
  const tmp = `${nodeFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(descriptor, null, 2) + '\n', 'utf-8');
  renameSync(tmp, nodeFile);

  // scaffold identity/rules（point c：创建阶段建默认，运行时缺失报错）
  const identityPath = join(dir, 'config', 'identity.md');
  if (!existsSync(identityPath)) {
    const content =
      typeof opts.identity === 'string' && opts.identity.trim()
        ? opts.identity.trim()
        : `# ${opts.name}\n\n你是画布节点 ${opts.name}（${provider} CLI）。工作目录 = 项目绑定路径。\n`;
    writeFileSync(identityPath, content, 'utf-8');
  }
  const rulesPath = join(dir, 'config', 'rules', 'general.md');
  if (!existsSync(rulesPath)) {
    writeFileSync(rulesPath, `# ${opts.name} 通用规则\n\n- 用中文回答，简洁直接。\n`, 'utf-8');
  }

  return readNodeInstanceAt({ projectId, projectDir: dir, projectPath, nodeKey });
}

/** 删除节点实例 → trash（可恢复）。 */
export function trashNodeInstance(projectId: string, nodeKey: string): void {
  const { provider, localId } = parseNodeKey(nodeKey);
  const dir = nodeInstanceDir(projectId, provider, localId);
  if (!existsSync(dir)) return;
  const trash = join(projectTrashDir(projectId), 'nodes', provider, `${localId}-${Date.now().toString(36)}`);
  mkdirSync(dirname(trash), { recursive: true });
  renameSync(dir, trash);
}

/** 高层读取：推导 projectDir + projectPath，调 readNodeInstanceAt。 */
export function readProjectNodeInstance(projectId: string, nodeKey: string): NodeInstanceContext {
  const { provider, localId } = parseNodeKey(nodeKey);
  const projectPath = resolveProjectPath(projectId);
  const dir = nodeInstanceDir(projectId, provider, localId);
  return readNodeInstanceAt({ projectId, projectDir: dir, projectPath, nodeKey });
}

export interface ProjectNodeInstanceSummary {
  nodeKey: string;
  provider: string;
  localId: string;
  name: string;
  model?: string;
}

/** 列画布内所有节点实例（扫 nodes/<provider>/<localId>/node.json）。 */
export function listProjectNodeInstances(projectId: string): ProjectNodeInstanceSummary[] {
  const root = projectNodesDir(projectId);
  if (!existsSync(root)) return [];
  const out: ProjectNodeInstanceSummary[] = [];
  for (const provider of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const providerDir = join(root, provider.name);
    for (const node of readdirSync(providerDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const file = join(providerDir, node.name, 'node.json');
      if (!existsSync(file)) continue;
      try {
        const raw = JSON.parse(readFileSync(file, 'utf-8')) as { provider?: string; localId?: string; name?: string; model?: string };
        out.push({
          nodeKey: `${provider.name}:${node.name}`,
          provider: raw.provider ?? provider.name,
          localId: raw.localId ?? node.name,
          name: raw.name ?? node.name,
          ...(raw.model ? { model: raw.model } : {}),
        });
      } catch (e) {
        console.error(`[projects] node instance unavailable: ${provider.name}:${node.name}:`, (e as Error).message);
      }
    }
  }
  return out;
}

/** 清理创建中途失败的实例目录（回滚用）。 */
export function cleanupInstanceDir(projectId: string, nodeKey: string): void {
  const { provider, localId } = parseNodeKey(nodeKey);
  const dir = nodeInstanceDir(projectId, provider, localId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
