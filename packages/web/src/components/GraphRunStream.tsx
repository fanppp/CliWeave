'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useGraphRunStore, type GraphBubble, type GraphNode } from '../stores/graphRunStore';

function nodeMeta(nodeId: string, graph: { nodes: GraphNode[] } | null): { bg: string; label: string } {
  const node = graph?.nodes.find((n) => n.id === nodeId);
  if (node?.type === 'input') return { bg: 'var(--surface-raised)', label: '输入' };
  if (nodeId === '__run__') return { bg: 'var(--bubble-system)', label: '运行' };
  const provider = node?.agentNodeKey?.split(':')[0] ?? 'agent';
  switch (provider) {
    case 'codex':
      return { bg: 'var(--bubble-agent)', label: 'codex' };
    case 'claude':
      return { bg: 'var(--bubble-user)', label: 'claude' };
    case 'opencode':
      return { bg: 'var(--bubble-tool)', label: 'opencode' };
    default:
      return { bg: 'var(--bubble-agent)', label: provider };
  }
}

function bubbleStyle(bubble: GraphBubble, graph: { nodes: GraphNode[] } | null): { bg: string; label: string } {
  if (bubble.eventType === 'node_error' || bubble.eventType === 'run_error' || bubble.eventType === 'error') {
    return { bg: 'var(--bubble-system)', label: '错误' };
  }
  if (bubble.eventType === 'gate_exhausted') {
    return { bg: 'var(--bubble-system)', label: '预算耗尽' };
  }
  if (bubble.eventType === 'tool_use') return { bg: 'var(--bubble-tool)', label: bubble.toolName ?? '工具' };
  return nodeMeta(bubble.nodeId, graph);
}

export function GraphRunStream() {
  const bubbles = useGraphRunStore((s) => s.bubbles);
  const status = useGraphRunStore((s) => s.status);
  const activeNodeIds = useGraphRunStore((s) => s.activeNodeIds);
  const graph = useGraphRunStore((s) => s.graph);
  const replayGraph = useGraphRunStore((s) => s.replayGraph);
  const agentNameMap = useGraphRunStore((s) => s.agentNameMap);
  const viewNodeId = useGraphRunStore((s) => s.selectedGraphNodeId);
  const setViewNodeId = useGraphRunStore((s) => s.setSelectedGraphNodeId);
  const labelGraph = replayGraph ?? graph;
  const wrapRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // 图节点 id → 可读名（agent name，回退 agentNodeKey / id）
  const nodeLabel = useCallback(
    (id: string): string => {
      const node = labelGraph?.nodes.find((n) => n.id === id);
      if (node?.type === 'input') return '输入';
      const key = node?.agentNodeKey;
      if (key && agentNameMap[key]) return agentNameMap[key];
      return key ?? id;
    },
    [labelGraph, agentNameMap],
  );

  // 智能滚动：只在用户已在底部时自动滚到底（用户往上滑时不抢焦点）
  const onScroll = (): void => {
    const el = wrapRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  useEffect(() => {
    if (atBottomRef.current) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [bubbles, status, activeNodeIds]);

  // 可选节点列表
  const nodeIds = useMemo(() => {
    const set = new Set<string>();
    for (const b of bubbles) set.add(b.nodeId);
    for (const id of activeNodeIds) set.add(id);
    return Array.from(set);
  }, [bubbles, activeNodeIds]);

  const visible = viewNodeId ? bubbles.filter((b) => b.nodeId === viewNodeId) : bubbles;

  return (
    <div ref={wrapRef} onScroll={onScroll} style={styles.wrap}>
      <div style={styles.filterBar}>
        <select
          style={styles.select}
          value={viewNodeId ?? ''}
          onChange={(e) => setViewNodeId(e.target.value || null)}
        >
          <option value=''>全部节点</option>
          {nodeIds.map((id) => (
            <option key={id} value={id}>
              {nodeLabel(id)}
            </option>
          ))}
        </select>
        {viewNodeId && <button style={styles.clearBtn} onClick={() => setViewNodeId(null)}>×</button>}
      </div>
      {visible.length === 0 && (
        <div style={styles.empty}>
          {bubbles.length === 0
            ? '输入需求后点击“运行图”，按拓扑顺序触发各 CLI 节点协作。'
            : '该节点暂无消息。'}
        </div>
      )}
      {visible.map((b) => {
        const { bg, label } = bubbleStyle(b, labelGraph);
        const isActive = activeNodeIds.includes(b.nodeId);
        return (
          <div key={b.id} style={{ ...styles.bubble, background: bg, borderColor: isActive ? 'var(--success)' : 'transparent' }}>
            <div style={styles.meta}>
              <strong>{label}</strong>
              <span style={styles.nodeId}>{nodeLabel(b.nodeId)}</span>
              <span style={styles.time}>{new Date(b.timestamp).toLocaleTimeString()}</span>
            </div>
            {b.eventType === 'tool_use' || b.eventType === 'node_error' || b.eventType === 'run_error' ? (
              <pre style={styles.pre}>{b.content}</pre>
            ) : (
              <div style={styles.content}>{b.content}</div>
            )}
          </div>
        );
      })}
      {status === 'running' && (
        <div style={styles.thinking}>图运行中{activeNodeIds.length ? `（执行中：${activeNodeIds.join(', ')}）` : ''}…</div>
      )}
      <div ref={endRef} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 },
  filterBar: { display: 'flex', gap: 6, marginBottom: 4, flexShrink: 0 },
  select: { flex: 1, background: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: 12 },
  clearBtn: { background: 'var(--surface-raised)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 4, padding: '0 8px', cursor: 'pointer' },
  empty: { color: 'var(--text-faint)', textAlign: 'center', marginTop: 40 },
  bubble: { borderRadius: 8, padding: '10px 14px', maxWidth: '85%', border: '2px solid transparent' },
  meta: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, opacity: 0.7, marginBottom: 4 },
  nodeId: { fontSize: 10, color: 'var(--text-faint)' },
  time: { fontSize: 10, marginLeft: 'auto' },
  content: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5, fontSize: 14 },
  pre: { margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--code-text)' },
  thinking: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 13, padding: '0 4px' },
};
