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
  type Viewport,
  MarkerType,
} from '@xyflow/react';
import { useGraphRunStore, type Graph, type GraphEdge, type GraphNode } from '../stores/graphRunStore';
import { useIssuesStore } from '../stores/issuesStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

interface AgentMeta {
  nodeKey: string;
  name: string;
  provider: string;
}

interface ProviderMeta {
  id: string;
  name: string;
  command: string;
  memoryHome: string;
  defaultModel?: string;
  installed: boolean;
}

interface NodeData {
  label: string;
  kind: 'input' | 'agent' | 'decision' | 'end' | 'router' | 'project_knowledge' | 'documenter';
  agentNodeKey?: string;
  rubricRef?: string;
  policyRef?: string;
  [key: string]: unknown;
}

type FlowEdge = Edge & Pick<GraphEdge, 'maxIterations' | 'kind' | 'order' | 'maxRevisions' | 'onExhausted' | 'onBlocked' | 'lanes' | 'minRisk'>;

const VIEWPORT_KEY = '0agentteams.graphViewport:';
function readViewport(projectId: string): Viewport | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(VIEWPORT_KEY + projectId) ?? 'null') as Partial<Viewport> | null;
    return value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.zoom)
      ? { x: value.x!, y: value.y!, zoom: value.zoom! }
      : null;
  } catch { return null; }
}
function writeViewport(projectId: string, viewport: Viewport): void {
  try { window.localStorage.setItem(VIEWPORT_KEY + projectId, JSON.stringify(viewport)); } catch { /* unavailable */ }
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
  const runMode = useGraphRunStore((s) => s.runMode);
  const setRunMode = useGraphRunStore((s) => s.setRunMode);
  const graph = useGraphRunStore((s) => s.graph);
  const gatePolicyOverrides = useGraphRunStore((s) => s.gatePolicyOverrides);
  const setGatePolicyOverride = useGraphRunStore((s) => s.setGatePolicyOverride);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const busy = status === 'starting' || status === 'running' || status === 'paused';
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
      <div className='nodrag' style={styles.modeSegment} aria-label='运行模式'>
        <button type='button' title='首节点可对简单问题提前完成' style={{ ...styles.modeOption, ...(runMode === 'auto' ? styles.modeOptionActive : {}) }} onClick={() => setRunMode('auto')} disabled={busy}>Auto</button>
        <button type='button' title='始终按完整拓扑执行' style={{ ...styles.modeOption, ...(runMode === 'full' ? styles.modeOptionActive : {}) }} onClick={() => setRunMode('full')} disabled={busy}>Full</button>
      </div>
      {graph?.schemaVersion === 4 && graph.edges.filter((e) => e.kind === 'gate').map((gate) => (
        <label key={gate.id} className='nodrag' style={styles.gatePolicyLabel} title={gate.id}>
          Gate {gate.order}
          <select style={styles.gatePolicySelect} disabled={busy} value={gatePolicyOverrides[gate.id] ?? gate.onExhausted ?? 'ask_user'} onChange={(e) => setGatePolicyOverride(gate.id, e.target.value as 'ask_user' | 'continue_best' | 'fail')}>
            <option value='ask_user'>耗尽时暂停</option><option value='continue_best'>耗尽时放行</option><option value='fail'>耗尽时失败</option>
          </select>
        </label>
      ))}
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
      <Handle type='source' id='gate-out' position={Position.Right} style={{ background: '#60a5fa' }} />
    </div>
  );
}

function DecisionNode({ id, data }: NodeProps) {
  const d = data as unknown as NodeData;
  const active = useGraphRunStore((s) => s.activeNodeIds).includes(id);
  const selectedGraphNodeId = useGraphRunStore((s) => s.selectedGraphNodeId);
  const setSelectedGraphNodeId = useGraphRunStore((s) => s.setSelectedGraphNodeId);
  const setSelectedAgentNodeKey = useGraphRunStore((s) => s.setSelectedAgentNodeKey);
  return (
    <div className={active ? 'agent-node-active' : undefined} style={{ ...styles.decisionNode, outline: selectedGraphNodeId === id ? '2px solid var(--accent)' : 'none' }} onClick={() => { setSelectedGraphNodeId(id); if (d.agentNodeKey) setSelectedAgentNodeKey(d.agentNodeKey); }}>
      <Handle type='target' id='gate-in' position={Position.Left} style={{ background: '#60a5fa' }} />
      <Handle type='source' id='rework-out' position={Position.Left} style={{ ...styles.loopHandle, top: '72%' }} />
      <div style={styles.agentHead}><strong style={{ fontSize: 11 }}>EVALUATOR</strong>{active && <span style={styles.badge}>评估中</span>}</div>
      <div style={styles.agentLabel}>{d.label}</div>
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

/** V5：路由器节点（不进主链执行，只决策通道）。 */
function RouterNode({ id, data }: NodeProps) {
  const d = data as unknown as NodeData;
  const active = useGraphRunStore((s) => s.activeNodeIds).includes(id);
  const selected = useGraphRunStore((s) => s.selectedGraphNodeId) === id;
  return (
    <div className={active ? 'agent-node-active' : undefined} style={{ ...styles.decisionNode, background: '#3a2a1f', outline: selected ? '2px solid var(--accent)' : 'none' }}>
      <Handle type='target' id='in' position={Position.Top} />
      <div style={styles.agentHead}><strong style={{ fontSize: 11 }}>ROUTER</strong>{active && <span style={styles.badge}>路由中</span>}</div>
      <div style={styles.agentLabel}>{d.label}</div>
      <Handle type='source' id='route-out' position={Position.Bottom} style={{ background: '#a78bfa' }} />
    </div>
  );
}

/** V5：Project Knowledge 节点（issue 事实源；observe 边连 Scribe）。 */
function KnowledgeNode({ id }: NodeProps) {
  const selected = useGraphRunStore((s) => s.selectedGraphNodeId) === id;
  const openCount = useIssuesStore((s) => s.issues.filter((i) => ['observed', 'confirmed', 'open'].includes(i.status)).length);
  const closedCount = useIssuesStore((s) => s.issues.filter((i) => ['resolved', 'accepted', 'superseded'].includes(i.status)).length);
  return (
    <div style={{ ...styles.endNode, background: '#1f2a2a', outline: selected ? '2px solid var(--accent)' : 'none', minWidth: 120 }}>
      <Handle type='source' id='observe-out' position={Position.Right} style={{ background: '#34d399' }} />
      <div style={{ fontSize: 11, fontWeight: 700 }}>📚 知识库</div>
      <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>open {openCount} · closed {closedCount}</div>
    </div>
  );
}

/** V5：Documenter（Scribe）节点，后台总结，不进主链。 */
function DocumenterNode({ id, data }: NodeProps) {
  const d = data as unknown as NodeData;
  const selected = useGraphRunStore((s) => s.selectedGraphNodeId) === id;
  const lastSummarizeAt = useIssuesStore((s) => s.lastSummarizeAt);
  return (
    <div style={{ ...styles.endNode, background: '#2a2333', outline: selected ? '2px solid var(--accent)' : 'none', minWidth: 120 }}>
      <Handle type='target' id='observe-in' position={Position.Left} style={{ background: '#34d399' }} />
      <div style={{ fontSize: 11, fontWeight: 700 }}>✍ {d.label}</div>
      <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{lastSummarizeAt ? `总结 ${new Date(lastSummarizeAt).toLocaleTimeString()}` : '空闲'}</div>
    </div>
  );
}

const nodeTypes = { input: InputNode, agent: AgentNode, decision: DecisionNode, end: EndNode, router: RouterNode, project_knowledge: KnowledgeNode, documenter: DocumenterNode };

/** V5 泳道：按角色分到 Direct/Investigation/Engineering/Knowledge 列。 */
function v5LaneOf(n: GraphNode): number {
  if (n.type === 'input') return 0;
  if (n.type === 'router') return 1;
  if (n.type === 'project_knowledge') return 4;
  if (n.type === 'documenter') return 5;
  if (n.type === 'end') return 6;
  const key = n.agentNodeKey ?? '';
  if (key.includes('responder') || key.includes('review-analyst')) return 2; // Direct
  if (key.includes('investigator') || key.includes('verify-analyst')) return 3; // Investigation
  return 3; // Engineering: architect/plan-review/implementer/code-review/security-review/verify
}

function toFlowNodes(graph: Graph | null, agentNameMap: Map<string, string>): Node[] {
  if (!graph) return [];
  const laneCounts = new Map<number, number>();
  return graph.nodes.map((n, i) => {
    const isExec = n.type === 'agent' || n.type === 'decision' || n.type === 'router' || n.type === 'documenter';
    const name = isExec && n.agentNodeKey ? (agentNameMap.get(n.agentNodeKey) ?? n.agentNodeKey)
      : n.type === 'input' ? '输入'
      : n.type === 'router' ? '路由器'
      : n.type === 'project_knowledge' ? '知识库'
      : n.type === 'documenter' ? 'Scribe'
      : '结束';
    const data: NodeData = {
      label: name, kind: n.type,
      ...((n.type === 'agent' || n.type === 'decision') && n.agentNodeKey ? { agentNodeKey: n.agentNodeKey, ...(n.rubricRef ? { rubricRef: n.rubricRef } : {}) } : {}),
      ...((n.type === 'router' || n.type === 'documenter') && n.agentNodeKey ? { agentNodeKey: n.agentNodeKey } : {}),
      ...(n.type === 'router' && n.policyRef ? { policyRef: n.policyRef } : {}),
    };
    // V5 泳道自动布局（无显式 position 时按 lane 分列）
    let pos = n.position;
    if (!pos && graph.schemaVersion === 5) {
      const lane = v5LaneOf(n);
      const idx = laneCounts.get(lane) ?? 0;
      laneCounts.set(lane, idx + 1);
      pos = { x: 40 + lane * 200, y: 80 + idx * 130 };
    }
    const fallback = { x: 320, y: 80 + i * 140 };
    return { id: n.id, type: n.type, position: pos ?? fallback, data, deletable: n.type !== 'input' && n.type !== 'end' } as Node;
  });
}

function toFlowEdges(graph: Graph | null, backIds: Set<string>): FlowEdge[] {
  if (!graph) return [];
  return graph.edges.map((e) => {
    const kind = e.kind ?? (backIds.has(e.id) ? 'rework' : 'forward');
    const isBack = kind === 'rework';
    const isGate = kind === 'gate';
    const isRoute = kind === 'route';
    const isObserve = kind === 'observe';
    const sourceHandle = isBack ? (graph.schemaVersion === 4 ? 'rework-out' : 'back-out') : isGate ? 'gate-out' : isRoute ? 'route-out' : isObserve ? 'observe-out' : 'out';
    const targetHandle = isBack ? 'back-in' : isGate ? 'gate-in' : isObserve ? 'observe-in' : 'in';
    const stroke = isBack ? '#f87171' : isGate ? '#60a5fa' : isRoute ? '#a78bfa' : isObserve ? '#34d399' : '#9aa3ad';
    return {
      id: e.id, source: e.source, target: e.target,
      sourceHandle, targetHandle,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke, strokeDasharray: isBack || isGate || isObserve ? '6 4' : undefined },
      label: isBack ? `返工${e.maxIterations ? `·${e.maxIterations}` : ''}` : isGate ? `Gate ${e.order ?? 1}` : isRoute ? `route${e.lanes?.length ? `·${e.lanes.join(',')}` : ''}` : isObserve ? 'observe' : '',
      labelStyle: { fill: stroke, fontSize: 10 },
      ...(e.maxIterations != null ? { maxIterations: e.maxIterations } : {}),
      ...(e.kind ? { kind: e.kind } : {}), ...(e.order ? { order: e.order } : {}), ...(e.maxRevisions != null ? { maxRevisions: e.maxRevisions } : {}),
      ...(e.onExhausted ? { onExhausted: e.onExhausted } : {}), ...(e.onBlocked ? { onBlocked: e.onBlocked } : {}),
      ...(e.lanes ? { lanes: e.lanes } : {}), ...(e.minRisk ? { minRisk: e.minRisk } : {}),
    } as FlowEdge;
  });
}

export function GraphCanvas() {
  const graph = useGraphRunStore((s) => s.graph);
  const saveGraph = useGraphRunStore((s) => s.saveGraph);
  const saveError = useGraphRunStore((s) => s.saveError);
  const projectId = useGraphRunStore((s) => s.projectId);
  const loadProjectGraph = useGraphRunStore((s) => s.loadProjectGraph);
  const selectedGraphNodeId = useGraphRunStore((s) => s.selectedGraphNodeId);
  const setSelectedGraphNodeId = useGraphRunStore((s) => s.setSelectedGraphNodeId);
  const setSelectedAgentNodeKey = useGraphRunStore((s) => s.setSelectedAgentNodeKey);

  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const agentNameMap = useMemo(() => new Map(agents.map((a) => [a.nodeKey, a.name] as const)), [agents]);
  const [nodes, setNodes, onNodesChange] = useNodesState(toFlowNodes(graph, agentNameMap));
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [picker, setPicker] = useState(false);
  const [selEdge, setSelEdge] = useState<FlowEdge | null>(null);
  const [createForm, setCreateForm] = useState({ provider: '', localId: '', name: '', identity: '', nodeType: 'agent' as 'agent' | 'decision' });
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const dirtyRef = useRef(false);
  const initialViewport = useMemo(() => readViewport(projectId), [projectId]);

  const backIds = useMemo(() => computeBackEdgeIds(nodes, edges), [nodes, edges]);

  // 切画布 / 首次：拉该画布的图（store.loadProjectGraph 按 projectId）
  useEffect(() => {
    void loadProjectGraph();
  }, [projectId, loadProjectGraph]);

  // graph / agentNameMap 变化 → 同步 nodes + edges（带回边样式 + 节点 label）
  // 用函数式更新保留当前 selected：saveGraph 乐观更新会改 graph 引用，若直接覆盖会丢选中
  useEffect(() => {
    const bid = computeBackEdgeIds(graph?.nodes ?? [], (graph?.edges ?? []) as unknown as FlowEdge[]);
    setEdges((prev) => {
      const next = toFlowEdges(graph, bid);
      const sel = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      return next.map((e) => (sel.has(e.id) ? { ...e, selected: true } : e));
    });
    setNodes((prev) => {
      if (!graph) return prev;
      const next = toFlowNodes(graph, agentNameMap);
      const sel = new Set(prev.filter((n) => n.selected).map((n) => n.id));
      return next.map((n) => (sel.has(n.id) ? { ...n, selected: true } : n));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, agentNameMap]);

  // 拉该画布的节点实例列表（供"+加入节点"快速加入已有实例）
  useEffect(() => {
    fetch(`${API_URL}/api/projects/${projectId}/nodes`).then((r) => (r.ok ? r.json() : { nodes: [] })).then((data: { nodes: AgentMeta[] }) => setAgents(Array.isArray(data.nodes) ? data.nodes : [])).catch(() => setAgents([]));
  }, [projectId]);

  // 拉可用 provider 列表（供"+加入节点"创建新实例）
  useEffect(() => {
    fetch(`${API_URL}/api/agents/providers`).then((r) => (r.ok ? r.json() : [])).then((list: ProviderMeta[]) => {
      const arr = Array.isArray(list) ? list : [];
      setProviders(arr);
      setCreateForm((f) => (f.provider ? f : { ...f, provider: arr.find((p) => p.installed !== false)?.id ?? arr[0]?.id ?? '' }));
    }).catch(() => setProviders([]));
  }, []);

  /** 原子创建节点实例 + 加入图（POST /graph/nodes）。失败显示错误，不污染画布。 */
  const createNode = useCallback(async (): Promise<void> => {
    const { provider, localId, name, identity } = createForm;
    if (!provider || !localId.trim()) {
      setCreateErr('provider 和 localId 必填');
      return;
    }
    setCreateErr(null);
    setCreating(true);
    try {
      const graphNodeId = `n${Date.now().toString(36)}`;
      const idx = nodes.length;
      const res = await fetch(`${API_URL}/api/projects/${projectId}/graph/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          localId: localId.trim(),
          name: (name.trim() || localId.trim()),
          ...(identity.trim() ? { identity: identity.trim() } : {}),
          nodeType: createForm.nodeType,
          ...(createForm.nodeType === 'decision' ? { rubricRef: 'rubric.json' } : {}),
          graphNodeId,
          position: { x: 320, y: 80 + idx * 140 },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `创建失败 HTTP ${res.status}`);
      }
      setCreateForm({ provider, localId: '', name: '', identity: '', nodeType: createForm.nodeType });
      setPicker(false);
      await loadProjectGraph(); // 刷新图（含新节点）
    } catch (e) {
      setCreateErr((e as Error).message);
    } finally {
      setCreating(false);
    }
  }, [createForm, nodes.length, projectId, loadProjectGraph]);

  const commit = useCallback((ns: Node[], es: FlowEdge[]) => {
    if (ns.length === 0) return;
    if (!dirtyRef.current) return; // 选中/样式等非结构变更不保存
    dirtyRef.current = false;
    void saveGraph(buildGraph(ns, es, graph));
  }, [saveGraph, graph]);

  useEffect(() => {
    const t = setTimeout(() => commit(nodes, edges), 300);
    return () => clearTimeout(t);
  }, [nodes, edges, commit]);

  const handleConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    setEdges((eds) => {
      // 同向重复（如已有 A→B 又画 A→B）静默忽略，避免落 400 后画布残留坏边
      if (eds.some((e) => e.source === c.source && e.target === c.target)) return eds;
      const kind = graph?.schemaVersion === 4 ? (c.sourceHandle === 'gate-out' ? 'gate' : c.sourceHandle === 'rework-out' ? 'rework' : 'forward') : undefined;
      const gateOrder = kind === 'gate' ? eds.filter((e) => e.source === c.source && e.kind === 'gate').length + 1 : undefined;
      return addEdge<FlowEdge>({ ...c, id: `${c.source}->${c.target}`, markerEnd: { type: MarkerType.ArrowClosed }, ...(kind ? { kind } : {}), ...(gateOrder ? { order: gateOrder, maxRevisions: 1, onExhausted: 'ask_user', onBlocked: 'ask_user' } : {}) }, eds);
    });
    dirtyRef.current = true;
  }, [setEdges, graph?.schemaVersion]);

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
    // 选中来源：ReactFlow n.selected 或 app-state selectedGraphNodeId（兜底，防 click 微拖拽丢选中）
    const isTarget = (n: Node): boolean =>
      (n.selected || n.id === selectedGraphNodeId) &&
      (n.data as unknown as NodeData).kind !== 'input' &&
      (n.data as unknown as NodeData).kind !== 'end';
    setNodes((ns) => ns.filter((n) => !isTarget(n)));
    setEdges((es) => es.filter((e) => !e.selected));
    setSelEdge(null);
    setSelectedGraphNodeId(null);
    setSelectedAgentNodeKey(null);
    dirtyRef.current = true;
  }, [setNodes, setEdges, selectedGraphNodeId, setSelectedGraphNodeId, setSelectedAgentNodeKey]);

  const onEdgeClick = useCallback((_: unknown, edge: Edge) => {
    setSelEdge(edge as FlowEdge);
    setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
    setSelectedGraphNodeId(null); setSelectedAgentNodeKey(null);
  }, [setNodes, setSelectedGraphNodeId, setSelectedAgentNodeKey]);

  const onNodeClick = useCallback((_: unknown, _node: Node) => {
    setEdges((es) => es.map((e) => ({ ...e, selected: false })));
    setSelEdge(null);
  }, [setEdges]);

  const addAgentNode = useCallback((agent: AgentMeta, kind: 'agent' | 'decision' = 'agent') => {
    const id = `n${Date.now().toString(36)}`;
    const data: NodeData = { label: agent.name, kind, agentNodeKey: agent.nodeKey, ...(kind === 'decision' ? { rubricRef: 'rubric.json' } : {}) };
    // 按顺序纵向排列（从上到下），保证左侧 loop handle 可达
    const idx = nodes.length;
    setNodes((ns) => [...ns, { id, type: kind, position: { x: kind === 'decision' ? 600 : 320, y: 80 + idx * 140 }, data, deletable: true } as Node]);
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

  const updateSelectedEdge = useCallback((patch: Partial<FlowEdge>) => {
    if (!selEdge) return;
    setEdges((es) => es.map((e) => e.id === selEdge.id ? { ...e, ...patch } : e));
    setSelEdge((se) => se ? { ...se, ...patch } : se);
    dirtyRef.current = true;
  }, [selEdge, setEdges]);

  const graphNodes = useMemo(() => graph?.nodes ?? [], [graph]);
  const selEdgeIsBack = selEdge ? (graph?.schemaVersion === 4 ? selEdge.kind === 'rework' : backIds.has(selEdge.id)) : false;
  const selEdgeIsGate = graph?.schemaVersion === 4 && selEdge?.kind === 'gate';
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
        <span style={styles.hint}>{graph?.schemaVersion === 4 ? 'Work 底部连接主链；Work 右侧连接 Gate；Decision 左侧连接返工目标。' : '前向边：上节点底部 → 下节点顶部。回边：从下节点左侧 back-out 拖到上节点左侧 back-in。'}</span>
      </div>
      {saveError && <div style={styles.errBanner} title={saveError}>⚠ {saveError}</div>}
      {picker && (
        <div style={styles.picker}>
          {/* 创建新节点实例（原子：建实例+加入图） */}
          <div style={styles.pickerSection}>创建新节点</div>
          <select className='nodrag' style={styles.pickerSelect} value={createForm.provider} onChange={(e) => setCreateForm((f) => ({ ...f, provider: e.target.value }))}>
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={p.installed === false}>{p.name}{p.installed === false ? '（未安装）' : ''}</option>
            ))}
          </select>
          {graph?.schemaVersion === 4 && (
            <select className='nodrag' style={styles.pickerSelect} value={createForm.nodeType} onChange={(e) => setCreateForm((f) => ({ ...f, nodeType: e.target.value as 'agent' | 'decision' }))}>
              <option value='agent'>Work 节点</option><option value='decision'>Decision 审核节点</option>
            </select>
          )}
          <input className='nodrag' style={styles.pickerInput} placeholder='localId（如 coder2，小写英文/数字/_/-）' value={createForm.localId} onChange={(e) => setCreateForm((f) => ({ ...f, localId: e.target.value }))} />
          <input className='nodrag' style={styles.pickerInput} placeholder='显示名（留空用 localId）' value={createForm.name} onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))} />
          <textarea className='nodrag' style={styles.pickerArea} placeholder='identity（可选，留空用默认）' rows={2} value={createForm.identity} onChange={(e) => setCreateForm((f) => ({ ...f, identity: e.target.value }))} />
          {createErr && <div style={styles.pickerErr}>{createErr}</div>}
          <button className='nodrag' style={{ ...styles.btn, opacity: creating ? 0.6 : 1 }} disabled={creating} onClick={() => void createNode()}>{creating ? '创建中…' : '创建并加入图'}</button>

          {/* 已有实例（未在图中）快速加入 */}
          {agents.filter((a) => !graphNodes.some((n) => (n.type === 'agent' || n.type === 'decision') && n.agentNodeKey === a.nodeKey)).length > 0 && (
            <>
              <div style={{ ...styles.pickerSection, marginTop: 6 }}>已有实例（加入图）</div>
              {agents.filter((a) => !graphNodes.some((n) => (n.type === 'agent' || n.type === 'decision') && n.agentNodeKey === a.nodeKey)).map((a) => (
                <div key={a.nodeKey} style={{ display: 'flex', gap: 4 }}>
                  <button style={{ ...styles.agentBtn, flex: 1 }} onClick={() => addAgentNode(a, 'agent')} title={`作为 Work 加入 ${a.nodeKey}`}><strong>{a.provider}</strong> · {a.name}</button>
                  {graph?.schemaVersion === 4 && <button style={styles.agentBtn} onClick={() => addAgentNode(a, 'decision')} title='作为 Decision 加入'>审核</button>}
                </div>
              ))}
            </>
          )}
        </div>
      )}
      {selEdge && (
        <div style={styles.edgePanel}>
          <strong style={{ fontSize: 11 }}>{labelOf(selEdge.source)} → {labelOf(selEdge.target)}</strong>
          <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>id: {selEdge.id}</div>
          <div style={{ fontSize: 10, color: selEdgeIsBack ? 'var(--danger)' : selEdgeIsGate ? '#60a5fa' : 'var(--text-faint)' }}>
            {selEdgeIsBack ? '返工边：审核拒绝后回到对应 Work' : selEdgeIsGate ? `Gate ${selEdge.order ?? 1}：按顺序审核候选产物` : '前向边：将 Work 产物交给下一个 Work'}
          </div>
          {graph?.schemaVersion !== 4 && selEdgeIsBack && (
            <label style={styles.edgeLabel}>maxIterations（空=默认1）
              <input className='nodrag' style={styles.edgeInput} type='number' min={1} value={selEdge.maxIterations ?? ''} onChange={(e) => updateSelectedEdge({ maxIterations: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) })} />
            </label>
          )}
          {selEdgeIsGate && (
            <>
              <label style={styles.edgeLabel}>审核顺序
                <input className='nodrag' style={styles.edgeInput} type='number' min={1} value={selEdge.order ?? 1} onChange={(e) => updateSelectedEdge({ order: Math.max(1, Number(e.target.value)) })} />
              </label>
              <label style={styles.edgeLabel}>最多修订次数
                <input className='nodrag' style={styles.edgeInput} type='number' min={0} max={20} value={selEdge.maxRevisions ?? 1} onChange={(e) => updateSelectedEdge({ maxRevisions: Math.max(0, Math.min(20, Number(e.target.value))) })} />
              </label>
              <label style={styles.edgeLabel}>预算耗尽
                <select className='nodrag' style={styles.edgeInput} value={selEdge.onExhausted ?? 'ask_user'} onChange={(e) => updateSelectedEdge({ onExhausted: e.target.value as 'ask_user' | 'continue_best' | 'fail' })}><option value='ask_user'>暂停询问</option><option value='continue_best'>采用最佳版本</option><option value='fail'>运行失败</option></select>
              </label>
              <label style={styles.edgeLabel}>评估阻塞
                <select className='nodrag' style={styles.edgeInput} value={selEdge.onBlocked ?? 'ask_user'} onChange={(e) => updateSelectedEdge({ onBlocked: e.target.value as 'ask_user' | 'fail' })}><option value='ask_user'>暂停询问</option><option value='fail'>运行失败</option></select>
              </label>
            </>
          )}
        </div>
      )}
      <div style={styles.flow}>
        <ReactFlow
          key={projectId}
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
          fitView={initialViewport == null}
          defaultViewport={initialViewport ?? { x: 0, y: 0, zoom: 1 }}
          onMoveEnd={(_, viewport) => writeViewport(projectId, viewport)}
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

function buildGraph(nodes: Node[], edges: FlowEdge[], current: Graph | null): Graph {
  const graphNodes: GraphNode[] = nodes.map((n) => {
    const data = n.data as unknown as NodeData;
    const base = { id: n.id, position: n.position };
    if (data.kind === 'input') return { ...base, type: 'input' } as GraphNode;
    if (data.kind === 'end') return { ...base, type: 'end' } as GraphNode;
    if (data.kind === 'decision') return { ...base, type: 'decision', agentNodeKey: data.agentNodeKey ?? '', rubricRef: data.rubricRef ?? 'rubric.json' } as GraphNode;
    if (data.kind === 'router') return { ...base, type: 'router', agentNodeKey: data.agentNodeKey ?? '', policyRef: data.policyRef ?? 'router-policy.json' } as GraphNode;
    if (data.kind === 'project_knowledge') return { ...base, type: 'project_knowledge' } as GraphNode;
    if (data.kind === 'documenter') return { ...base, type: 'documenter', agentNodeKey: data.agentNodeKey ?? '' } as GraphNode;
    return { ...base, type: 'agent', agentNodeKey: data.agentNodeKey ?? '' } as GraphNode;
  });
  const sv = current?.schemaVersion ?? 3;
  const v4plus = sv >= 4;
  const graphEdges: GraphEdge[] = edges.map((e) => ({ id: v4plus ? e.id : `${e.source}->${e.target}`, source: e.source, target: e.target, ...(v4plus ? { kind: e.kind ?? 'forward', ...(e.kind === 'gate' ? { order: e.order ?? 1, maxRevisions: e.maxRevisions ?? 1, onExhausted: e.onExhausted ?? 'ask_user', onBlocked: e.onBlocked ?? 'ask_user' } : {}), ...(e.lanes ? { lanes: e.lanes } : {}), ...(e.minRisk ? { minRisk: e.minRisk } : {}) } : e.maxIterations != null ? { maxIterations: e.maxIterations } : {}) }));
  const inputNode = graphNodes.find((n) => n.type === 'input')?.id ?? '__input__';
  const endNode = graphNodes.find((n) => n.type === 'end')?.id;
  return { schemaVersion: sv, inputNode, ...(endNode ? { endNode } : {}), maxNodeExecutions: current?.maxNodeExecutions ?? 50, nodes: graphNodes, edges: graphEdges };
}

const styles: Record<string, CSSProperties> = {
  wrap: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' },
  toolbar: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--border)' },
  btn: { background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 13, cursor: 'pointer' },
  hint: { fontSize: 12, color: 'var(--text-faint)' },
  errBanner: { background: 'var(--bubble-system)', color: 'var(--danger)', fontSize: 12, padding: '6px 12px', borderBottom: '1px solid var(--border)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  picker: { position: 'absolute', top: 44, left: 12, zIndex: 10, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflowY: 'auto', minWidth: 220 },
  pickerEmpty: { color: 'var(--text-faint)', fontSize: 12, padding: 8 },
  pickerSection: { fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginTop: 4 },
  pickerSelect: { background: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 6px', fontSize: 12 },
  pickerInput: { background: 'var(--background)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 6px', fontSize: 12 },
  pickerArea: { width: '100%', resize: 'vertical', background: 'var(--background)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 6px', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' },
  pickerErr: { color: 'var(--danger)', fontSize: 11 },
  agentBtn: { textAlign: 'left', background: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 12, cursor: 'pointer' },
  agentBtnDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  edgePanel: { position: 'absolute', top: 44, right: 12, zIndex: 10, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220 },
  edgeLabel: { display: 'flex', flexDirection: 'column', fontSize: 11, color: 'var(--text-muted)', gap: 4 },
  edgeInput: { background: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: 12 },
  flow: { flex: 1, minHeight: 0 },
  inputNode: { width: 240, background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 },
  inputNodeHead: { fontSize: 12, fontWeight: 700, color: 'var(--text-strong)' },
  inputTextarea: { width: '100%', resize: 'vertical', background: 'var(--background)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' },
  modeSegment: { display: 'grid', gridTemplateColumns: '1fr 1fr', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' },
  modeOption: { minWidth: 0, border: 'none', background: 'var(--background)', color: 'var(--text-muted)', padding: '4px 6px', fontSize: 11, cursor: 'pointer' },
  modeOptionActive: { background: 'var(--accent)', color: 'var(--accent-text)', fontWeight: 700 },
  gatePolicyLabel: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, fontSize: 10, color: 'var(--text-muted)' },
  gatePolicySelect: { minWidth: 0, background: 'var(--background)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 4px', fontSize: 10 },
  inputErr: { color: 'var(--danger)', fontSize: 11 },
  inputBtn: { background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 4, padding: '6px 10px', fontSize: 13, cursor: 'pointer' },
  inputHint: { fontSize: 10, color: 'var(--text-faint)' },
  agentNode: { width: 170, padding: 8, borderRadius: 8, color: '#e6e6e6', cursor: 'default', border: '1px solid var(--border)' },
  decisionNode: { width: 170, padding: 8, borderRadius: 6, color: '#f3e8ff', cursor: 'default', border: '1px solid #a855f7', background: '#31203f' },
  agentHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, gap: 4 },
  badge: { fontSize: 10, background: 'var(--success)', color: '#001', padding: '1px 6px', borderRadius: 8, fontWeight: 700 },
  iterBadge: { fontSize: 9, background: 'var(--accent)', color: '#fff', padding: '1px 5px', borderRadius: 8 },
  agentLabel: { fontSize: 13, fontWeight: 600 },
  loopHandle: { width: 8, height: 8, background: 'var(--danger)', border: '1px solid #fff' },
  endNode: { width: 100, padding: '8px 10px', borderRadius: 8, background: 'var(--surface-raised)', border: '1px solid var(--border)', textAlign: 'center', color: 'var(--text-muted)' },
};
