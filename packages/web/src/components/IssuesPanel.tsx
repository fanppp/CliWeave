'use client';

import { useEffect } from 'react';
import type { CSSProperties } from 'react';
import { useIssuesStore, type Issue } from '../stores/issuesStore';
import { useGraphRunStore } from '../stores/graphRunStore';

const STATUS_LABEL: Record<Issue['status'], string> = {
  observed: '观察', confirmed: '已确证', open: '重新打开', resolved: '已解决', accepted: '接受风险', superseded: '已废弃',
};
const SEV_COLOR: Record<NonNullable<Issue['severity']>, string> = {
  info: 'var(--text-faint)', warning: 'var(--warning, #d4a13a)', blocking: 'var(--danger)',
};

/** Project Knowledge Issues 面板：列出问题 + 确认/接受风险/关闭/重开 + Publish/Summarize。 */
export function IssuesPanel() {
  const graph = useGraphRunStore((s) => s.graph);
  const projectId = useGraphRunStore((s) => s.projectId);
  const isV5 = graph?.schemaVersion === 5;
  const { issues, loading, error, lastSummarizeAt, load, act, publish, summarize } = useIssuesStore();

  useEffect(() => {
    if (projectId) void load(projectId);
  }, [projectId, load]);

  const open = issues.filter((i) => ['observed', 'confirmed', 'open'].includes(i.status));
  const closed = issues.filter((i) => ['resolved', 'accepted', 'superseded'].includes(i.status));

  return (
    <div style={styles.wrap}>
      <div style={styles.head}>
        <strong>Project Issues</strong>
        <span style={styles.counts}>open {open.length} · closed {closed.length}</span>
        <div style={styles.actions}>
          <button style={styles.btn} onClick={() => void summarize()} disabled={!isV5 && issues.length === 0} title={isV5 ? 'Scribe 总结（V5 有 Scribe 时用 LLM，否则确定性模板）' : '确定性模板'}>
            Summarize
          </button>
          <button style={styles.btn} onClick={() => void publish()}>Publish</button>
          <button style={styles.btn} onClick={() => void load(projectId!)}>刷新</button>
        </div>
      </div>
      {error && <div style={styles.error}>{error}</div>}
      {loading && <div style={styles.muted}>加载中…</div>}
      {!loading && issues.length === 0 && <div style={styles.muted}>暂无问题记录（运行时 node_error/gate 阻塞·耗尽/best-effort 遗留会自动记 observed）。</div>}
      <div style={styles.list}>
        {open.map((i) => <IssueRow key={i.issueId} issue={i} act={act} />)}
        {closed.length > 0 && <div style={styles.groupHead}>已关闭</div>}
        {closed.map((i) => <IssueRow key={i.issueId} issue={i} act={act} />)}
      </div>
      {lastSummarizeAt && <div style={styles.muted}>上次 Summarize: {new Date(lastSummarizeAt).toLocaleTimeString()}</div>}
    </div>
  );
}

function IssueRow({ issue, act }: { issue: Issue; act: (id: string, a: 'confirm' | 'resolve' | 'accept' | 'reopen') => Promise<void> }) {
  const sev = issue.severity ?? 'info';
  const src = [issue.source.nodeId, issue.source.gateId, issue.source.criterionId].filter(Boolean).join('/') || (issue.source.runId ?? '');
  const open = ['observed', 'confirmed', 'open'].includes(issue.status);
  return (
    <div style={styles.row}>
      <div style={styles.rowHead}>
        <span style={{ ...styles.sev, color: SEV_COLOR[sev] }}>{issue.severity ?? 'info'}</span>
        <strong style={styles.title}>{issue.title}</strong>
        <span style={styles.status}>{STATUS_LABEL[issue.status]}</span>
        {issue.occurrences > 1 && <span style={styles.occ}>×{issue.occurrences}</span>}
      </div>
      <div style={styles.detail}>{issue.detail}</div>
      {src && <div style={styles.src}>{src}</div>}
      {open && (
        <div style={styles.rowActions}>
          <button style={styles.mini} onClick={() => void act(issue.issueId, 'confirm')}>确证</button>
          <button style={styles.mini} onClick={() => void act(issue.issueId, 'resolve')}>解决</button>
          <button style={styles.mini} onClick={() => void act(issue.issueId, 'accept')}>接受风险</button>
        </div>
      )}
      {!open && <button style={styles.mini} onClick={() => void act(issue.issueId, 'reopen')}>重开</button>}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrap: { flex: 1, minHeight: 0, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 },
  head: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  counts: { fontSize: 12, color: 'var(--text-muted)' },
  actions: { marginLeft: 'auto', display: 'flex', gap: 4 },
  btn: { background: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 8px', fontSize: 12, cursor: 'pointer' },
  error: { color: 'var(--danger)', fontSize: 12 },
  muted: { color: 'var(--text-faint)', fontSize: 12 },
  list: { display: 'flex', flexDirection: 'column', gap: 6 },
  groupHead: { fontSize: 11, color: 'var(--text-faint)', marginTop: 6, textTransform: 'uppercase' as const },
  row: { border: '1px solid var(--border)', borderRadius: 4, padding: 8, background: 'var(--surface)' },
  rowHead: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  sev: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const },
  title: { fontSize: 13 },
  status: { fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' },
  occ: { fontSize: 11, color: 'var(--text-faint)' },
  detail: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 },
  src: { fontSize: 10, color: 'var(--text-faint)', marginTop: 2, fontFamily: 'monospace' },
  rowActions: { display: 'flex', gap: 4, marginTop: 6 },
  mini: { background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 3, padding: '2px 6px', fontSize: 11, cursor: 'pointer' },
};
