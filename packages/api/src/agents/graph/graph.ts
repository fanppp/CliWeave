/**
 * Graph 数据模型 + 校验 + 默认图（M4a-simplified：纯方向驱动）
 *
 * - edge = {id, source, target, maxIterations?}（无 when）。
 * - 回边（back-edge）= target 能通过其它边回到 source（成环节点）。回边 = "不满足→回到 target"；前向边 = "满足→继续/结束"。
 * - 决策点 = 有回边出边的节点 → 自动 emit verdict（满意/不满意）。满意→前向边，不满意→回边（maxIterations ?? 3 默认）。
 * - 校验两层：validateGraph（编辑期，input/end 完整约束）+ validateRunnable（运行期，单路径 + 可达；环天然有界不拒）。
 * - v1/v2 读取时归一化为 v3（剥 when/role/promptTemplate）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { getProjectRoot } from '../../utils/project-root.js';
import { DEFAULT_PROJECT_ID, projectGraphFile } from '../project-storage.js';
import { readDecisionRubric } from './evaluation.js';

const GraphNodeIdSchema = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/, 'invalid graph node id');
const EdgeIdSchema = z.string().min(1, 'edge id required');
const AgentNodeKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9_-]*$/, 'invalid agent nodeKey (expected provider:localId)');
const PositionSchema = z.object({ x: z.number(), y: z.number() });

// ── v3 schema ──────────────────────────────────────────────
const V3InputNodeSchema = z.object({ id: GraphNodeIdSchema, type: z.literal('input'), position: PositionSchema.optional() }).strict();
const V3AgentNodeSchema = z.object({
  id: GraphNodeIdSchema,
  type: z.literal('agent'),
  agentNodeKey: AgentNodeKeySchema,
  position: PositionSchema.optional(),
}).strict();
const V3EndNodeSchema = z.object({ id: GraphNodeIdSchema, type: z.literal('end'), position: PositionSchema.optional() }).strict();
export const V3NodeSchema = z.discriminatedUnion('type', [V3InputNodeSchema, V3AgentNodeSchema, V3EndNodeSchema]);

export const V3EdgeSchema = z.object({
  id: EdgeIdSchema,
  source: GraphNodeIdSchema,
  target: GraphNodeIdSchema,
  maxIterations: z.number().int().min(1).optional(),
}).strict();

export const GraphV3Schema = z.object({
  schemaVersion: z.literal(3),
  inputNode: GraphNodeIdSchema,
  endNode: GraphNodeIdSchema.optional(),
  maxNodeExecutions: z.number().int().min(1).max(1000).default(50),
  nodes: z.array(V3NodeSchema).min(1),
  edges: z.array(V3EdgeSchema),
}).strict();

export type GraphV3 = z.infer<typeof GraphV3Schema>;
export type GraphV3Node = z.infer<typeof V3NodeSchema>;
export type GraphV3Edge = z.infer<typeof V3EdgeSchema>;

// ── v4 schema：Evaluator-Optimizer + 有序多 gate ──────────────
const V4InputNodeSchema = V3InputNodeSchema;
const V4AgentNodeSchema = V3AgentNodeSchema;
const V4DecisionNodeSchema = z.object({
  id: GraphNodeIdSchema,
  type: z.literal('decision'),
  agentNodeKey: AgentNodeKeySchema,
  rubricRef: z.string().regex(/^[a-zA-Z0-9._/-]+$/, 'invalid rubricRef'),
  position: PositionSchema.optional(),
}).strict();
const V4EndNodeSchema = V3EndNodeSchema;
export const V4NodeSchema = z.discriminatedUnion('type', [V4InputNodeSchema, V4AgentNodeSchema, V4DecisionNodeSchema, V4EndNodeSchema]);
const ExhaustedPolicySchema = z.enum(['ask_user', 'continue_best', 'fail']);
const BlockedPolicySchema = z.enum(['ask_user', 'fail']);
const V4ForwardEdgeSchema = z.object({ id: EdgeIdSchema, source: GraphNodeIdSchema, target: GraphNodeIdSchema, kind: z.literal('forward') }).strict();
const V4GateEdgeSchema = z.object({
  id: EdgeIdSchema, source: GraphNodeIdSchema, target: GraphNodeIdSchema, kind: z.literal('gate'),
  order: z.number().int().min(1),
  maxRevisions: z.number().int().min(0).max(20).default(1),
  onExhausted: ExhaustedPolicySchema.default('ask_user'),
  onBlocked: BlockedPolicySchema.default('ask_user'),
}).strict();
const V4ReworkEdgeSchema = z.object({ id: EdgeIdSchema, source: GraphNodeIdSchema, target: GraphNodeIdSchema, kind: z.literal('rework') }).strict();
export const V4EdgeSchema = z.discriminatedUnion('kind', [V4ForwardEdgeSchema, V4GateEdgeSchema, V4ReworkEdgeSchema]);
export const GraphV4Schema = z.object({
  schemaVersion: z.literal(4), inputNode: GraphNodeIdSchema, endNode: GraphNodeIdSchema.optional(),
  maxNodeExecutions: z.number().int().min(1).max(1000).default(50),
  nodes: z.array(V4NodeSchema).min(1), edges: z.array(V4EdgeSchema),
}).strict();
export type GraphV4 = z.infer<typeof GraphV4Schema>;

// ── v5 schema：Router + ProjectKnowledge + Documenter + 多通道路由 ──────────────
export const RouteLaneSchema = z.enum([
  'direct_answer', 'investigate', 'plan_only', 'small_change', 'planned_change',
  'review_only', 'verify_only', 'clarify', 'unsupported',
]);
export type RouteLane = z.infer<typeof RouteLaneSchema>;
export const RiskSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type Risk = z.infer<typeof RiskSchema>;

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export function riskRank(risk: Risk): number { return RISK_RANK[risk]; }

/**
 * V5 边活跃判定（forward/gate 共用；resolveLanePlan / validateV5Runnable / walkLane 共享）。
 * - 无 lanes（或空）→ 对所有 lane 活跃。
 * - 有 lanes → 须包含当前 lane。
 * - 有 minRisk 且传入 risk → 当前 risk 须达到阈值（planned_change+medium<high 跳过 Security；high/critical 必经）。
 * - 有 minRisk 但未传 risk（结构校验）→ 忽略 minRisk，只按 lane 判定（gate 不影响 forward 链可达性）。
 */
export function isEdgeActive(edge: { lanes?: RouteLane[]; minRisk?: Risk }, lane: RouteLane, risk?: Risk): boolean {
  if (edge.lanes && edge.lanes.length > 0 && !edge.lanes.includes(lane)) return false;
  if (edge.minRisk && risk && riskRank(risk) < riskRank(edge.minRisk)) return false;
  return true;
}

const V5InputNodeSchema = V3InputNodeSchema;
const V5RouterNodeSchema = z.object({
  id: GraphNodeIdSchema, type: z.literal('router'), agentNodeKey: AgentNodeKeySchema,
  policyRef: z.string().regex(/^[a-zA-Z0-9._/-]+$/, 'invalid policyRef').default('router-policy.json'),
  position: PositionSchema.optional(),
}).strict();
const V5AgentNodeSchema = V3AgentNodeSchema;
const V5DecisionNodeSchema = V4DecisionNodeSchema;
const V5ProjectKnowledgeNodeSchema = z.object({ id: GraphNodeIdSchema, type: z.literal('project_knowledge'), position: PositionSchema.optional() }).strict();
const V5DocumenterNodeSchema = z.object({ id: GraphNodeIdSchema, type: z.literal('documenter'), agentNodeKey: AgentNodeKeySchema, position: PositionSchema.optional() }).strict();
const V5EndNodeSchema = V3EndNodeSchema;
export const V5NodeSchema = z.discriminatedUnion('type', [
  V5InputNodeSchema, V5RouterNodeSchema, V5AgentNodeSchema, V5DecisionNodeSchema,
  V5ProjectKnowledgeNodeSchema, V5DocumenterNodeSchema, V5EndNodeSchema,
]);
const V5ForwardEdgeSchema = z.object({ id: EdgeIdSchema, source: GraphNodeIdSchema, target: GraphNodeIdSchema, kind: z.literal('forward'), lanes: z.array(RouteLaneSchema).optional(), minRisk: RiskSchema.optional() }).strict();
const V5GateEdgeSchema = z.object({
  id: EdgeIdSchema, source: GraphNodeIdSchema, target: GraphNodeIdSchema, kind: z.literal('gate'),
  order: z.number().int().min(1), maxRevisions: z.number().int().min(0).max(20).default(1),
  onExhausted: ExhaustedPolicySchema.default('ask_user'), onBlocked: BlockedPolicySchema.default('ask_user'),
  lanes: z.array(RouteLaneSchema).optional(), minRisk: RiskSchema.optional(),
}).strict();
const V5ReworkEdgeSchema = z.object({ id: EdgeIdSchema, source: GraphNodeIdSchema, target: GraphNodeIdSchema, kind: z.literal('rework') }).strict();
const V5RouteEdgeSchema = z.object({ id: EdgeIdSchema, source: GraphNodeIdSchema, target: GraphNodeIdSchema, kind: z.literal('route'), lanes: z.array(RouteLaneSchema).min(1) }).strict();
const V5ObserveEdgeSchema = z.object({ id: EdgeIdSchema, source: GraphNodeIdSchema, target: GraphNodeIdSchema, kind: z.literal('observe') }).strict();
export const V5EdgeSchema = z.discriminatedUnion('kind', [V5ForwardEdgeSchema, V5GateEdgeSchema, V5ReworkEdgeSchema, V5RouteEdgeSchema, V5ObserveEdgeSchema]);
export const GraphV5Schema = z.object({
  schemaVersion: z.literal(5), inputNode: GraphNodeIdSchema, endNode: GraphNodeIdSchema.optional(),
  maxNodeExecutions: z.number().int().min(1).max(1000).default(50),
  nodes: z.array(V5NodeSchema).min(1), edges: z.array(V5EdgeSchema),
}).strict();
export type GraphV5 = z.infer<typeof GraphV5Schema>;
export type GraphV5Node = z.infer<typeof V5NodeSchema>;
export type GraphV5Edge = z.infer<typeof V5EdgeSchema>;

export const GraphSchema = z.discriminatedUnion('schemaVersion', [GraphV3Schema, GraphV4Schema, GraphV5Schema]);

/** Graph/GraphNode/GraphEdge 保留 V3 别名，避免 legacy runner 和外部测试被联合类型污染。 */
export type Graph = GraphV3;
export type GraphNode = GraphV3Node;
export type GraphEdge = GraphV3Edge;
export type GraphAgentNode = Extract<GraphNode, { type: 'agent' }>;
export type AnyGraph = GraphV3 | GraphV4 | GraphV5;
export type AnyGraphNode = AnyGraph['nodes'][number];
export type AnyGraphAgentNode = Extract<AnyGraphNode, { type: 'agent' | 'decision' | 'router' | 'documenter' }>;
export type ExhaustedPolicy = z.infer<typeof ExhaustedPolicySchema>;

/** 默认最大覆盖次数（回边未配 maxIterations 时用）= 该回边最多被遍历几次。 */
export const DEFAULT_BACK_EDGE_MAX_ITER = 1;

// ── v1/v2 schema（仅用于读取旧图并归一化为 v3）────────────
const V1NodeSchema = z.discriminatedUnion('type', [
  z.object({ id: GraphNodeIdSchema, type: z.literal('input'), position: PositionSchema.optional() }),
  z.object({ id: GraphNodeIdSchema, type: z.literal('agent'), agentNodeKey: AgentNodeKeySchema, position: PositionSchema.optional() }),
]);
const V1EdgeSchema = z.object({ source: GraphNodeIdSchema, target: GraphNodeIdSchema });
const GraphV1Schema = z.object({ schemaVersion: z.literal(1), inputNode: GraphNodeIdSchema, nodes: z.array(V1NodeSchema).min(1), edges: z.array(V1EdgeSchema) });

// v2：边带 when，节点带 role/promptTemplate（读取时剥掉）
const V2NodeSchema = z.discriminatedUnion('type', [
  z.object({ id: GraphNodeIdSchema, type: z.literal('input'), position: PositionSchema.optional() }),
  z.object({ id: GraphNodeIdSchema, type: z.literal('agent'), agentNodeKey: AgentNodeKeySchema, position: PositionSchema.optional(), role: z.string().optional(), promptTemplate: z.string().optional() }),
  z.object({ id: GraphNodeIdSchema, type: z.literal('end'), position: PositionSchema.optional() }),
]);
const V2EdgeSchema = z.object({ id: EdgeIdSchema, source: GraphNodeIdSchema, target: GraphNodeIdSchema, when: z.string().optional(), maxIterations: z.number().int().min(1).optional() });
const GraphV2Schema = z.object({ schemaVersion: z.literal(2), inputNode: GraphNodeIdSchema, endNode: GraphNodeIdSchema.optional(), maxNodeExecutions: z.number().int().min(1).max(1000).optional(), nodes: z.array(V2NodeSchema).min(1), edges: z.array(V2EdgeSchema) });

type GraphV1 = z.infer<typeof GraphV1Schema>;
type GraphV2 = z.infer<typeof GraphV2Schema>;

function normalizeV1ToV3(v1: GraphV1): GraphV3 {
  return {
    schemaVersion: 3,
    inputNode: v1.inputNode,
    nodes: v1.nodes.map((n) => (n.type === 'agent' ? { id: n.id, type: 'agent', agentNodeKey: n.agentNodeKey, ...(n.position ? { position: n.position } : {}) } : { id: n.id, type: 'input', ...(n.position ? { position: n.position } : {}) })) as GraphV3Node[],
    edges: v1.edges.map((e) => ({ id: `${e.source}->${e.target}`, source: e.source, target: e.target })) as GraphV3Edge[],
    maxNodeExecutions: 50,
  };
}

function normalizeV2ToV3(v2: GraphV2): GraphV3 {
  return {
    schemaVersion: 3,
    inputNode: v2.inputNode,
    maxNodeExecutions: v2.maxNodeExecutions ?? 50,
    ...(v2.endNode ? { endNode: v2.endNode } : {}),
    nodes: v2.nodes.map((n) => {
      const base = { id: n.id, ...(n.position ? { position: n.position } : {}) };
      if (n.type === 'agent') return { ...base, type: 'agent', agentNodeKey: n.agentNodeKey } as GraphV3Node;
      if (n.type === 'end') return { ...base, type: 'end' } as GraphV3Node;
      return { ...base, type: 'input' } as GraphV3Node;
    }),
    edges: v2.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, ...(e.maxIterations != null ? { maxIterations: e.maxIterations } : {}) }) as GraphV3Edge),
  };
}

/** M1 硬编码默认图（v3）：__input__ → codex → claude，无 end（自然结束）。 */
export function getDefaultGraph(): GraphV3 {
  return {
    schemaVersion: 3,
    inputNode: '__input__',
    maxNodeExecutions: 50,
    nodes: [
      { id: '__input__', type: 'input' },
      { id: 'n1', type: 'agent', agentNodeKey: 'codex:codex-node' },
      { id: 'n2', type: 'agent', agentNodeKey: 'claude:claude-node' },
    ],
    edges: [
      { id: 'e1', source: '__input__', target: 'n1' },
      { id: 'e2', source: 'n1', target: 'n2' },
    ],
  };
}

function graphFile(): string {
  return join(getProjectRoot(), 'agents', 'graph.json');
}

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(`Graph validation failed: ${message}`);
    this.name = 'GraphValidationError';
  }
}

/** 解析 + 归一化为 v3。 */
function parseAndNormalize(raw: unknown): AnyGraph {
  if (typeof raw !== 'object' || raw === null) throw new GraphValidationError('graph.json is not an object');
  const sv = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (sv === 1) return normalizeV1ToV3(GraphV1Schema.parse(raw));
  if (sv === 2) return normalizeV2ToV3(GraphV2Schema.parse(raw));
  if (sv === 3) return GraphV3Schema.parse(raw);
  if (sv === 4) return GraphV4Schema.parse(raw);
  if (sv === 5) return GraphV5Schema.parse(raw);
  throw new GraphValidationError(`unsupported schemaVersion: ${String(sv)}`);
}

/**
 * 回边预计算（DFS 三色）：访问 source 时若 target 仍在递归栈上(visiting) → 回边。
 * 这是标准 back-edge 检测，避免"t 能否经其它边到 s"的误判（环里两向边都会被误判）。
 * 回边 = "不满足→回到 target"；前向边 = "满足→继续"。
 */
export function computeBackEdges(graph: GraphV3): Set<string> {
  const back = new Set<string>();
  const adj = new Map<string, GraphV3Edge[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) adj.get(e.source)!.push(e);
  const color = new Map<string, number>(); // 0 unvisited 1 visiting(on stack) 2 done
  for (const n of graph.nodes) color.set(n.id, 0);
  const dfs = (id: string): void => {
    color.set(id, 1);
    for (const e of adj.get(id) ?? []) {
      const c = color.get(e.target) ?? 0;
      if (c === 1) back.add(e.id); // target 在栈上 → 回边
      else if (c === 0) dfs(e.target); // 树边，继续
      // c===2：前向/交叉边，非回边
    }
    color.set(id, 2);
  };
  dfs(graph.inputNode);
  // 兜底：从 input 不可达的孤立子图也跑 DFS（编辑态可能有）
  for (const n of graph.nodes) if (color.get(n.id) === 0) dfs(n.id);
  return back;
}

/**
 * 基础结构校验（PUT 编辑持久化时）。
 * 唯一 id / agentNodeKey 唯一 / 边引用合法 / 无自环 / 无重边 / input 入度 0 + 0..1 出边 / end 0/1 + 出度 0 / endNode↔type:end。
 */
export function validateGraph(graph: AnyGraph): void {
  const nodeIds = new Set<string>();
  const agentNodeKeys = new Set<string>();
  for (const n of graph.nodes) {
    if (nodeIds.has(n.id)) throw new GraphValidationError(`duplicate node id: ${n.id}`);
    nodeIds.add(n.id);
    if (n.type === 'agent' || n.type === 'decision') {
      if (agentNodeKeys.has(n.agentNodeKey)) throw new GraphValidationError(`duplicate agentNodeKey: ${n.agentNodeKey} (multi-instance isolation is M4)`);
      agentNodeKeys.add(n.agentNodeKey);
    }
  }

  const inputNodes = graph.nodes.filter((n) => n.type === 'input');
  if (inputNodes.length !== 1) throw new GraphValidationError(`expected exactly one input node, got ${inputNodes.length}`);
  if (graph.inputNode !== inputNodes[0].id) throw new GraphValidationError(`inputNode '${graph.inputNode}' is not the input node`);

  const endNodes = graph.nodes.filter((n) => n.type === 'end');
  if (endNodes.length > 1) throw new GraphValidationError(`at most one end node, got ${endNodes.length}`);
  if (endNodes.length === 1) {
    if (!graph.endNode) throw new GraphValidationError('end node exists but endNode not set');
    if (graph.endNode !== endNodes[0].id) throw new GraphValidationError(`endNode '${graph.endNode}' is not the end node`);
  } else if (graph.endNode) {
    throw new GraphValidationError(`endNode '${graph.endNode}' set but no type:'end' node exists`);
  }

  const edgeIds = new Set<string>();
  const edgePairs = new Set<string>();
  for (const e of graph.edges) {
    if (!nodeIds.has(e.source)) throw new GraphValidationError(`edge source not found: ${e.source}`);
    if (!nodeIds.has(e.target)) throw new GraphValidationError(`edge target not found: ${e.target}`);
    if (e.source === e.target) throw new GraphValidationError(`self-loop not allowed: ${e.source}`);
    if (edgeIds.has(e.id)) throw new GraphValidationError(`duplicate edge id: ${e.id}`);
    edgeIds.add(e.id);
    const pair = `${e.source}->${e.target}`;
    if (edgePairs.has(pair)) throw new GraphValidationError(`duplicate edge: ${pair}`);
    edgePairs.add(pair);
    if (graph.endNode && e.source === graph.endNode) throw new GraphValidationError(`end node '${e.source}' must have out-degree 0`);
  }

  const inputIn = graph.edges.filter((e) => e.target === graph.inputNode);
  if (inputIn.length > 0) throw new GraphValidationError(`input node must have in-degree 0, got ${inputIn.length}`);
  // input 出边数量编辑期不限（可扇出多条前向 → 并行多个首层分支）

  if (graph.schemaVersion === 4) validateV4Topology(graph);
  else if (graph.schemaVersion === 5) validateV5Topology(graph);
}

function validateV4Topology(graph: GraphV4): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  for (const edge of graph.edges) {
    const source = byId.get(edge.source)!;
    const target = byId.get(edge.target)!;
    if (edge.kind === 'forward') {
      if (source.type === 'decision') throw new GraphValidationError(`decision '${source.id}' cannot own forward edge`);
      if (target.type === 'decision') throw new GraphValidationError(`forward edge cannot target decision '${target.id}'`);
    } else if (edge.kind === 'gate') {
      if (source.type !== 'agent' || target.type !== 'decision') throw new GraphValidationError(`gate '${edge.id}' must be agent -> decision`);
    } else if (source.type !== 'decision' || target.type !== 'agent') {
      throw new GraphValidationError(`rework '${edge.id}' must be decision -> agent`);
    }
  }
  for (const node of graph.nodes) {
    if (node.type === 'agent') {
      const forward = graph.edges.filter((e) => e.kind === 'forward' && e.source === node.id);
      if (forward.length > 1) throw new GraphValidationError(`work '${node.id}' has more than one forward edge`);
      const gates = graph.edges.filter((e): e is Extract<GraphV4['edges'][number], { kind: 'gate' }> => e.kind === 'gate' && e.source === node.id);
      const orders = new Set(gates.map((e) => e.order));
      if (orders.size !== gates.length) throw new GraphValidationError(`work '${node.id}' has duplicate gate order`);
      const sorted = [...orders].sort((a, b) => a - b);
      if (sorted.some((v, i) => v !== i + 1)) throw new GraphValidationError(`work '${node.id}' gate order must be contiguous from 1`);
    }
    if (node.type === 'decision') {
      const gateIn = graph.edges.filter((e) => e.kind === 'gate' && e.target === node.id);
      const reworkOut = graph.edges.filter((e) => e.kind === 'rework' && e.source === node.id);
      if (gateIn.length !== 1 || reworkOut.length !== 1) throw new GraphValidationError(`decision '${node.id}' requires exactly one gate in and one rework out`);
      if (reworkOut[0]?.target !== gateIn[0]?.source) throw new GraphValidationError(`decision '${node.id}' must rework its gated work`);
    }
  }
}

/**
 * 可运行性校验（POST /run/start 前）。
 * input ≥1 前向出边（可扇出并行多个首层）；所有 agent 从 input 可达；end 可达；单路径（agent 每节点 ≤1 前向 + ≤1 回边出边）。
 * 环天然有界（回边默认 maxIter + 全局 maxNodeExecutions），不拒环。
 */
export function validateRunnable(graph: AnyGraph): void {
  if (graph.schemaVersion === 4) {
    validateV4Runnable(graph);
    return;
  }
  if (graph.schemaVersion === 5) {
    validateV5Runnable(graph);
    return;
  }
  const backEdges = computeBackEdges(graph);
  const isBack = (e: GraphEdge): boolean => backEdges.has(e.id);

  const inputOut = graph.edges.filter((e) => e.source === graph.inputNode);
  if (inputOut.length < 1) throw new GraphValidationError(`input node must have at least one out-edge to run, got ${inputOut.length}`);
  for (const e of inputOut) {
    if (isBack(e)) throw new GraphValidationError(`input out-edge cannot be a back-edge: ${e.id}`);
  }

  // 单路径：每节点 ≤1 前向出边 + ≤1 回边出边
  for (const n of graph.nodes) {
    if (n.type !== 'agent') continue;
    const outs = graph.edges.filter((e) => e.source === n.id);
    const forward = outs.filter((e) => !isBack(e));
    const back = outs.filter((e) => isBack(e));
    if (forward.length > 1) throw new GraphValidationError(`node '${n.id}' has ${forward.length} forward out-edges (single-path: ≤1)`);
    if (back.length > 1) throw new GraphValidationError(`node '${n.id}' has ${back.length} back out-edges (single-path: ≤1)`);
  }

  // 所有 agent + end 从 input 可达（结构可达，忽略方向）
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) adj.get(e.source)!.push(e.target);
  const reachable = new Set<string>([graph.inputNode]);
  const queue = [graph.inputNode];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  for (const n of graph.nodes) {
    if (n.type === 'agent' && !reachable.has(n.id)) throw new GraphValidationError(`agent node '${n.id}' is not reachable from input`);
  }
  if (graph.endNode && !reachable.has(graph.endNode)) throw new GraphValidationError(`end node '${graph.endNode}' is not reachable from input`);
}

function validateV4Runnable(graph: GraphV4): void {
  const forward = graph.edges.filter((e) => e.kind === 'forward');
  const inputForward = forward.filter((e) => e.source === graph.inputNode);
  if (inputForward.length !== 1) throw new GraphValidationError(`V4 currently requires exactly one input forward branch, got ${inputForward.length}`);
  const reachable = new Set<string>([graph.inputNode]);
  const queue = [graph.inputNode];
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of forward.filter((e) => e.source === current)) if (!reachable.has(edge.target)) { reachable.add(edge.target); queue.push(edge.target); }
  }
  for (const node of graph.nodes) {
    if ((node.type === 'agent' || node.type === 'end') && !reachable.has(node.id)) throw new GraphValidationError(`main-chain node '${node.id}' is not forward-reachable`);
    if (node.type === 'decision') {
      const source = graph.edges.find((e) => e.kind === 'gate' && e.target === node.id)?.source;
      if (!source || !reachable.has(source)) throw new GraphValidationError(`decision '${node.id}' gate source is not reachable`);
    }
  }
}

/**
 * V5 拓扑校验（编辑期）：
 * - Input 唯一且只 forward 连 Router；Router 唯一且不得拥有 gate/rework。
 * - 每个 lane 只映射到一个 route 入口。
 * - Knowledge/Documenter 仅 observe，不进主 payload 路径（forward/gate/rework 不涉及它们）。
 * - route: router→agent；observe: project_knowledge→documenter。
 * - work forward ≤1；gate order 连续；decision gate-in/rework-out 一致（同 V4）。
 */
function validateV5Topology(graph: GraphV5): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const routers = graph.nodes.filter((n) => n.type === 'router');
  if (routers.length !== 1) throw new GraphValidationError(`V5 expects exactly one router node, got ${routers.length}`);
  const router = routers[0];
  const inputOuts = graph.edges.filter((e) => e.source === graph.inputNode);
  if (inputOuts.length !== 1 || inputOuts[0].target !== router.id || inputOuts[0].kind !== 'forward') {
    throw new GraphValidationError(`input must connect only to the router '${router.id}' via a forward edge`);
  }
  const routerOuts = graph.edges.filter((e) => e.source === router.id);
  if (routerOuts.some((e) => e.kind === 'gate' || e.kind === 'rework')) throw new GraphValidationError(`router '${router.id}' must not own gate/rework edges`);
  const laneToEntry = new Map<RouteLane, string>();
  for (const e of routerOuts) {
    if (e.kind !== 'route') continue;
    for (const lane of e.lanes) {
      if (laneToEntry.has(lane)) throw new GraphValidationError(`lane '${lane}' maps to multiple route entries`);
      laneToEntry.set(lane, e.target);
    }
  }
  for (const e of graph.edges) {
    const s = byId.get(e.source), t = byId.get(e.target);
    if (e.kind === 'observe') {
      if (s?.type !== 'project_knowledge') throw new GraphValidationError(`observe '${e.id}' source must be project_knowledge`);
      if (t?.type !== 'documenter') throw new GraphValidationError(`observe '${e.id}' target must be documenter`);
      continue;
    }
    if (e.kind === 'route') {
      if (s?.type !== 'router') throw new GraphValidationError(`route '${e.id}' source must be router`);
      if (t?.type !== 'agent') throw new GraphValidationError(`route '${e.id}' target must be an agent (lane entry)`);
      continue;
    }
    // forward/gate/rework：source 不得是 router/knowledge/documenter；target 不得是 knowledge/documenter；
    // target=router 仅允许 input→router 这一条 forward。
    if (s && (s.type === 'router' || s.type === 'project_knowledge' || s.type === 'documenter')) {
      throw new GraphValidationError(`edge '${e.id}' source must not be ${s.type} node`);
    }
    if (t && (t.type === 'project_knowledge' || t.type === 'documenter')) {
      throw new GraphValidationError(`edge '${e.id}' target must not be ${t.type} node`);
    }
    if (t && t.type === 'router' && !(e.kind === 'forward' && e.source === graph.inputNode)) {
      throw new GraphValidationError(`edge '${e.id}' must not target router (except the input→router forward)`);
    }
    if (e.kind === 'forward') {
      if (s?.type === 'decision') throw new GraphValidationError(`decision '${s.id}' cannot own forward edge`);
      if (t?.type === 'decision') throw new GraphValidationError(`forward edge cannot target decision '${t.id}'`);
    } else if (e.kind === 'gate') {
      if (s?.type !== 'agent' || t?.type !== 'decision') throw new GraphValidationError(`gate '${e.id}' must be agent -> decision`);
    } else { // rework
      if (s?.type !== 'decision' || t?.type !== 'agent') throw new GraphValidationError(`rework '${e.id}' must be decision -> agent`);
    }
  }
  for (const node of graph.nodes) {
    if (node.type === 'agent') {
      // V5: 同一 lane 下每 work 最多一个有效 forward（无 lanes 视为永远活跃，不与其它 forward 共存）。
      const forward = graph.edges.filter((e): e is Extract<GraphV5['edges'][number], { kind: 'forward' }> => e.kind === 'forward' && e.source === node.id);
      const alwaysOn = forward.filter((e) => !e.lanes || e.lanes.length === 0);
      if (alwaysOn.length > 1) throw new GraphValidationError(`work '${node.id}' has more than one always-on forward edge`);
      if (alwaysOn.length === 1 && forward.length > 1) throw new GraphValidationError(`work '${node.id}' always-on forward cannot coexist with lane-scoped forwards`);
      const laneFwd = new Set<RouteLane>();
      for (const f of forward) for (const lane of f.lanes ?? []) {
        if (laneFwd.has(lane)) throw new GraphValidationError(`lane '${lane}' has multiple forward edges from work '${node.id}'`);
        laneFwd.add(lane);
      }
      const gates = graph.edges.filter((e): e is Extract<GraphV5['edges'][number], { kind: 'gate' }> => e.kind === 'gate' && e.source === node.id);
      const orders = new Set(gates.map((e) => e.order));
      if (orders.size !== gates.length) throw new GraphValidationError(`work '${node.id}' has duplicate gate order`);
      const sorted = [...orders].sort((a, b) => a - b);
      if (sorted.some((v, i) => v !== i + 1)) throw new GraphValidationError(`work '${node.id}' gate order must be contiguous from 1`);
    }
    if (node.type === 'decision') {
      const gateIn = graph.edges.filter((e) => e.kind === 'gate' && e.target === node.id);
      const reworkOut = graph.edges.filter((e) => e.kind === 'rework' && e.source === node.id);
      if (gateIn.length !== 1 || reworkOut.length !== 1) throw new GraphValidationError(`decision '${node.id}' requires exactly one gate in and one rework out`);
      if (reworkOut[0]?.target !== gateIn[0]?.source) throw new GraphValidationError(`decision '${node.id}' must rework its gated work`);
    }
  }
}

/**
 * V5 可运行性校验：router 有 route 边；每个非 clarify/unsupported lane 经 forward 链确定性到达 End。
 * forward 无 lanes 永远活跃；带 lanes 的仅对匹配 lane 活跃（同一 lane 下每 work 最多一有效 forward）。
 */
function validateV5Runnable(graph: GraphV5): void {
  const routers = graph.nodes.filter((n) => n.type === 'router');
  const router = routers[0];
  const routeEdges = graph.edges.filter((e): e is Extract<GraphV5['edges'][number], { kind: 'route' }> => e.kind === 'route' && e.source === router.id);
  if (routeEdges.length === 0) throw new GraphValidationError(`V5 router has no route edges`);
  const forward = graph.edges.filter((e) => e.kind === 'forward');
  for (const re of routeEdges) {
    for (const lane of re.lanes) {
      if (lane === 'clarify' || lane === 'unsupported') continue;
      let cur: string | undefined = re.target;
      const seen = new Set<string>();
      let reachedEnd = false;
      while (cur) {
        if (seen.has(cur)) break;
        seen.add(cur);
        const node = graph.nodes.find((n) => n.id === cur);
        if (node?.type === 'end') { reachedEnd = true; break; }
        const next = forward.find((e) => e.source === cur && isEdgeActive(e, lane));
        cur = next?.target;
      }
      if (!reachedEnd) throw new GraphValidationError(`lane '${lane}' does not deterministically reach End`);
    }
  }
}

/** 新画布默认图（仅 input 节点，待用户加 agent/end）。 */
export function getDefaultProjectGraph(): GraphV3 {
  return {
    schemaVersion: 3,
    inputNode: '__input__',
    maxNodeExecutions: 50,
    nodes: [{ id: '__input__', type: 'input' }],
    edges: [],
  };
}

/** 解析+归一化+校验一个 graph 原始对象（边 id 归一化为 source->target）。 */
function parseGraphRaw(raw: unknown): AnyGraph {
  let graph: AnyGraph;
  try {
    graph = parseAndNormalize(raw);
  } catch (err) {
    if (err instanceof z.ZodError) throw new GraphValidationError(`schema error: ${err.message}`);
    throw err;
  }
  if (graph.schemaVersion === 3) graph = { ...graph, edges: graph.edges.map((e) => ({ ...e, id: `${e.source}->${e.target}` })) };
  validateGraph(graph);
  return graph;
}

function readGraphFile(file: string, fallbackDefault: AnyGraph | null): AnyGraph {
  if (!existsSync(file)) {
    if (fallbackDefault) return fallbackDefault;
    throw new GraphValidationError(`graph file not found: ${file}`);
  }
  const text = readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''); // 去 UTF-8 BOM
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new GraphValidationError(`graph.json is not valid JSON: ${(err as Error).message}`);
  }
  return parseGraphRaw(raw);
}

/** 读取画布图（强制 projectId）。文件缺失 → 返回新画布默认图（仅 input）。 */
export function readProjectGraph(projectId: string): AnyGraph {
  return readGraphFile(projectGraphFile(projectId), getDefaultProjectGraph());
}

/**
 * PUT 编辑不得降级 schema：V5→V4/V3、V4→V3 均拒（"只能经显式迁移/回滚服务改变 schema"）。
 * 升级（V3→V4/V5、V4→V5）当前仍允许经 PUT；#13 迁移服务落地后改为仅同版本编辑，升级走迁移服务。
 */
export function assertNoSchemaDowngrade(existingVersion: number, newVersion: number): void {
  if (newVersion < existingVersion) {
    throw new GraphValidationError(`refusing to downgrade graph from V${existingVersion} to V${newVersion} (use the explicit migration wizard)`);
  }
}

/** 原子写入画布图（强制 projectId）。拒绝降级（V5→V4/V3、V4→V3；须用显式迁移向导）。 */
export function writeProjectGraph(projectId: string, graph: AnyGraph): void {
  const parsed = GraphSchema.parse(graph);
  validateGraph(parsed);
  const file = projectGraphFile(projectId);
  const existing = existsSync(file) ? parseGraphRaw(JSON.parse(readFileSync(file, 'utf-8').replace(/^\uFEFF/, '') ?? '{}')) : null;
  if (existing) assertNoSchemaDowngrade(existing.schemaVersion, parsed.schemaVersion);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
  renameSync(tmp, file);
}

/**
 * 运行态校验（含需要 projectId 上下文的检查，如 M6 frozen 缓存）。
 * M5：仅做结构 validateRunnable；M6 在此加 frozen 节点缓存检查。
 */
export function validateProjectRun(projectId: string, graph: AnyGraph): void {
  validateRunnable(graph);
  if (graph.schemaVersion === 4 || graph.schemaVersion === 5) {
    for (const node of graph.nodes) if (node.type === 'decision') readDecisionRubric(projectId, node);
  }
  // M6: frozen 节点 .last-output.json 缓存检查（决策节点须含 verdict）
}

// ── legacy wrappers（default 项目别名，供 /api/graph* 过渡）────────────
/** @deprecated 用 readProjectGraph(DEFAULT_PROJECT_ID) */
export function readGraph(): AnyGraph {
  return readProjectGraph(DEFAULT_PROJECT_ID);
}
/** @deprecated 用 writeProjectGraph(DEFAULT_PROJECT_ID, graph) */
export function writeGraph(graph: AnyGraph): void {
  writeProjectGraph(DEFAULT_PROJECT_ID, graph);
}
