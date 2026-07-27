'use client';

import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type NodeProps,
  MarkerType,
} from '@xyflow/react';
import { useGraphRunStore, type Graph, type GraphNode } from '../stores/graphRunStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

interface AgentMeta {
  nodeKey: string;
  name: string;
  provider: string;
}

interface NodeData {
  label: string;
  kind: 'input' | 'agent';
  agentNodeKey?: string;
  [key: string]: unknown;
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

/** 输入节点：自带 textarea + 发送/停止（功能2） */
function InputNode({ id }: NodeProps) {
  const status = useGraphRunStore((s) => s.status);
  const startRun = useGraphRunStore((s) => s.startRun);
  const abortRun = useGraphRunStore((s) => s.abortRun);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const busy = status === 'running';

  const submit = useCallback(async () => {
    if (!text.trim() || busy) return;
    setErr(null);
    try {
      await startRun(text);
      setText('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [text, busy, startRun]);

  return (
    <div className='graph-input-node' style={styles.inputNode}>
      {/* 输入节点是 START，只需 source handle（底部） */}
      <Handle type='source' position={Position.Bottom} />
      <div style={styles.inputNodeHead}>🟰 输入</div>
      <textarea
        className='nodrag'
        style={styles.inputTextarea}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='输入需求，按发送启动图运行…'
        rows={3}
        disabled={busy}
      />
      {err && <div style={styles.inputErr}>{err}</div>}
      {busy ? (
        <button className='nodrag' style={{ ...styles.inputBtn, background: 'var(--danger)' }} onClick={() => void abortRun()}>
          停止
        </button>
      ) : (
        <button className='nodrag' style={styles.inputBtn} disabled={!text.trim()} onClick={() => void submit()}>
          发送
        </button>
      )}
      <span style={styles.inputHint}>{id}</span>
    </div>
  );
}

/** agent 节点：执行中边缘闪光 + 角标（功能3，支持多节点同时执行） */
function AgentNode({ id, data }: NodeProps) {
  const d = data as unknown as NodeData;
  const activeNodeIds = useGraphRunStore((s) => s.activeNodeIds);
  const selectedGraphNodeId = useGraphRunStore((s) => s.selectedGraphNodeId);
  const setSelectedGraphNodeId = useGraphRunStore((s) => s.setSelectedGraphNodeId);
  const setSelectedAgentNodeKey = useGraphRunStore((s) => s.setSelectedAgentNodeKey);
  const active = activeNodeIds.includes(id);
  const provider = d.agentNodeKey?.split(':')[0] ?? 'agent';
  const selected = selectedGraphNodeId === id;

  return (
    <div
      className={active ? 'agent-node-active' : undefined}
      style={{
        ...styles.agentNode,
        background: providerColor(provider),
        outline: selected ? '2px solid var(--accent)' : 'none',
      }}
      onClick={() => {
        setSelectedGraphNodeId(id);
        if (d.agentNodeKey) setSelectedAgentNodeKey(d.agentNodeKey);
      }}
    >
      <Handle type='target' position={Position.Top} />
      <div style={styles.agentHead}>
        <strong style={{ fontSize: 12 }}>{provider}</strong>
        {active && <span style={styles.badge}>执行中</span>}
      </div>
      <div style={styles.agentLabel}>{d.label}</div>
      <div style={styles.agentKey}>{d.agentNodeKey}</div>
      <Handle type='source' position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { input: InputNode, agent: AgentNode };

function toFlowNodes(graph: Graph | null, agentNameMap: Map<string, string>): Node[] {
  if (!graph) return [];
  return graph.nodes.map((n, i) => {
    const isInput = n.type === 'input';
    const pos = n.position ?? { x: 80 + (i % 3) * 240, y: 60 + Math.floor(i / 3) * 160 };
    const provider = n.agentNodeKey?.split(':')[0] ?? 'input';
    const name = n.agentNodeKey ? (agentNameMap.get(n.agentNodeKey) ?? n.agentNodeKey) : '输入';
    const data: NodeData = {
      label: isInput ? '🟰 输入' : name,
      kind: n.type,
      ...(n.type === 'agent' ? { agentNodeKey: n.agentNodeKey } : {}),
    };
    return {
      id: n.id,
      type: isInput ? 'input' : 'agent',
      position: pos,
      data,
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
  const setSelectedAgentNodeKey = useGraphRunStore((s) => s.setSelectedAgentNodeKey);
  const setSelectedGraphNodeId = useGraphRunStore((s) => s.setSelectedGraphNodeId);
  const setAgentNameMap = useGraphRunStore((s) => s.setAgentNameMap);
  const selectedGraphNodeId = useGraphRunStore((s) => s.selectedGraphNodeId);

  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const agentNameMap = useMemo(() => new Map(agents.map((a) => [a.nodeKey, a.name] as const)), [agents]);
  const [nodes, setNodes, onNodesChange] = useNodesState(toFlowNodes(graph, agentNameMap));
  const [edges, setEdges, onEdgesChange] = useEdgesState(toFlowEdges(graph));
  const [picker, setPicker] = useState(false);
  const skipCommit = useRef(true);

  useEffect(() => {
    if (graph) return;
    fetch(`${API_URL}/api/graph`)
      .then((r) => (r.ok ? r.json() : null))
      .then((g: Graph | null) => {
        if (g) {
          loadGraph(g);
          setNodes(toFlowNodes(g, agentNameMap));
          setEdges(toFlowEdges(g));
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setNodes(toFlowNodes(graph, agentNameMap));
    setEdges(toFlowEdges(graph));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  useEffect(() => {
    fetch(`${API_URL}/api/agents`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: AgentMeta[]) => {
        const arr = Array.isArray(list) ? list : [];
        setAgents(arr);
        setAgentNameMap(Object.fromEntries(arr.map((a) => [a.nodeKey, a.name] as const)));
      })
      .catch(() => setAgents([]));
  }, []);

  const commit = useCallback(
    (nextNodes: Node[], nextEdges: Edge[]) => {
      if (skipCommit.current) return;
      void saveGraph(buildGraph(nextNodes, nextEdges));
    },
    [saveGraph],
  );

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

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);
      const removed = new Set(
        changes.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id),
      );
      if (removed.size > 0) {
        setEdges((eds) => eds.filter((e) => !removed.has(e.source) && !removed.has(e.target)));
      }
    },
    [onNodesChange, setEdges],
  );

  // 点击空白处取消选择（流过滤 + 配置选择都清）
  const handlePaneClick = useCallback(() => {
    setSelectedGraphNodeId(null);
    setSelectedAgentNodeKey(null);
  }, [setSelectedGraphNodeId, setSelectedAgentNodeKey]);

  // 删除选中（节点非 input + 边），用 xyflow selected 标记，不依赖键盘焦点（#1）
  const deleteSelected = useCallback(() => {
    setNodes((ns) => ns.filter((n) => !(n.selected && n.id !== '__input__' && (n.data as unknown as NodeData).kind !== 'input')));
    setEdges((es) => es.filter((e) => !e.selected));
  }, [setNodes, setEdges]);

  // 加节点；若已选中某 agent 节点，自动连边作为"后续节点"（#2）
  const addAgentNode = useCallback(
    (agent: AgentMeta) => {
      const id = `n${Date.now().toString(36)}`;
      const data: NodeData = { label: agent.name, kind: 'agent', agentNodeKey: agent.nodeKey };
      const fromId = selectedGraphNodeId && selectedGraphNodeId !== '__input__' ? selectedGraphNodeId : null;
      const newNode: Node = {
        id,
        type: 'agent',
        position: { x: 120 + Math.random() * 200, y: 100 + Math.random() * 160 },
        data,
        deletable: true,
      };
      setNodes((ns) => [...ns, newNode]);
      if (fromId) {
        setEdges((es) => [...es, { id: `${fromId}->${id}`, source: fromId, target: id, markerEnd: { type: MarkerType.ArrowClosed } }]);
      }
      setPicker(false);
    },
    [setNodes, setEdges, selectedGraphNodeId],
  );

  const graphNodes = useMemo(() => graph?.nodes ?? [], [graph]);

  return (
    <div style={styles.wrap}>
      <div style={styles.toolbar}>
        <button style={styles.btn} onClick={() => setPicker((v) => !v)}>
          + 加入节点{selectedGraphNodeId && selectedGraphNodeId !== '__input__' ? '（后续）' : ''}
        </button>
        <button style={{ ...styles.btn, background: 'var(--surface-raised)', color: 'var(--text)' }} onClick={deleteSelected}>
          删除选中
        </button>
        <span style={styles.hint}>选中节点/边后点「删除选中」；点节点显示其流+配置；选中后加入节点=后续</span>
      </div>
      {picker && (
        <div style={styles.picker}>
          {agents.length === 0 && <div style={styles.pickerEmpty}>没有可用 agent 节点</div>}
          {agents.map((a) => {
            const inGraph = graphNodes.some((n) => n.type === 'agent' && n.agentNodeKey === a.nodeKey);
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
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={handleConnect}
          onPaneClick={handlePaneClick}
          deleteKeyCode={['Backspace', 'Delete']}
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
    const data = n.data as unknown as NodeData;
    if (data.kind === 'input') {
      return { id: n.id, type: 'input', position: n.position };
    }
    return { id: n.id, type: 'agent', position: n.position, agentNodeKey: data.agentNodeKey ?? '' };
  });
  const graphEdges = edges.map((e) => ({ source: e.source, target: e.target }));
  const inputNode = graphNodes.find((n) => n.type === 'input')?.id ?? '__input__';
  return { schemaVersion: 1, inputNode, nodes: graphNodes, edges: graphEdges };
}

const styles: Record<string, CSSProperties> = {
  wrap: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' },
  toolbar: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--border)' },
  btn: { background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 13, cursor: 'pointer' },
  hint: { fontSize: 12, color: 'var(--text-faint)' },
  picker: { position: 'absolute', top: 44, left: 12, zIndex: 10, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflowY: 'auto', minWidth: 220 },
  pickerEmpty: { color: 'var(--text-faint)', fontSize: 12, padding: 8 },
  agentBtn: { textAlign: 'left', background: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 12, cursor: 'pointer' },
  agentBtnDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  flow: { flex: 1, minHeight: 0 },
  inputNode: { width: 240, background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 },
  inputNodeHead: { fontSize: 12, fontWeight: 700, color: 'var(--text-strong)' },
  inputTextarea: { width: '100%', resize: 'vertical', background: 'var(--background)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' },
  inputErr: { color: 'var(--danger)', fontSize: 11 },
  inputBtn: { background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 4, padding: '6px 10px', fontSize: 13, cursor: 'pointer' },
  inputHint: { fontSize: 10, color: 'var(--text-faint)' },
  agentNode: { width: 170, padding: 8, borderRadius: 8, color: '#e6e6e6', cursor: 'pointer', border: '1px solid var(--border)' },
  agentHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  badge: { fontSize: 10, background: 'var(--success)', color: '#001', padding: '1px 6px', borderRadius: 8, fontWeight: 700 },
  agentLabel: { fontSize: 13, fontWeight: 600 },
  agentKey: { fontSize: 10, color: 'var(--text-faint)', marginTop: 2 },
};
