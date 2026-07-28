'use client';

import { useEffect, useState } from 'react';
import { useChatStore } from '../stores/chatStore';
import { AddNodeModal } from './AddNodeModal';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

interface NodeItem {
  nodeKey: string;
  instanceKey: string;
  localId: string;
  name: string;
  provider: string;
}

export function NodeSelector() {
  const projectId = useChatStore((s) => s.projectId);
  const activeNodeId = useChatStore((s) => s.activeNodeId);
  const setActiveNode = useChatStore((s) => s.setActiveNode);
  const setActiveInstanceKey = useChatStore((s) => s.setActiveInstanceKey);
  const hydrateActiveNode = useChatStore((s) => s.hydrateActiveNode);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const triggerReload = useChatStore((s) => s.triggerReload);
  const reloadKey = useChatStore((s) => s.reloadKey);
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [showAdd, setShowAdd] = useState(false);

  const refresh = (): void => {
    // 竞态保护：捕获请求时的 projectId，返回后若已变则丢弃（防 A→B 时 A 的慢列表覆盖 B）
    const requestedPid = useChatStore.getState().projectId;
    fetch(`${API_URL}/api/projects/${requestedPid}/nodes`)
      .then((r) => (r.ok ? r.json() : { nodes: [] }))
      .then((d: { nodes: NodeItem[] }) => {
        if (useChatStore.getState().projectId !== requestedPid) return;
        const list = Array.isArray(d.nodes) ? d.nodes : [];
        setNodes(list);
        const current = useChatStore.getState().activeNodeId;
        const matched = list.find((node) => node.nodeKey === current);
        if (matched) {
          // 当前激活节点在新列表中 → 设置 instanceKey 供 useSocket join
          setActiveInstanceKey(matched.instanceKey);
        } else if (list.length > 0) {
          // 不在列表 → 选第一项（带 instanceKey）
          setActiveNode(list[0].nodeKey, list[0].instanceKey);
          triggerReload();
        } else {
          setActiveInstanceKey(null);
        }
      })
      .catch(() => setNodes([]));
  };

  useEffect(() => {
    hydrateActiveNode();
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, projectId]);

  const switchNode = (id: string): void => {
    const item = nodes.find((n) => n.nodeKey === id);
    setActiveNode(id, item?.instanceKey);
    triggerReload();
  };

  const del = async (id: string): Promise<void> => {
    if (!confirm(`删除节点 ${id}？其配置与记忆目录会一并删除。`)) return;
    const pid = useChatStore.getState().projectId;
    const response = await fetch(`${API_URL}/api/projects/${pid}/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) return;
    if (id === activeNodeId && nodes.length > 0) {
      const next = nodes.find((n) => n.nodeKey !== id);
      if (next) setActiveNode(next.nodeKey, next.instanceKey);
    }
    refresh();
    triggerReload();
  };

  const onCreated = (id: string, instanceKey: string): void => {
    setShowAdd(false);
    refresh();
    setActiveNode(id, instanceKey);
    triggerReload();
  };

  return (
    <div style={styles.wrap}>
      <select
        style={styles.select}
        value={activeNodeId}
        onChange={(e) => switchNode(e.target.value)}
        disabled={isStreaming}
      >
        {nodes.map((n) => (
          <option key={n.nodeKey} value={n.nodeKey}>
            {n.name} ({n.provider}/{n.localId})
          </option>
        ))}
      </select>
      <button style={styles.addBtn} title='新建节点' onClick={() => setShowAdd(true)} disabled={isStreaming}>
        + 新节点
      </button>
      <button style={styles.delBtn} title='删除当前节点' onClick={() => void del(activeNodeId)} disabled={isStreaming}>
        ×
      </button>
      {showAdd && <AddNodeModal onClose={() => setShowAdd(false)} onCreated={onCreated} />}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', alignItems: 'center', gap: 4 },
  select: {
    background: 'var(--surface-raised)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 12,
    maxWidth: 200,
  },
  addBtn: {
    background: 'var(--accent)',
    color: 'var(--accent-text)',
    border: 'none',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  delBtn: {
    background: 'transparent',
    color: 'var(--danger)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    width: 26,
    height: 26,
    fontSize: 15,
    lineHeight: 1,
  },
};
