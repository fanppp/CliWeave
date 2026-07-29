/**
 * issue-store —— Project Knowledge 问题账本（append-only 事件源 + 可重建索引）。
 *
 * agents/projects/<projectId>/knowledge/
 *   issues.events.jsonl  —— FindingEvent 事实源（append-only）
 *   issues.index.json     —— Issue 可重建缓存（issueId → 当前状态）
 *   PROJECT_ISSUES.md     —— 仅 Publish 写入（见 publish.ts）
 *   notes.md              —— 自由笔记
 *
 * 状态机：observed → confirmed/open → resolved | accepted | superseded
 *  - 单次 reviewer revise 只产生 observed（未确证）。
 *  - Verifier/测试证据或人工确认后才进 confirmed/open。
 *  - 同 fingerprint 的 observed/confirmed/open 追加 evidence/occurrence（不新建）。
 *  - run 完成/abort 不自动关闭问题。
 *  - 经同一 criterion 通过后可自动 resolved。
 *  fingerprint 由服务端稳定字段计算，禁止 LLM 自造去重 ID。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { projectDir } from '../project-storage.js';

export type IssueStatus = 'observed' | 'confirmed' | 'open' | 'resolved' | 'accepted' | 'superseded';
export type FindingEventType = 'observed' | 'confirmed' | 'evidence' | 'resolved' | 'accepted' | 'superseded' | 'reopened';
export type Severity = 'info' | 'warning' | 'blocking';

export interface FindingSource {
  runId?: string;
  nodeId?: string;
  gateId?: string;
  criterionId?: string;
}

export interface FindingEvent {
  issueId: string;
  type: FindingEventType;
  source: FindingSource;
  fingerprint: string;
  severity?: Severity;
  title: string;
  detail: string;
  evidence?: string;
  at: number;
}

export interface Issue {
  issueId: string;
  fingerprint: string;
  status: IssueStatus;
  title: string;
  detail: string;
  severity?: Severity;
  source: FindingSource;
  firstSeen: number;
  lastSeen: number;
  occurrences: number;
  evidence: string[];
}

export class IssueError extends Error {
  constructor(message: string) { super(message); this.name = 'IssueError'; }
}

const OPEN_STATUSES: ReadonlySet<IssueStatus> = new Set<IssueStatus>(['observed', 'confirmed', 'open']);

function knowledgeDir(projectId: string): string { return join(projectDir(projectId), 'knowledge'); }
function eventsFile(projectId: string): string { return join(knowledgeDir(projectId), 'issues.events.jsonl'); }
function indexFile(projectId: string): string { return join(knowledgeDir(projectId), 'issues.index.json'); }

function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, file);
}
function appendLine(file: string, line: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, line + '\n', { flag: 'a' });
}

/** 服务端计算 fingerprint：稳定字段（source + title + severity）的 sha256 前16。 */
export function computeFingerprint(source: FindingSource, title: string, severity?: Severity): string {
  const stable = JSON.stringify({ nodeId: source.nodeId ?? '', gateId: source.gateId ?? '', criterionId: source.criterionId ?? '', title, severity: severity ?? '' });
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

function readEvents(projectId: string): FindingEvent[] {
  const f = eventsFile(projectId);
  if (!existsSync(f)) return [];
  const out: FindingEvent[] = [];
  for (const line of readFileSync(f, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t) as FindingEvent); } catch { /* 末行容忍 */ }
  }
  return out;
}

/** 从事件折叠为 issue 索引（按 issueId 聚合，按 fingerprint 在 observed/confirmed/open 阶段合并）。 */
function fold(events: FindingEvent[]): Issue[] {
  const byId = new Map<string, Issue>();
  // 先按 issueId 建 issue 并应用状态转移
  for (const e of events) {
    let issue = byId.get(e.issueId);
    if (!issue) {
      issue = { issueId: e.issueId, fingerprint: e.fingerprint, status: 'observed', title: e.title, detail: e.detail, ...(e.severity ? { severity: e.severity } : {}), source: e.source, firstSeen: e.at, lastSeen: e.at, occurrences: 0, evidence: [] };
      byId.set(e.issueId, issue);
    }
    issue.lastSeen = e.at;
    switch (e.type) {
      case 'observed': issue.occurrences++; if (e.evidence) issue.evidence.push(e.evidence); break;
      case 'evidence': if (e.evidence) issue.evidence.push(e.evidence); issue.occurrences++; break;
      case 'confirmed': issue.status = 'confirmed'; if (e.evidence) issue.evidence.push(e.evidence); break;
      case 'reopened': issue.status = 'open'; break;
      case 'resolved': issue.status = 'resolved'; break;
      case 'accepted': issue.status = 'accepted'; break;
      case 'superseded': issue.status = 'superseded'; break;
    }
  }
  return [...byId.values()];
}

function writeIndex(projectId: string, issues: Issue[]): void {
  writeAtomic(indexFile(projectId), JSON.stringify({ schemaVersion: 1, issues }, null, 2) + '\n');
}

function refreshIndex(projectId: string): Issue[] {
  const issues = fold(readEvents(projectId));
  writeIndex(projectId, issues);
  return issues;
}

export function listIssues(projectId: string): Issue[] {
  const f = indexFile(projectId);
  if (existsSync(f)) {
    try {
      const raw = JSON.parse(readFileSync(f, 'utf-8')) as { issues: Issue[] };
      return raw.issues ?? [];
    } catch { /* 重建 */ }
  }
  return refreshIndex(projectId);
}

function findOpenByFingerprint(projectId: string, fingerprint: string): Issue | undefined {
  return listIssues(projectId).find((i) => i.fingerprint === fingerprint && OPEN_STATUSES.has(i.status));
}

let issueSeq = 0;
function newIssueId(): string {
  issueSeq += 1;
  return `iss_${Date.now().toString(36)}${issueSeq.toString(36).padStart(3, '0')}`;
}

export interface RecordFindingInput {
  source: FindingSource;
  title: string;
  detail: string;
  severity?: Severity;
  evidence?: string;
  /** true=确证（Verifier/测试证据或人工）；false=仅 observed（reviewer revise 等）。 */
  confirmed?: boolean;
}

/** 记录一个发现：匹配 fingerprint 的开放问题则追加，否则新建。返回 issueId。 */
export function recordFinding(projectId: string, input: RecordFindingInput): string {
  const fingerprint = computeFingerprint(input.source, input.title, input.severity);
  const now = Date.now();
  const existing = findOpenByFingerprint(projectId, fingerprint);
  if (existing) {
    appendLine(eventsFile(projectId), JSON.stringify({ issueId: existing.issueId, type: input.confirmed ? 'confirmed' : 'evidence', source: input.source, fingerprint, ...(input.severity ? { severity: input.severity } : {}), title: input.title, detail: input.detail, ...(input.evidence ? { evidence: input.evidence } : {}), at: now } satisfies FindingEvent));
    refreshIndex(projectId);
    return existing.issueId;
  }
  const issueId = newIssueId();
  appendLine(eventsFile(projectId), JSON.stringify({ issueId, type: input.confirmed ? 'confirmed' : 'observed', source: input.source, fingerprint, ...(input.severity ? { severity: input.severity } : {}), title: input.title, detail: input.detail, ...(input.evidence ? { evidence: input.evidence } : {}), at: now } satisfies FindingEvent));
  refreshIndex(projectId);
  return issueId;
}

function requireIssue(projectId: string, issueId: string): Issue {
  const issue = listIssues(projectId).find((i) => i.issueId === issueId);
  if (!issue) throw new IssueError(`issue not found: ${issueId}`);
  return issue;
}

function appendState(projectId: string, issueId: string, type: FindingEventType, detail: string): void {
  appendLine(eventsFile(projectId), JSON.stringify({ issueId, type, source: {}, fingerprint: '', title: detail, detail, at: Date.now() } satisfies FindingEvent));
  refreshIndex(projectId);
}

export function confirmIssue(projectId: string, issueId: string): Issue {
  const issue = requireIssue(projectId, issueId);
  if (!OPEN_STATUSES.has(issue.status)) throw new IssueError(`issue ${issueId} is ${issue.status}, cannot confirm`);
  appendState(projectId, issueId, 'confirmed', 'human confirmed');
  return requireIssue(projectId, issueId);
}

export function resolveIssue(projectId: string, issueId: string): Issue {
  const issue = requireIssue(projectId, issueId);
  if (!OPEN_STATUSES.has(issue.status)) throw new IssueError(`issue ${issueId} is ${issue.status}, cannot resolve`);
  appendState(projectId, issueId, 'resolved', 'resolved');
  return requireIssue(projectId, issueId);
}

export function acceptIssue(projectId: string, issueId: string): Issue {
  const issue = requireIssue(projectId, issueId);
  if (!OPEN_STATUSES.has(issue.status)) throw new IssueError(`issue ${issueId} is ${issue.status}, cannot accept`);
  appendState(projectId, issueId, 'accepted', 'risk accepted');
  return requireIssue(projectId, issueId);
}

export function reopenIssue(projectId: string, issueId: string): Issue {
  const issue = requireIssue(projectId, issueId);
  if (OPEN_STATUSES.has(issue.status)) throw new IssueError(`issue ${issueId} is already ${issue.status}`);
  appendState(projectId, issueId, 'reopened', 'reopened');
  return requireIssue(projectId, issueId);
}
