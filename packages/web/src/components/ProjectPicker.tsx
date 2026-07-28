'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useGraphRunStore } from '../stores/graphRunStore';
import { useProjectStore } from '../stores/projectStore';

export function ProjectPicker() {
  const projects = useProjectStore((s) => s.projects);
  const currentId = useProjectStore((s) => s.currentId);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const switchProject = useProjectStore((s) => s.switchProject);
  const createProject = useProjectStore((s) => s.createProject);
  const chatStreaming = useChatStore((s) => s.isStreaming);
  const graphStatus = useGraphRunStore((s) => s.status);
  // 切换仲裁：单节点消息或图运行忙时禁用（防 abort 拿新 projectId 杀旧 invocation）
  const busy = chatStreaming || graphStatus === 'starting' || graphStatus === 'running';
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busyCreate, setBusy] = useState(false);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const submit = async (): Promise<void> => {
    const n = name.trim();
    if (!n) {
      setErr('名称必填');
      return;
    }
    if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test(n)) {
      setErr('名称须为小写 slug（a-z 0-9 _ -，2-41 字符，不能中文/大写/空格），作画布文件夹名');
      return;
    }
    if (n === 'default') {
      setErr('名称 default 为保留名，换一个');
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      // path 留空 → 后端用 default 同路径（CliWeave 根）；画布文件夹固定在 agents/projects/<name>/
      await createProject(n, path.trim());
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
        disabled={busy}
        title={busy ? '请先停止当前运行再切换画布' : '切换画布'}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}{p.pathMissing ? '（路径缺失）' : ''}
          </option>
        ))}
      </select>
      <button type='button' style={styles.btn} onClick={() => setOpen((v) => !v)} disabled={busy}>+ 新画布</button>
      {open && (
        <div style={styles.dialog}>
          <div style={styles.row}>
            <label style={styles.label}>画布名（作文件夹名：agents/projects/&lt;名&gt;/，小写 slug）</label>
            <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder='如：my-backend' />
          </div>
          <div style={styles.row}>
            <label style={styles.label}>绑定项目路径（可选；agent 工作目录 cwd；留空=CliWeave 根）</label>
            <input style={styles.input} value={path} onChange={(e) => setPath(e.target.value)} placeholder='如：D:/code/my-service（须存在；留空用 CliWeave 根）' />
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
