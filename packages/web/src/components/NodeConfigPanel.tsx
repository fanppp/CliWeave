'use client';

import { useEffect, useState } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useGraphRunStore } from '../stores/graphRunStore';

interface NodeDetail {
  nodeKey: string;
  descriptor: { localId: string; name: string; provider: string; model?: string; cli: Record<string, unknown> };
  identity?: string;
  rules: { file: string; content: string }[];
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

function ruleBaseName(file: string): string {
  const idx = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return idx >= 0 ? file.slice(idx + 1) : file;
}

interface EditorProps {
  title: string;
  hint?: string;
  initial: string;
  save: (content: string) => Promise<boolean>;
}

function FileEditor({ title, hint, initial, save }: EditorProps) {
  const [draft, setDraft] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'ok' | 'err'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(initial);
    setDirty(false);
  }, [initial]);

  const onSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const ok = await save(draft);
      if (ok) {
        setStatus('ok');
        setDirty(false);
      } else {
        setStatus('err');
        setError('保存失败');
      }
    } catch (e) {
      setStatus('err');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onReset = (): void => {
    setDraft(initial);
    setDirty(false);
    setStatus('idle');
    setError(null);
  };

  return (
    <div style={styles.editor}>
      <div style={styles.editorHead}>
        <span style={styles.editorTitle}>{title}</span>
        {hint && <span style={styles.hint} title={hint}>{hint}</span>}
      </div>
      <textarea
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setDirty(true); setStatus('idle'); }}
        style={styles.textarea}
        spellCheck={false}
      />
      <div style={styles.editorFoot}>
        {status === 'ok' && <span style={styles.ok}>已保存</span>}
        {status === 'err' && <span style={styles.err}>{error ?? '保存失败'}</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" onClick={onReset} disabled={!dirty || saving} style={styles.btnGhost}>重置</button>
          <button type="button" onClick={onSave} disabled={saving || !dirty} style={styles.btnPrimary}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function NodeConfigPanel({ nodeKey: nodeKeyProp }: { nodeKey?: string } = {}) {
  const activeNodeId = useChatStore((s) => s.activeNodeId);
  const projectId = useGraphRunStore((s) => s.projectId);
  const nodeKey = nodeKeyProp ?? activeNodeId;
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const nodeUrl = `${API_URL}/api/projects/${projectId}/nodes/${encodeURIComponent(nodeKey)}`;

  useEffect(() => {
    setLoading(true);
    fetch(nodeUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setDetail(d); setLoading(false); })
      .catch(() => { setDetail(null); setLoading(false); });
  }, [nodeUrl, reloadKey]);

  const reload = (): void => setReloadKey((k) => k + 1);

  const saveIdentity = async (content: string): Promise<boolean> => {
    const r = await fetch(`${nodeUrl}/identity`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (r.ok) { reload(); return true; }
    throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  };

  const saveRule = (file: string) => async (content: string): Promise<boolean> => {
    const r = await fetch(`${nodeUrl}/rules`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, content }),
    });
    if (r.ok) { reload(); return true; }
    throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  };

  const createRule = async (): Promise<void> => {
    const name = newName.trim();
    if (!/^[a-z0-9][a-z0-9._-]*\.md$/i.test(name)) {
      setCreateError('文件名需形如 coding.md，仅字母数字 . _ -');
      return;
    }
    // file 为相对 nodeDir 的 tail（projects 路由按此解析 + 校验在 config/rules 内）
    const file = `config/rules/${name}`;
    const r = await fetch(`${nodeUrl}/rules`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, content: `# ${name.replace(/\.md$/, '')} 规则\n\n` }),
    });
    if (r.ok) { setNewName(''); setCreateError(null); reload(); return; }
    setCreateError((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  };

  if (loading) return <div style={styles.wrap}>加载节点配置…</div>;
  if (!detail) return <div style={styles.wrap}>无法加载节点配置</div>;

  return (
    <div style={styles.wrap}>
      <h3 style={styles.h}>{detail.descriptor.name}</h3>
      <div style={styles.row}><span>nodeKey</span><code>{detail.nodeKey}</code></div>
      <div style={styles.row}><span>localId</span><code>{detail.descriptor.localId}</code></div>
      <div style={styles.row}><span>provider</span><code>{detail.descriptor.provider}</code></div>
      <div style={styles.row}><span>model</span><code>{detail.descriptor.model || '(默认)'}</code></div>

      <h4 style={styles.h2}>身份 (identity)</h4>
      <FileEditor
        key={`identity-${nodeKey}`}
        title="identity.md"
        initial={detail.identity ?? ''}
        save={saveIdentity}
      />

      <h4 style={styles.h2}>规则 (rules)</h4>
      {detail.rules.length === 0 ? (
        <div style={styles.empty}>(无规则文件，可在下方新建)</div>
      ) : (
        detail.rules.map((r) => {
          const name = ruleBaseName(r.file);
          return (
            <FileEditor
              key={`${nodeKey}:${r.file}`}
              title={name}
              hint={r.file}
              initial={r.content}
              save={saveRule(r.file)}
            />
          );
        })
      )}
      <div style={styles.create}>
        <input
          style={styles.input}
          placeholder="新增规则文件，如 coding.md"
          value={newName}
          onChange={(e) => { setNewName(e.target.value); setCreateError(null); }}
        />
        <button type="button" onClick={createRule} style={styles.btnPrimary} disabled={!newName.trim()}>
          新建
        </button>
      </div>
      {createError && <div style={styles.err}>{createError}</div>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { height: '100%', minHeight: 0, padding: 16, overflowY: 'auto', overscrollBehavior: 'contain', fontSize: 13, color: 'var(--text)' },
  h: { margin: '0 0 12px', fontSize: 16, color: 'var(--text-strong)' },
  h2: { margin: '16px 0 8px', fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase' },
  row: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 },
  empty: { color: 'var(--text-faint)', fontStyle: 'italic', marginBottom: 8 },
  editor: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: 10,
    marginBottom: 10,
  },
  editorHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, gap: 8 },
  editorTitle: { fontSize: 12, fontFamily: 'monospace', color: 'var(--link)' },
  hint: { fontSize: 10, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 },
  textarea: {
    width: '100%',
    minHeight: 200,
    resize: 'vertical',
    background: 'var(--background)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    padding: 8,
    fontSize: 12,
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    boxSizing: 'border-box',
  },
  editorFoot: { display: 'flex', alignItems: 'center', marginTop: 6, gap: 8 },
  ok: { fontSize: 11, color: 'var(--success)' },
  err: { fontSize: 11, color: 'var(--danger)' },
  btnPrimary: {
    padding: '4px 10px', fontSize: 12, cursor: 'pointer',
    background: 'var(--surface-raised)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 4,
  },
  btnGhost: {
    padding: '4px 10px', fontSize: 12, cursor: 'pointer',
    background: 'transparent', color: 'var(--text-muted)',
    border: '1px solid var(--border)', borderRadius: 4,
  },
  create: { display: 'flex', gap: 8, marginTop: 8 },
  input: {
    flex: 1, padding: '6px 8px', fontSize: 12, fontFamily: 'monospace',
    background: 'var(--background)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 4,
  },
};
