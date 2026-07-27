'use client';

import { useEffect, useState } from 'react';
import { useChatStore } from '../stores/chatStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

interface ProviderMeta {
  id: string;
  name: string;
  command: string;
  installed: boolean;
}

export function AddNodeModal({ onClose, onCreated }: { onClose: () => void; onCreated: (nodeKey: string) => void }) {
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [provider, setProvider] = useState('codex');
  const [localId, setLocalId] = useState('');
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [identity, setIdentity] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`${API_URL}/api/agents/providers`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: ProviderMeta[]) => {
        setProviders(Array.isArray(list) ? list : []);
      })
      .catch(() => setProviders([]));
  }, []);

  const submit = async (): Promise<void> => {
    const trimmedId = localId.trim();
    if (!trimmedId || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API_URL}/api/providers/${encodeURIComponent(provider)}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localId: trimmedId, name: name.trim() || trimmedId, model: model.trim(), identity: identity.trim() }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d.error ?? '创建失败');
      } else {
        onCreated(d.nodeKey);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={styles.title}>新建节点</h3>

        <label style={styles.label}>CLI provider</label>
        <select style={styles.input} value={provider} onChange={(e) => setProvider(e.target.value)}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.installed ? '' : ' (未安装)'}
            </option>
          ))}
        </select>

        <label style={styles.label}>本地 ID（同一 CLI 内唯一）</label>
        <input
          style={styles.input}
          value={localId}
          onChange={(e) => setLocalId(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))}
          placeholder='如：reviewer'
        />

        <label style={styles.label}>显示名</label>
        <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder='如：Codex 审查员' />

        <label style={styles.label}>model（可空，用 CLI 默认）</label>
        <input style={styles.input} value={model} onChange={(e) => setModel(e.target.value)} placeholder='如：gpt-5 / sonnet / provider/model' />

        <label style={styles.label}>身份 identity（可空，用默认模板）</label>
        <textarea
          style={{ ...styles.input, resize: 'vertical', minHeight: 80, fontFamily: 'inherit' }}
          value={identity}
          onChange={(e) => setIdentity(e.target.value)}
          rows={4}
          placeholder='如：你是一个资深代码审查员，只关注可读性与潜在缺陷…'
        />

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.actions}>
          <button style={styles.cancelBtn} onClick={onClose} disabled={busy}>
            取消
          </button>
          <button style={styles.createBtn} onClick={() => void submit()} disabled={busy || !localId.trim()}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'grid',
    placeItems: 'center',
    zIndex: 50,
  },
  modal: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: 24,
    width: 380,
    maxWidth: '90vw',
  },
  title: { margin: '0 0 16px', fontSize: 16, color: 'var(--text-strong)' },
  label: { display: 'block', fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 4px' },
  input: {
    width: '100%',
    background: 'var(--surface-raised)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '8px 10px',
    fontSize: 13,
  },
  error: { color: 'var(--danger)', fontSize: 12, margin: '8px 0' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 },
  cancelBtn: {
    background: 'transparent',
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 13,
  },
  createBtn: {
    background: 'var(--accent)',
    color: 'var(--accent-text)',
    border: 'none',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
  },
};
