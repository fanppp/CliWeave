'use client';

import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  MarkerType,
} from '@xyflow/react';
import { useGraphRunStore, type Graph, type GraphNode } from '../stores/graphRunStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

interface AgentMeta {
  nodeKey: string;
  name: string;
  provider: string;
}

function providerColor(provider: string): string {
  switch (provider) {
    case 'codex':
      return '#1e2a1f';
    case 'claude':
      return '#1e3a5f';
    case 'opencode':
      return '#2a2333';
    default:
      return '#2a2d33';
  }
}

interface NodeData {
  label: string;
  kind: 'input' | 'agent';
  agentNodeKey?: string;
  [key: string]: unknown;
}

function toFlowNodes(graph: Graph | null): Node[] {
  if (!graph) return [];
  return graph.nodes.map((n, i) => {
    const isInput = n.type === 'input';
    const pos = n.position ?? { x: 80 + (i % 3) * 220, y: 60 + Math.floor(i / 3) * 140 };
    const provider = n.agentNodeKey?.split(':')[0] ?? 'input';
    const data: NodeData = {
      label: isInput ? '🟰 输入' : `${provider}: ${n.id}`,
      kind: n.type,
      ...(n.type === 'agent' ? { agentNodeKey: n.agentNodeKey } : {}),
    };
    return {
      id: n.id,
      type: 'default',
      position: pos,
      data,
      style: {
        background: isInput ? 'var(--surface-raised)' : providerColor(provider),
        color: '#e6e6e6',
        border: '1px solid var(--border)',
        width: 160,
      },
      deletable: !isInput,
    } as Node;
  });
}

function toFlowEdges(graph: Graph | null): Edge[] {
  if (!graph) return [];
  return graph.edges.map((e) => ({
    id: `${e.source}->${e.target}`,
    source: e.source,
    target: e.target,
    markerEnd: { type: MarkerType.ArrowClosed },
  }));
}

export function GraphCanvas() {
  const graph = useGraphRunStore((s) => s.graph);
  const loadGraph = useGraphRunStore((s) => s.loadGraph);
  const saveGraph = useGraphRunStore((s) => s.saveGraph);

  const [nodes, setNodes, onNodesChange] = useNodesState(toFlowNodes(graph));
  const [edges, setEdges, onEdgesChange] = useEdgesState(toFlowEdges(graph));
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [picker, setPicker] = useState(false);
  const skipCommit = useRef(true);

  // 首次加载图（useGraphRun 的 reloadGraph 在 GraphRunPanel 里调；此处兜底）
  useEffect(() => {
    if (graph) return;
    fetch(`${API_URL}/api/graph`)
      .then((r) => (r.ok ? r.json() : null))
      .then((g: Graph | null) => {
        if (g) {
          loadGraph(g);
          setNodes(toFlowNodes(g));
          setEdges(toFlowEdges(g));
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 图变化时同步到画布（如外部重载）
  useEffect(() => {
    setNodes(toFlowNodes(graph));
    setEdges(toFlowEdges(graph));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // 加载 agent 列表（用于"加入节点"）
  useEffect(() => {
    fetch(`${API_URL}/api/agents`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: AgentMeta[]) => setAgents(Array.isArray(list) ? list : []))
      .catch(() => setAgents([]));
  }, []);

  const commit = useCallback(
    (nextNodes: Node[], nextEdges: Edge[]) => {
      if (skipCommit.current) return;
      const g = buildGraph(nextNodes, nextEdges);
      void saveGraph(g);
    },
    [saveGraph],
  );

  // 任意变化（拖动/连边/删）debounce 300ms 全量 PUT（单用户：本地先合并，last-write-wins 无丢失）
  useEffect(() => {
    if (skipCommit.current) {
      skipCommit.current = false;
      return;
    }
    const t = setTimeout(() => commit(nodes, edges), 300);
    return () => clearTimeout(t);
  }, [nodes, edges, commit]);

  const handleConnect = useCallback(
    (c: Connection) => {
      setEdges((eds) => addEdge({ ...c, markerEnd: { type: MarkerType.ArrowClosed } }, eds));
    },
    [setEdges],
  );

  // 删节点时同步裁掉引用它的边
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);
      const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id));
      if (removed.size > 0) {
        setEdges((eds) => eds.filter((e) => !removed.has(e.source) && !removed.has(e.target)));
      }
    },
    [onNodesChange, setEdges],
  );

  const addAgentNode = useCallback(
    (agent: AgentMeta) => {
      const id = `n${Date.now().toString(36)}`;
      const provider = agent.provider;
      const data: NodeData = { label: `${provider}: ${agent.name}`, kind: 'agent', agentNodeKey: agent.nodeKey };
      const newNode: Node = {
        id,
        type: 'default',
        position: { x: 120 + Math.random() * 200, y: 100 + Math.random() * 160 },
        data,
        style: { background: providerColor(provider), color: '#e6e6e6', border: '1px solid var(--border)', width: 160 },
        deletable: true,
      };
      setNodes((ns) => [...ns, newNode]);
      setPicker(false);
    },
    [setNodes],
  );

  const graphNodes = useMemo(() => graph?.nodes ?? [], [graph]);

  return (
    <div style={styles.wrap}>
      <div style={styles.toolbar}>
        <button style={styles.btn} onClick={() => setPicker((v) => !v)}>
          + 加入节点
        </button>
        <span style={styles.hint}>拖动移动 · 拖节点边缘连线 · 选中按 Delete 删除（输入节点不可删）</span>
      </div>
      {picker && (
        <div style={styles.picker}>
          {agents.length === 0 && <div style={styles.pickerEmpty}>没有可用 agent 节点</div>}
          {agents.map((a) => {
            const inGraph = graphNodes.some(
              (n) => n.type === 'agent' && n.agentNodeKey === a.nodeKey,
            );
            return (
              <button
                key={a.nodeKey}
                style={{ ...styles.agentBtn, ...(inGraph ? styles.agentBtnDisabled : {}) }}
                disabled={inGraph}
                onClick={() => addAgentNode(a)}
                title={inGraph ? '已在图中（agentNodeKey 唯一）' : `加入 ${a.nodeKey}`}
              >
                <strong>{a.provider}</strong> · {a.name}
                {inGraph && <span> ✓</span>}
              </button>
            );
          })}
        </div>
      )}
      <div style={styles.flow}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={handleConnect}
          fitView
          nodesDraggable
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}

function buildGraph(nodes: Node[], edges: Edge[]): Graph {
  const graphNodes: GraphNode[] = nodes.map((n) => {
    const data = n.data as NodeData;
    if (data.kind === 'input') {
      return { id: n.id, type: 'input', position: n.position };
    }
    return { id: n.id, type: 'agent', position: n.position, agentNodeKey: data.agentNodeKey ?? '' };
  });
  const graphEdges = edges.map((e) => ({ source: e.source, target: e.target }));
  const inputNode = graphNodes.find((n) => n.type === 'input')?.id ?? '__input__';
  return {
    schemaVersion: 1,
    inputNode,
    nodes: graphNodes,
    edges: graphEdges,
  };
}

const styles: Record<string, CSSProperties> = {
  wrap: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' },
  toolbar: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--border)' },
  btn: { background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 13, cursor: 'pointer' },
  hint: { fontSize: 12, color: 'var(--text-faint)' },
  picker: {
    position: 'absolute',
    top: 44,
    left: 12,
    zIndex: 10,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    maxHeight: 260,
    overflowY: 'auto',
    minWidth: 220,
  },
  pickerEmpty: { color: 'var(--text-faint)', fontSize: 12, padding: 8 },
  agentBtn: { textAlign: 'left', background: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 12, cursor: 'pointer' },
  agentBtnDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  flow: { flex: 1, minHeight: 0 },
};
