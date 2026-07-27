'use client';

import { useState, type KeyboardEvent } from 'react';
import { useGraphRun } from '../hooks/useGraphRun';
import { useGraphRunStore } from '../stores/graphRunStore';

export function GraphRunPanel() {
  const { startRun, abortRun } = useGraphRun();
  const status = useGraphRunStore((s) => s.status);
  const graph = useGraphRunStore((s) => s.graph);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const busy = status === 'running';

  const submit = async (): Promise<void> => {
    if (!text.trim() || busy) return;
    setErr(null);
    try {
      await startRun(text);
    } catch (e) {
      setErr((e as Error).message);
    }
    setText('');
  };

  const stop = async (): Promise<void> => {
    try {
      await abortRun();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const nodeCount = graph?.nodes.filter((n) => n.type === 'agent').length ?? 0;

  return (
    <div style={styles.bar}>
      <div style={{ ...styles.state, color: busy ? 'var(--text-muted)' : 'var(--success)' }}>
        <span style={{ ...styles.stateDot, background: busy ? 'var(--accent)' : 'var(--success)' }} />
        {busy ? '图运行中…（可点击停止）' : `图已就绪（${nodeCount} 个 agent 节点，按拓扑序串行执行）`}
      </div>
      {err && <div style={styles.err}>{err}</div>}
      <div style={styles.controls}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={busy ? '运行完成后可再次启动' : '输入需求，按拓扑顺序触发多 CLI 协作…'}
          rows={4}
          style={{ ...styles.input, ...(busy ? styles.inputDisabled : {}) }}
          disabled={busy}
        />
        {busy ? (
          <button onClick={() => void stop()} style={{ ...styles.btn, ...styles.stopBtn }}>
            停止
          </button>
        ) : (
          <button
            onClick={() => void submit()}
            disabled={!text.trim()}
            style={{ ...styles.btn, ...(!text.trim() ? styles.btnDisabled : {}) }}
          >
            运行图
          </button>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: { padding: 12, borderTop: '1px solid var(--border)' },
  state: { display: 'flex', alignItems: 'center', gap: 6, minHeight: 20, marginBottom: 6, fontSize: 12 },
  stateDot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  err: { color: 'var(--danger)', fontSize: 12, marginBottom: 6 },
  controls: { display: 'flex', gap: 8 },
  input: {
    flex: 1,
    resize: 'none',
    background: 'var(--surface-raised)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '10px 12px',
    fontSize: 16,
    outline: 'none',
  },
  inputDisabled: { cursor: 'not-allowed', opacity: 0.65 },
  btn: {
    background: 'var(--accent)',
    color: 'var(--accent-text)',
    border: 'none',
    borderRadius: 6,
    padding: '0 20px',
    fontSize: 14,
    fontWeight: 600,
  },
  btnDisabled: { cursor: 'not-allowed', opacity: 0.55 },
  stopBtn: { background: 'var(--danger)' },
};
