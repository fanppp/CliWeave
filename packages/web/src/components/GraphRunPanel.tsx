'use client';

import type { CSSProperties } from 'react';
import { useGraphRunStore } from '../stores/graphRunStore';
import { GraphRunSocketBridge } from './GraphRunSocketBridge';
import { useSocketConnection } from '../providers/SocketProvider';
import { ThreadPicker } from './ThreadPicker';

/**
 * 图运行状态条（功能2：输入已移到画布输入节点）。
 * - 常驻挂载 GraphRunSocketBridge（单订阅 + 注入 socket）。
 * - 显示连接/运行状态 + 活跃节点数；运行中保留一个停止按钮兜底（确保可达）。
 */
export function GraphRunPanel() {
  const { connected } = useSocketConnection();
  const status = useGraphRunStore((s) => s.status);
  const activeNodeIds = useGraphRunStore((s) => s.activeNodeIds);
  const abortRun = useGraphRunStore((s) => s.abortRun);
  const paused = useGraphRunStore((s) => s.paused);
  const resumeRun = useGraphRunStore((s) => s.resumeRun);
  const lastPlan = useGraphRunStore((s) => s.lastPlan);
  const busy = status === 'starting' || status === 'running';

  const statusText = !connected
    ? 'WebSocket 断开'
    : busy
      ? status === 'starting' ? '正在启动' : `运行中（执行中节点：${activeNodeIds.length || 0}）`
      : status === 'paused'
        ? `已暂停（${paused?.gateId ?? '质量 Gate'}）`
      : status === 'done'
        ? '运行完成'
        : status === 'error'
          ? '运行失败'
          : '图已就绪';

  return (
    <div style={styles.bar}>
      <GraphRunSocketBridge />
      <ThreadPicker />
      <div style={{ ...styles.state, color: busy ? 'var(--text-muted)' : connected ? 'var(--success)' : 'var(--danger)' }}>
        <span style={{ ...styles.dot, background: busy ? 'var(--accent)' : connected ? 'var(--success)' : 'var(--danger)' }} />
        {statusText}
      </div>
      {lastPlan && (
        <div style={styles.planChip} title={lastPlan.reason}>
          <strong>路由: {lastPlan.lane}</strong>
          <span style={styles.planMeta}>risk {lastPlan.risk} · conf {(lastPlan.confidence * 100).toFixed(0)}%{lastPlan.rerouted ? ' · 重路由' : ''}</span>
        </div>
      )}
      {status === 'paused' && paused && (
        <div style={styles.pauseActions}>
          {paused.options.map((action) => (
            <button key={action} style={action === 'fail' ? { ...styles.btn, ...styles.stopBtn } : styles.secondaryBtn} onClick={() => void resumeRun(action)}>
              {RESUME_LABELS[action]}
            </button>
          ))}
        </div>
      )}
      {(busy || status === 'paused') && (
        <button onClick={() => void abortRun()} style={{ ...styles.btn, ...styles.stopBtn }}>
          中止
        </button>
      )}
    </div>
  );
}

const RESUME_LABELS: Record<'continue_best' | 'revise_once' | 'fail', string> = {
  continue_best: '放行最佳版本',
  revise_once: '再修订一次',
  fail: '失败结束',
};

const styles: Record<string, CSSProperties> = {
  bar: { padding: '8px 12px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  state: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, flex: 1 },
  dot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  btn: { background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 12px', fontSize: 12, cursor: 'pointer' },
  stopBtn: {},
  pauseActions: { display: 'flex', alignItems: 'center', gap: 6 },
  secondaryBtn: { background: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 8px', fontSize: 11, cursor: 'pointer' },
  planChip: { display: 'flex', flexDirection: 'column', fontSize: 11, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 8px', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' },
  planMeta: { color: 'var(--text-muted)', fontSize: 10 },
};
