'use client';

import { useState, type CSSProperties } from 'react';
import { useThreadStore } from '../stores/threadStore';
import { useGraphRunStore } from '../stores/graphRunStore';

export function ThreadPicker() {
  const threads = useThreadStore((s) => s.threads);
  const active = useThreadStore((s) => s.activeThreadId);
  const select = useThreadStore((s) => s.selectThread);
  const create = useThreadStore((s) => s.createConversation);
  const status = useGraphRunStore((s) => s.status);
  const busy = status === 'starting' || status === 'running' || status === 'paused';
  const [error, setError] = useState('');
  return (
    <div style={styles.wrap}>
      <span style={styles.label}>对话</span>
      <select style={styles.select} value={active ?? ''} disabled={busy} onChange={(e) => select(e.target.value || null)} title='后续提问默认继续当前对话'>
        {!active && <option value=''>首次发送时新建</option>}
        {threads.map((t) => <option key={t.id} value={t.id}>{t.title || '新对话'} · r{t.revision}</option>)}
      </select>
      <button type='button' style={styles.button} disabled={busy} onClick={() => { setError(''); void create().catch((e: Error) => setError(e.message)); }}>新对话</button>
      {error && <span style={styles.error} title={error}>!</span>}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrap: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  label: { fontSize: 11, color: 'var(--text-muted)' },
  select: { width: 180, minWidth: 90, background: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: 11 },
  button: { background: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 8px', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' },
  error: { color: 'var(--danger)', fontWeight: 700 },
};
