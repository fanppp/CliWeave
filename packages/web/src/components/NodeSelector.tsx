'use client';

import { useEffect, useState } from 'react';
import { useChatStore } from '../stores/chatStore';
import { AddNodeModal } from './AddNodeModal';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

interface NodeItem {
  nodeKey: string;
  localId: string;
  name: string;
  provider: string;
}

export function NodeSelector() {
  const activeNodeId = useChatStore((s) => s.activeNodeId);
  const setActiveNode = useChatStore((s) => s.setActiveNode);
  const hydrateActiveNode = useChatStore((s) => s.hydrateActiveNode);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const triggerReload = useChatStore((s) => s.triggerReload);
  const reloadKey = useChatStore((s) => s.reloadKey);
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [showAdd, setShowAdd] = useState(false);

  const refresh = (): void => {
    fetch(`${API_URL}/api/agents`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: NodeItem[]) => {
        const nextNodes = Array.isArray(list) ? list : [];
        setNodes(nextNodes);
        const current = useChatStore.getState().activeNodeId;
        if (nextNodes.length > 0 && !nextNodes.some((node) => node.nodeKey === current)) {
          setActiveNode(nextNodes[0].nodeKey);
          triggerReload();
        }
      })
      .catch(() => setNodes([]));
  };

  useEffect(() => {
    hydrateActiveNode();
    refresh();
  }, [reloadKey]);

  const switchNode = (id: string): void => {
    setActiveNode(id);
    triggerReload();
  };

  const del = async (id: string): Promise<void> => {
    if (!confirm(`删除节点 ${id}？其配置与记忆目录会一并删除。`)) return;
    const response = await fetch(`${API_URL}/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) return;
    if (id === activeNodeId && nodes.length > 0) {
      const next = nodes.find((n) => n.nodeKey !== id)?.nodeKey ?? 'codex:codex-node';
      setActiveNode(next);
    }
    refresh();
    triggerReload();
  };

  const onCreated = (id: string): void => {
    setShowAdd(false);
    refresh();
    setActiveNode(id);
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
