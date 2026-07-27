'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useProjectStore } from '../stores/projectStore';

export function ProjectPicker() {
  const projects = useProjectStore((s) => s.projects);
  const currentId = useProjectStore((s) => s.currentId);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const switchProject = useProjectStore((s) => s.switchProject);
  const createProject = useProjectStore((s) => s.createProject);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const submit = async (): Promise<void> => {
    if (!name.trim() || !path.trim()) {
      setErr('名称和路径都必填');
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await createProject(name.trim(), path.trim());
      setName('');
      setPath('');
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.wrap}>
      <select
        style={styles.select}
        value={currentId}
        onChange={(e) => switchProject(e.target.value)}
        title='切换画布'
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}{p.pathMissing ? '（路径缺失）' : ''}
          </option>
        ))}
      </select>
      <button type='button' style={styles.btn} onClick={() => setOpen((v) => !v)}>+ 新画布</button>
      {open && (
        <div style={styles.dialog}>
          <div style={styles.row}>
            <label style={styles.label}>名称</label>
            <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder='如：我的后端服务' />
          </div>
          <div style={styles.row}>
            <label style={styles.label}>项目路径</label>
            <input style={styles.input} value={path} onChange={(e) => setPath(e.target.value)} placeholder='如：D:/code/my-service（须存在）' />
          </div>
          {err && <div style={styles.err}>{err}</div>}
          <div style={styles.actions}>
            <button type='button' style={styles.cancelBtn} onClick={() => setOpen(false)} disabled={busy}>取消</button>
            <button type='button' style={styles.okBtn} onClick={() => void submit()} disabled={busy}>{busy ? '创建中…' : '创建并切换'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrap: { position: 'relative', display: 'flex', alignItems: 'center', gap: 6 },
  select: { background: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', fontSize: 13, cursor: 'pointer' },
  btn: { background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, padding: '5px 10px', fontSize: 13, cursor: 'pointer' },
  dialog: { position: 'absolute', top: '34px', right: 0, zIndex: 30, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 320, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' },
  row: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 11, color: 'var(--text-muted)' },
  input: { background: 'var(--background)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', fontSize: 13 },
  err: { color: 'var(--danger)', fontSize: 11 },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
  cancelBtn: { background: 'var(--surface-raised)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 10px', fontSize: 13, cursor: 'pointer' },
  okBtn: { background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 4, padding: '5px 10px', fontSize: 13, cursor: 'pointer' },
};
