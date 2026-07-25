'use client';

import { useEffect, useState } from 'react';
import { useChatStore } from '../stores/chatStore';

interface NodeDetail {
  nodeKey: string;
  descriptor: { localId: string; name: string; provider: string; model?: string; cli: Record<string, unknown> };
  identity?: string;
  rules: { file: string; content: string }[];
}

export function NodeConfigPanel() {
  const activeNodeId = useChatStore((s) => s.activeNodeId);
  const [detail, setDetail] = useState<NodeDetail | null>(null);

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';
    fetch(`${apiUrl}/api/agents/${encodeURIComponent(activeNodeId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setDetail(d))
      .catch(() => setDetail(null));
  }, [activeNodeId]);

  if (!detail) return <div style={styles.wrap}>加载节点配置…</div>;

  return (
    <div style={styles.wrap}>
      <h3 style={styles.h}>{detail.descriptor.name}</h3>
      <div style={styles.row}>
        <span>nodeKey</span>
        <code>{detail.nodeKey}</code>
      </div>
      <div style={styles.row}>
        <span>localId</span>
        <code>{detail.descriptor.localId}</code>
      </div>
      <div style={styles.row}>
        <span>provider</span>
        <code>{detail.descriptor.provider}</code>
      </div>
      <div style={styles.row}>
        <span>model</span>
        <code>{detail.descriptor.model || '(codex 默认)'}</code>
      </div>

      <h4 style={styles.h2}>身份 (identity)</h4>
      <pre style={styles.pre}>{detail.identity ?? '(无)'}</pre>

      <h4 style={styles.h2}>规则 (rules)</h4>
      {detail.rules.length === 0 ? (
        <div style={styles.empty}>(无规则)</div>
      ) : (
        detail.rules.map((r) => (
          <div key={r.file} style={{ marginBottom: 12 }}>
            <div style={styles.file}>{r.file}</div>
            <pre style={styles.pre}>{r.content}</pre>
          </div>
        ))
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { padding: 16, overflowY: 'auto', fontSize: 13, color: 'var(--text)' },
  h: { margin: '0 0 12px', fontSize: 16, color: 'var(--text-strong)' },
  h2: { margin: '16px 0 8px', fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase' },
  row: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 },
  pre: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: 10,
    fontSize: 12,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    margin: 0,
  },
  file: { fontSize: 11, color: 'var(--link)', marginBottom: 4, fontFamily: 'monospace' },
  empty: { color: 'var(--text-faint)', fontStyle: 'italic' },
};
