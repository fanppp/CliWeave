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

export type Graph = z.infer<typeof GraphV3Schema>;
export type GraphNode = z.infer<typeof V3NodeSchema>;
export type GraphEdge = z.infer<typeof V3EdgeSchema>;
export type GraphAgentNode = Extract<GraphNode, { type: 'agent' }>;

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

function normalizeV1ToV3(v1: GraphV1): Graph {
  return {
    schemaVersion: 3,
    inputNode: v1.inputNode,
    nodes: v1.nodes.map((n) => (n.type === 'agent' ? { id: n.id, type: 'agent', agentNodeKey: n.agentNodeKey, ...(n.position ? { position: n.position } : {}) } : { id: n.id, type: 'input', ...(n.position ? { position: n.position } : {}) })) as GraphNode[],
    edges: v1.edges.map((e) => ({ id: `${e.source}->${e.target}`, source: e.source, target: e.target })) as GraphEdge[],
    maxNodeExecutions: 50,
  };
}

function normalizeV2ToV3(v2: GraphV2): Graph {
  return {
    schemaVersion: 3,
    inputNode: v2.inputNode,
    maxNodeExecutions: v2.maxNodeExecutions ?? 50,
    ...(v2.endNode ? { endNode: v2.endNode } : {}),
    nodes: v2.nodes.map((n) => {
      const base = { id: n.id, ...(n.position ? { position: n.position } : {}) };
      if (n.type === 'agent') return { ...base, type: 'agent', agentNodeKey: n.agentNodeKey } as GraphNode;
      if (n.type === 'end') return { ...base, type: 'end' } as GraphNode;
      return { ...base, type: 'input' } as GraphNode;
    }),
    edges: v2.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, ...(e.maxIterations != null ? { maxIterations: e.maxIterations } : {}) }) as GraphEdge),
  };
}

/** M1 硬编码默认图（v3）：__input__ → codex → claude，无 end（自然结束）。 */
export function getDefaultGraph(): Graph {
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
function parseAndNormalize(raw: unknown): Graph {
  if (typeof raw !== 'object' || raw === null) throw new GraphValidationError('graph.json is not an object');
  const sv = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (sv === 1) return normalizeV1ToV3(GraphV1Schema.parse(raw));
  if (sv === 2) return normalizeV2ToV3(GraphV2Schema.parse(raw));
  if (sv === 3) return GraphV3Schema.parse(raw);
  throw new GraphValidationError(`unsupported schemaVersion: ${String(sv)}`);
}

/**
 * 回边预计算（DFS 三色）：访问 source 时若 target 仍在递归栈上(visiting) → 回边。
 * 这是标准 back-edge 检测，避免"t 能否经其它边到 s"的误判（环里两向边都会被误判）。
 * 回边 = "不满足→回到 target"；前向边 = "满足→继续"。
 */
export function computeBackEdges(graph: Graph): Set<string> {
  const back = new Set<string>();
  const adj = new Map<string, GraphEdge[]>();
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
export function validateGraph(graph: Graph): void {
  const nodeIds = new Set<string>();
  const agentNodeKeys = new Set<string>();
  for (const n of graph.nodes) {
    if (nodeIds.has(n.id)) throw new GraphValidationError(`duplicate node id: ${n.id}`);
    nodeIds.add(n.id);
    if (n.type === 'agent') {
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
}

/**
 * 可运行性校验（POST /run/start 前）。
 * input ≥1 前向出边（可扇出并行多个首层）；所有 agent 从 input 可达；end 可达；单路径（agent 每节点 ≤1 前向 + ≤1 回边出边）。
 * 环天然有界（回边默认 maxIter + 全局 maxNodeExecutions），不拒环。
 */
export function validateRunnable(graph: Graph): void {
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

/** 读取图：agents/graph.json 不存在 → 默认图；存在 → 解析+归一化为 v3 + 校验。 */
export function readGraph(): Graph {
  const file = graphFile();
  if (!existsSync(file)) return getDefaultGraph();
  let raw: unknown;
  try {
    const text = readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''); // 去 UTF-8 BOM
    raw = JSON.parse(text);
  } catch (err) {
    throw new GraphValidationError(`graph.json is not valid JSON: ${(err as Error).message}`);
  }
  let graph: Graph;
  try {
    graph = parseAndNormalize(raw);
  } catch (err) {
    if (err instanceof z.ZodError) throw new GraphValidationError(`schema error: ${err.message}`);
    throw err;
  }
  // 边 id 归一化为 `source->target`（人类可读 + 稳定；同向重复已被校验拒绝，故唯一）
  graph = { ...graph, edges: graph.edges.map((e) => ({ ...e, id: `${e.source}->${e.target}` })) };
  validateGraph(graph);
  return graph;
}

/** 原子写入 graph.json（v3）。 */
export function writeGraph(graph: Graph): void {
  const parsed = GraphV3Schema.parse(graph);
  validateGraph(parsed);
  const file = graphFile();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
  renameSync(tmp, file);
}
