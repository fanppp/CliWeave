/**
 * publish —— 把 Project Knowledge issues 投影为 PROJECT_ISSUES.md 并写回项目仓库。
 *
 * - IssueProjector：从 listIssues 用确定性模板生成 Markdown（无 Scribe 时用此）。
 * - 写入 <projectPath>/docs/agent-team/PROJECT_ISSUES.md，须通过：
 *     · 路径 jail（目标必须在 projectPath 之内，不得逃逸）。
 *     · secret scan（内容不得含常见密钥/凭证特征）。
 *     · 目标冲突（目标路径不是目录等）。
 *     · dirty-worktree（若 projectPath 是 git 仓库且目标文件有未提交改动 → 拒绝，避免覆盖用户编辑）。
 * - 原子写（tmp + rename）。
 */
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { listIssues, type Issue } from './issue-store.js';
import { resolveProjectPath } from '../project-storage.js';

const TARGET_REL = join('docs', 'agent-team', 'PROJECT_ISSUES.md');
function join(...segs: string[]): string { return segs.join('/'); }

export class PublishError extends Error {
  constructor(message: string) { super(message); this.name = 'PublishError'; }
}

/** 确定性模板：按状态分组 + severity + source + occurrences + evidence。 */
export function projectIssuesMarkdown(issues: Issue[]): string {
  const open = issues.filter((i) => ['observed', 'confirmed', 'open'].includes(i.status));
  const closed = issues.filter((i) => ['resolved', 'accepted', 'superseded'].includes(i.status));
  const line = (i: Issue): string => {
    const sev = i.severity ? `[${i.severity}] ` : '';
    const src = [i.source.nodeId, i.source.gateId, i.source.criterionId].filter(Boolean).join('/');
    return `- **${sev}${i.title}** (${i.status}) — ${i.detail}${src ? ` \`${src}\`` : ''}${i.occurrences > 1 ? ` ×${i.occurrences}` : ''}`;
  };
  const body = open.length || closed.length
    ? `## Open\n${open.length ? open.map(line).join('\n') : '_(none)_'}\n\n## Closed\n${closed.length ? closed.map(line).join('\n') : '_(none)_'}\n`
    : '_(no issues recorded)_\n';
  return `# Project Issues\n\n由 CliWeave Project Knowledge 自动投影。请勿手工编辑此文件（由 Publish 覆盖）。\n\n${body}`;
}

const SECRET_PATTERNS: RegExp[] = [
  /(?:AKIA|ASIA)[0-9A-Z]{16}/, // AWS
  /[ \t]["']?(sk-|pk-|rk-)[a-zA-Z0-9_-]{20,}/, // OpenAI-ish
  /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/,
  /[0-9a-fA-F]{40}\b/, // 40-hex (git token-ish) — 仅在同行出现 "token"/"secret"/"key" 时可疑，下面联合判断
];
const SECRET_HINT = /(token|secret|password|api[_-]?key|credential|private[_-]?key)/i;

/** 简易 secret 扫描：命中可疑模式 + 上下文提示词 → 拒绝。 */
function scanSecrets(content: string): string | null {
  for (const line of content.split('\n')) {
    if (SECRET_HINT.test(line)) {
      for (const p of SECRET_PATTERNS) if (p.test(line)) return `suspected secret in line: ${line.slice(0, 80)}`;
    }
  }
  return null;
}

function isGitRepo(projectPath: string): boolean {
  try { execSync(`git -C "${projectPath}" rev-parse --is-inside-work-tree`, { stdio: ['ignore', 'ignore', 'ignore'] }); return true; } catch { return false; }
}

function dirtyWorktreeConflict(projectPath: string, targetAbs: string): string | null {
  if (!isGitRepo(projectPath)) return null;
  const rel = relative(projectPath, targetAbs);
  try {
    const out = execSync(`git -C "${projectPath}" status --porcelain -- "${rel}"`, { encoding: 'utf-8' }).trim();
    return out ? `target has uncommitted changes; commit/stash first: ${out}` : null;
  } catch { return null; }
}

export interface PublishResult {
  target: string;
  issues: number;
}

/** 投影 issues → 写 <projectPath>/docs/agent-team/PROJECT_ISSUES.md。 */
export function publishIssues(projectId: string): PublishResult {
  const projectPath = resolveProjectPath(projectId);
  const targetAbs = resolve(projectPath, TARGET_REL);
  // 路径 jail
  const rel = relative(projectPath, targetAbs);
  if (isAbsolute(rel) || rel.startsWith('..')) throw new PublishError(`target escapes project path: ${targetAbs}`);
  if (existsSync(targetAbs) && statSync(targetAbs).isDirectory()) throw new PublishError(`target is a directory: ${targetAbs}`);
  const issues = listIssues(projectId);
  const content = projectIssuesMarkdown(issues);
  // secret scan
  const secret = scanSecrets(content);
  if (secret) throw new PublishError(`refused to publish: ${secret}`);
  // dirty-worktree
  const dirty = dirtyWorktreeConflict(projectPath, targetAbs);
  if (dirty) throw new PublishError(`refused to publish: ${dirty}`);
  // 原子写
  mkdirSync(dirname(targetAbs), { recursive: true });
  const tmp = `${targetAbs}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, targetAbs);
  return { target: targetAbs, issues: issues.length };
}
