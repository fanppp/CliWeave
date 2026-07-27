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
  type EdgeChange,
  type NodeProps,
  MarkerType,
} from '@xyflow/react';
import { useGraphRunStore, type Graph, type GraphEdge, type GraphNode } from '../stores/graphRunStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

interface AgentMeta {
  nodeKey: string;
  name: string;
  provider: string;
}

interface NodeData {
  label: string;
  kind: 'input' | 'agent' | 'end';
  agentNodeKey?: string;
  [key: string]: unknown;
}

type FlowEdge = Edge & { maxIterations?: number };

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

/** 前端回边检测（DFS 三色，镜像后端 computeBackEdges）：target 在栈上 → 回边。 */
function computeBackEdgeIds(nodes: { id: string }[], edges: FlowEdge[]): Set<string> {
  const adj = new Map<string, FlowEdge[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) adj.get(e.source)?.push(e);
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.id, 0);
  const back = new Set<string>();
  const dfs = (id: string, stack: Set<string>): void => {
    color.set(id, 1);
    stack.add(id);
    for (const e of adj.get(id) ?? []) {
      if (stack.has(e.target)) back.add(e.id);
      else if ((color.get(e.target) ?? 0) === 0) dfs(e.target, stack);
    }
    stack.delete(id);
    color.set(id, 2);
  };
  for (const n of nodes) if ((color.get(n.id) ?? 0) === 0) dfs(n.id, new Set());
  return back;
}

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
    try { await startRun(text); setText(''); } catch (e) { setErr((e as Error).message); }
  }, [text, busy, startRun]);
  return (
    <div style={styles.inputNode}>
      <Handle type='source' id='out' position={Position.Bottom} />
      <div style={styles.inputNodeHead}>🟰 输入</div>
      <textarea className='nodrag' style={styles.inputTextarea} value={text} onChange={(e) => setText(e.target.value)} placeholder='输入需求，按发送启动图运行…' rows={3} disabled={busy} />
      {err && <div style={styles.inputErr}>{err}</div>}
      {busy ? (
        <button className='nodrag' style={{ ...styles.inputBtn, background: 'var(--danger)' }} onClick={() => void abortRun()}>停止</button>
      ) : (
        <button className='nodrag' style={styles.inputBtn} disabled={!text.trim()} onClick={() => void submit()}>发送</button>
      )}
      <span style={styles.inputHint}>{id}</span>
    </div>
  );
}

function AgentNode({ id, data }: NodeProps) {
  const d = data as unknown as NodeData;
  const activeNodeIds = useGraphRunStore((s) => s.activeNodeIds);
  const nodeIterations = useGraphRunStore((s) => s.nodeIterations);
  const selectedGraphNodeId = useGraphRunStore((s) => s.selectedGraphNodeId);
  const setSelectedGraphNodeId = useGraphRunStore((s) => s.setSelectedGraphNodeId);
  const setSelectedAgentNodeKey = useGraphRunStore((s) => s.setSelectedAgentNodeKey);
  const active = activeNodeIds.includes(id);
  const provider = d.agentNodeKey?.split(':')[0] ?? 'agent';
  const selected = selectedGraphNodeId === id;
  const iter = nodeIterations[id];
  return (
    <div
      className={active ? 'agent-node-active' : undefined}
      style={{ ...styles.agentNode, background: providerColor(provider), outline: selected ? '2px solid var(--accent)' : 'none' }}
      onClick={() => { setSelectedGraphNodeId(id); if (d.agentNodeKey) setSelectedAgentNodeKey(d.agentNodeKey); }}
    >
      <Handle type='target' id='in' position={Position.Top} />
      {/* 左侧 loop handles：回边 B→A = 从下方节点 back-out 拖到上方节点 back-in（向上） */}
      <Handle type='source' id='back-out' position={Position.Left} style={{ ...styles.loopHandle, top: '30%' }} />
      <Handle type='target' id='back-in' position={Position.Left} style={{ ...styles.loopHandle, top: '70%' }} />
      <div style={styles.agentHead}>
        <strong style={{ fontSize: 12 }}>{provider}</strong>
        {(iter ?? 0) > 1 ? <span style={styles.iterBadge}>iter {iter}</span> : null}
        {active && <span style={styles.badge}>执行中</span>}
      </div>
      <div style={styles.agentLabel}>{d.label}</div>
      <Handle type='source' id='out' position={Position.Bottom} />
    </div>
  );
}

function EndNode() {
  return (
    <div style={styles.endNode}>
      <Handle type='target' id='in' position={Position.Top} />
      <Handle type='target' id='back-in' position={Position.Left} style={{ ...styles.loopHandle, top: '70%' }} />
      <div style={{ fontSize: 12, fontWeight: 700 }}>⏹ 结束</div>
    </div>
  );
}

const nodeTypes = { input: InputNode, agent: AgentNode, end: EndNode };

function toFlowNodes(graph: Graph | null, agentNameMap: Map<string, string>): Node[] {
  if (!graph) return [];
  return graph.nodes.map((n, i) => {
    const pos = n.position ?? { x: 320, y: 80 + i * 140 };
    const name = n.type === 'agent' && n.agentNodeKey ? (agentNameMap.get(n.agentNodeKey) ?? n.agentNodeKey) : n.type === 'input' ? '输入' : '结束';
    const data: NodeData = { label: name, kind: n.type, ...(n.type === 'agent' ? { agentNodeKey: n.agentNodeKey } : {}) };
    return { id: n.id, type: n.type, position: pos, data, deletable: n.type !== 'input' && n.type !== 'end' } as Node;
  });
}

function toFlowEdges(graph: Graph | null, backIds: Set<string>): FlowEdge[] {
  if (!graph) return [];
  return graph.edges.map((e) => {
    const isBack = backIds.has(e.id);
    return {
      id: e.id, source: e.source, target: e.target,
      sourceHandle: isBack ? 'back-out' : 'out',
      targetHandle: isBack ? 'back-in' : 'in',
      markerEnd: { type: MarkerType.ArrowClosed },
      style: isBack ? { stroke: '#f87171', strokeDasharray: '6 4' } : { stroke: '#9aa3ad' },
      label: isBack ? `回边${e.maxIterations ? `·${e.maxIterations}` : '·1'}` : '',
      labelStyle: { fill: '#f87171', fontSize: 10 },
      ...(e.maxIterations != null ? { maxIterations: e.maxIterations } : {}),
    } as FlowEdge;
  });
}

export function GraphCanvas() {
  const graph = useGraphRunStore((s) => s.graph);
  const loadGraph = useGraphRunStore((s) => s.loadGraph);
  const saveGraph = useGraphRunStore((s) => s.saveGraph);
  const saveError = useGraphRunStore((s) => s.saveError);
  const selectedGraphNodeId = useGraphRunStore((s) => s.selectedGraphNodeId);
  const setSelectedGraphNodeId = useGraphRunStore((s) => s.setSelectedGraphNodeId);
  const setSelectedAgentNodeKey = useGraphRunStore((s) => s.setSelectedAgentNodeKey);

  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const agentNameMap = useMemo(() => new Map(agents.map((a) => [a.nodeKey, a.name] as const)), [agents]);
  const [nodes, setNodes, onNodesChange] = useNodesState(toFlowNodes(graph, agentNameMap));
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [picker, setPicker] = useState(false);
  const [selEdge, setSelEdge] = useState<FlowEdge | null>(null);
  const skipCommit = useRef(true);
  // 仅结构变更（增删/移动/连边）才提交；纯选中不触发 save（否则 save 回环重建边会丢选中）
  const dirtyRef = useRef(false);

  // 回边集（随 nodes/edges 变化重算，用于边样式 + 面板标签）
  const backIds = useMemo(() => computeBackEdgeIds(nodes, edges), [nodes, edges]);

  useEffect(() => {
    if (graph) return;
    fetch(`${API_URL}/api/graph`).then((r) => (r.ok ? r.json() : null)).then((g: Graph | null) => {
      if (g) { loadGraph(g); setNodes(toFlowNodes(g, agentNameMap)); }
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // graph 加载后同步边（带回边样式）
  useEffect(() => {
    const bid = computeBackEdgeIds(graph?.nodes ?? [], (graph?.edges ?? []) as unknown as FlowEdge[]);
    setEdges(toFlowEdges(graph, bid));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  useEffect(() => {
    fetch(`${API_URL}/api/agents`).then((r) => (r.ok ? r.json() : [])).then((list: AgentMeta[]) => setAgents(Array.isArray(list) ? list : [])).catch(() => setAgents([]));
  }, []);

  const commit = useCallback((ns: Node[], es: FlowEdge[]) => {
    if (skipCommit.current) return;
    if (ns.length === 0) return;
    if (!dirtyRef.current) return; // 选中/样式等非结构变更不保存
    dirtyRef.current = false;
    void saveGraph(buildGraph(ns, es));
  }, [saveGraph]);

  useEffect(() => {
    if (skipCommit.current) { skipCommit.current = false; return; }
    const t = setTimeout(() => commit(nodes, edges), 300);
    return () => clearTimeout(t);
  }, [nodes, edges, commit]);

  const handleConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    setEdges((eds) => {
      // 同向重复（如已有 A→B 又画 A→B）静默忽略，避免落 400 后画布残留坏边
      if (eds.some((e) => e.source === c.source && e.target === c.target)) return eds;
      return addEdge<FlowEdge>({ ...c, id: `${c.source}->${c.target}`, markerEnd: { type: MarkerType.ArrowClosed } }, eds);
    });
    dirtyRef.current = true;
  }, [setEdges]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    onNodesChange(changes);
    if (changes.some((c) => c.type !== 'select')) dirtyRef.current = true;
    const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id));
    if (removed.size > 0) setEdges((es) => es.filter((e) => !removed.has(e.source) && !removed.has(e.target)));
  }, [onNodesChange, setEdges]);

  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    onEdgesChange(changes);
    if (changes.some((c) => c.type !== 'select')) dirtyRef.current = true;
  }, [onEdgesChange]);

  const handlePaneClick = useCallback(() => {
    setSelectedGraphNodeId(null); setSelectedAgentNodeKey(null); setSelEdge(null);
    setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
    setEdges((es) => es.map((e) => ({ ...e, selected: false })));
  }, [setSelectedGraphNodeId, setSelectedAgentNodeKey, setNodes, setEdges]);

  const deleteSelected = useCallback(() => {
    setNodes((ns) => ns.filter((n) => !(n.selected && (n.data as unknown as NodeData).kind !== 'input' && (n.data as unknown as NodeData).kind !== 'end')));
    setEdges((es) => es.filter((e) => !e.selected));
    setSelEdge(null);
    dirtyRef.current = true;
  }, [setNodes, setEdges]);

  const onEdgeClick = useCallback((_: unknown, edge: Edge) => {
    setSelEdge(edge as FlowEdge);
    setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
    setSelectedGraphNodeId(null); setSelectedAgentNodeKey(null);
  }, [setNodes, setSelectedGraphNodeId, setSelectedAgentNodeKey]);

  const onNodeClick = useCallback((_: unknown, _node: Node) => {
    setEdges((es) => es.map((e) => ({ ...e, selected: false })));
    setSelEdge(null);
  }, [setEdges]);

  const addAgentNode = useCallback((agent: AgentMeta) => {
    const id = `n${Date.now().toString(36)}`;
    const data: NodeData = { label: agent.name, kind: 'agent', agentNodeKey: agent.nodeKey };
    // 按顺序纵向排列（从上到下），保证左侧 loop handle 可达
    const idx = nodes.length;
    setNodes((ns) => [...ns, { id, type: 'agent', position: { x: 320, y: 80 + idx * 140 }, data, deletable: true } as Node]);
    setPicker(false);
    dirtyRef.current = true;
  }, [setNodes, nodes.length]);

  const addEndNode = useCallback(() => {
    if (nodes.some((n) => (n.data as unknown as NodeData).kind === 'end')) return;
    const id = `end_${Date.now().toString(36)}`;
    const idx = nodes.length;
    setNodes((ns) => [...ns, { id, type: 'end', position: { x: 320, y: 80 + idx * 140 }, data: { label: '结束', kind: 'end' }, deletable: false } as Node]);
    dirtyRef.current = true;
  }, [nodes, setNodes]);

  // 选中边编辑 maxIterations（仅回边有意义；前向边无需）
  const updateEdge = useCallback((maxIterations: number | null) => {
    if (!selEdge) return;
    setEdges((es) => es.map((e) => e.id === selEdge.id ? { ...e, ...(maxIterations != null ? { maxIterations } : {}) } : e));
    setSelEdge((se) => se ? { ...se, ...(maxIterations != null ? { maxIterations } : {}) } : se);
    dirtyRef.current = true;
  }, [selEdge, setEdges]);

  const graphNodes = useMemo(() => graph?.nodes ?? [], [graph]);
  const selEdgeIsBack = selEdge ? backIds.has(selEdge.id) : false;
  // 节点 id → 可读标签（取画布节点 data.label；input/end 用中文）
  const labelOf = useCallback(
    (id: string): string => {
      const n = nodes.find((x) => x.id === id);
      const label = n ? (n.data as unknown as NodeData).label : undefined;
      if (label) return label;
      if (id === '__input__') return '输入';
      if (id === '__end__') return '结束';
      return id;
    },
    [nodes],
  );

  return (
    <div style={styles.wrap}>
      <div style={styles.toolbar}>
        <button style={styles.btn} onClick={() => setPicker((v) => !v)}>+ 加入节点</button>
        <button style={{ ...styles.btn, background: 'var(--surface-raised)', color: 'var(--text)' }} onClick={() => void addEndNode()}>+ 结束节点</button>
        <button style={{ ...styles.btn, background: 'var(--surface-raised)', color: 'var(--text)' }} onClick={deleteSelected}>删除选中</button>
        <span style={styles.hint}>前向边：上节点底部 → 下节点顶部。回边：从下节点左侧 back-out 拖到上节点左侧 back-in（向上=不满足→回），默认覆盖1次（返工1轮）。</span>
      </div>
      {saveError && <div style={styles.errBanner} title={saveError}>⚠ {saveError}</div>}
      {picker && (
        <div style={styles.picker}>
          {agents.length === 0 && <div style={styles.pickerEmpty}>没有可用 agent 节点</div>}
          {agents.map((a) => {
            const inGraph = graphNodes.some((n) => n.type === 'agent' && n.agentNodeKey === a.nodeKey);
            return (
              <button key={a.nodeKey} style={{ ...styles.agentBtn, ...(inGraph ? styles.agentBtnDisabled : {}) }} disabled={inGraph} onClick={() => addAgentNode(a)} title={inGraph ? '已在图中' : `加入 ${a.nodeKey}`}>
                <strong>{a.provider}</strong> · {a.name}{inGraph && <span> ✓</span>}
              </button>
            );
          })}
        </div>
      )}
      {selEdge && (
        <div style={styles.edgePanel}>
          <strong style={{ fontSize: 11 }}>{labelOf(selEdge.source)} → {labelOf(selEdge.target)}</strong>
          <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>id: {selEdge.id}</div>
          <div style={{ fontSize: 10, color: selEdgeIsBack ? 'var(--danger)' : 'var(--text-faint)' }}>
            {selEdgeIsBack ? '↩ 回边（不满足→回到目标；决策点会解析 VERDICT）' : '→ 前向边（满意→继续）'}
          </div>
          {selEdgeIsBack && (
            <label style={styles.edgeLabel}>maxIterations（空=默认1）
              <input className='nodrag' style={styles.edgeInput} type='number' min={1} value={selEdge.maxIterations ?? ''} onChange={(e) => updateEdge(e.target.value === '' ? null : Math.max(1, Number(e.target.value)))} />
            </label>
          )}
        </div>
      )}
      <div style={styles.flow}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={handleConnect}
          onPaneClick={handlePaneClick}
          onEdgeClick={onEdgeClick}
          onNodeClick={onNodeClick}
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

function buildGraph(nodes: Node[], edges: FlowEdge[]): Graph {
  const graphNodes: GraphNode[] = nodes.map((n) => {
    const data = n.data as unknown as NodeData;
    const base = { id: n.id, position: n.position };
    if (data.kind === 'input') return { ...base, type: 'input' } as GraphNode;
    if (data.kind === 'end') return { ...base, type: 'end' } as GraphNode;
    return { ...base, type: 'agent', agentNodeKey: data.agentNodeKey ?? '' } as GraphNode;
  });
  const graphEdges: GraphEdge[] = edges.map((e) => ({ id: `${e.source}->${e.target}`, source: e.source, target: e.target, ...(e.maxIterations != null ? { maxIterations: e.maxIterations } : {}) }));
  const inputNode = graphNodes.find((n) => n.type === 'input')?.id ?? '__input__';
  const endNode = graphNodes.find((n) => n.type === 'end')?.id;
  return { schemaVersion: 3, inputNode, ...(endNode ? { endNode } : {}), nodes: graphNodes, edges: graphEdges };
}

const styles: Record<string, CSSProperties> = {
  wrap: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' },
  toolbar: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--border)' },
  btn: { background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 13, cursor: 'pointer' },
  hint: { fontSize: 12, color: 'var(--text-faint)' },
  errBanner: { background: 'var(--bubble-system)', color: 'var(--danger)', fontSize: 12, padding: '6px 12px', borderBottom: '1px solid var(--border)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  picker: { position: 'absolute', top: 44, left: 12, zIndex: 10, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflowY: 'auto', minWidth: 220 },
  pickerEmpty: { color: 'var(--text-faint)', fontSize: 12, padding: 8 },
  agentBtn: { textAlign: 'left', background: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 12, cursor: 'pointer' },
  agentBtnDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  edgePanel: { position: 'absolute', top: 44, right: 12, zIndex: 10, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220 },
  edgeLabel: { display: 'flex', flexDirection: 'column', fontSize: 11, color: 'var(--text-muted)', gap: 4 },
  edgeInput: { background: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: 12 },
  flow: { flex: 1, minHeight: 0 },
  inputNode: { width: 240, background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 },
  inputNodeHead: { fontSize: 12, fontWeight: 700, color: 'var(--text-strong)' },
  inputTextarea: { width: '100%', resize: 'vertical', background: 'var(--background)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' },
  inputErr: { color: 'var(--danger)', fontSize: 11 },
  inputBtn: { background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 4, padding: '6px 10px', fontSize: 13, cursor: 'pointer' },
  inputHint: { fontSize: 10, color: 'var(--text-faint)' },
  agentNode: { width: 170, padding: 8, borderRadius: 8, color: '#e6e6e6', cursor: 'pointer', border: '1px solid var(--border)' },
  agentHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, gap: 4 },
  badge: { fontSize: 10, background: 'var(--success)', color: '#001', padding: '1px 6px', borderRadius: 8, fontWeight: 700 },
  iterBadge: { fontSize: 9, background: 'var(--accent)', color: '#fff', padding: '1px 5px', borderRadius: 8 },
  agentLabel: { fontSize: 13, fontWeight: 600 },
  loopHandle: { width: 8, height: 8, background: 'var(--danger)', border: '1px solid #fff' },
  endNode: { width: 100, padding: '8px 10px', borderRadius: 8, background: 'var(--surface-raised)', border: '1px solid var(--border)', textAlign: 'center', color: 'var(--text-muted)' },
};
