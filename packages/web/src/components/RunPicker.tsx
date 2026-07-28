'use client';

import { useEffect, type CSSProperties } from 'react';
import { useGraphRuns, type RunSummary } from '../hooks/useGraphRuns';
import { useGraphRunStore } from '../stores/graphRunStore';

const statusColor: Record<RunSummary['status'], string> = {
  done: 'var(--success)',
  error: 'var(--danger)',
  aborted: 'var(--text-muted)',
  unknown: 'var(--text-faint)',
};
const statusLabel: Record<RunSummary['status'], string> = {
  done: '完成',
  error: '失败',
  aborted: '中止',
  unknown: '未知',
};

export function RunPicker() {
  const { runs, loading, loadRun, loadLatest, backToLive } = useGraphRuns();
  const replayGraph = useGraphRunStore((s) => s.replayGraph);

  // 进入图模式自动加载最近一次完成的 run；切画布（loadLatest 随 projectId 变）也重跑
  useEffect(() => {
    void loadLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadLatest]);

  return (
    <div style={styles.wrap}>
      <div style={styles.toolbar}>
        <span style={styles.title}>运行历史</span>
        <button style={styles.btn} onClick={() => void backToLive()} title="回到当前图编辑模式">
          当前图
        </button>
        <button style={styles.btn} onClick={() => void loadLatest()} title="加载最近一次运行">
          最近
        </button>
      </div>
      <div style={styles.list}>
        {loading && <div style={styles.empty}>加载中…</div>}
        {!loading && runs.length === 0 && <div style={styles.empty}>暂无运行记录</div>}
        {runs.map((r) => (
          <button key={r.runId} style={styles.item} onClick={() => void loadRun(r.runId)}>
            <div style={styles.itemTop}>
              <span style={{ ...styles.dot, background: statusColor[r.status] }} />
              <span style={styles.prompt}>{r.prompt.slice(0, 30) || '(空)'}</span>
              <span style={styles.status}>{statusLabel[r.status]}</span>
            </div>
            <div style={styles.time}>{new Date(r.createdAt).toLocaleString()}</div>
          </button>
        ))}
      </div>
      {replayGraph && (
        <div style={styles.banner}>正在重放历史 run（节点按快照配色）</div>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  toolbar: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)' },
  title: { fontSize: 12, color: 'var(--text-muted)', flex: 1 },
  btn: { background: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 8px', fontSize: 11, cursor: 'pointer' },
  list: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 4 },
  empty: { color: 'var(--text-faint)', fontSize: 12, padding: 12, textAlign: 'center' },
  item: { display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)', padding: '8px 10px', cursor: 'pointer', color: 'var(--text)' },
  itemTop: { display: 'flex', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  prompt: { flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  status: { fontSize: 10, color: 'var(--text-faint)' },
  time: { fontSize: 10, color: 'var(--text-faint)', marginTop: 2 },
  banner: { padding: '6px 12px', fontSize: 11, color: 'var(--text-muted)', background: 'var(--surface-raised)', borderTop: '1px solid var(--border)' },
};
