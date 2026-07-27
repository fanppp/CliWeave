'use client';

import { useEffect, useRef } from 'react';
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
  if (bubble.eventType === 'tool_use') return { bg: 'var(--bubble-tool)', label: bubble.toolName ?? '工具' };
  return nodeMeta(bubble.nodeId, graph);
}

export function GraphRunStream() {
  const bubbles = useGraphRunStore((s) => s.bubbles);
  const status = useGraphRunStore((s) => s.status);
  const activeNodeId = useGraphRunStore((s) => s.activeNodeId);
  const graph = useGraphRunStore((s) => s.graph);
  const replayGraph = useGraphRunStore((s) => s.replayGraph);
  const labelGraph = replayGraph ?? graph;
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [bubbles, status, activeNodeId]);

  return (
    <div style={styles.wrap}>
      {bubbles.length === 0 && (
        <div style={styles.empty}>输入需求后点击“运行图”，按拓扑顺序触发各 CLI 节点协作。</div>
      )}
      {bubbles.map((b) => {
        const { bg, label } = bubbleStyle(b, labelGraph);
        const isActive = b.nodeId === activeNodeId;
        return (
          <div key={b.id} style={{ ...styles.bubble, background: bg, borderColor: isActive ? 'var(--success)' : 'transparent' }}>
            <div style={styles.meta}>
              <strong>{label}</strong>
              <span style={styles.nodeId}>{b.nodeId}</span>
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
      {status === 'running' && <div style={styles.thinking}>图运行中{activeNodeId ? `（当前：${activeNodeId}）` : ''}…</div>}
      <div ref={endRef} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 },
  empty: { color: 'var(--text-faint)', textAlign: 'center', marginTop: 40 },
  bubble: { borderRadius: 8, padding: '10px 14px', maxWidth: '85%', border: '2px solid transparent' },
  meta: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, opacity: 0.7, marginBottom: 4 },
  nodeId: { fontSize: 10, color: 'var(--text-faint)' },
  time: { fontSize: 10, marginLeft: 'auto' },
  content: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5, fontSize: 14 },
  pre: { margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--code-text)' },
  thinking: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 13, padding: '0 4px' },
};
