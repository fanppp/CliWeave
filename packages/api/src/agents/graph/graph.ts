/**
 * Graph 数据模型 + 校验 + 默认图
 *
 * 设计要点（审核 #5/#8/#9）：
 * - graph 节点 id 与底层 agent nodeKey 解耦：{ id, type:'agent', agentNodeKey }
 *   这样同一 agent 可在图中出现两次（M4 角色/环路），且 __input__ 不污染 canonical key 命名空间。
 * - readGraph：agents/graph.json 不存在 → 返回硬编码默认图（M1）；
 *   存在但非法 → 抛错（调用方应回 400），绝不静默回退默认图。
 * - M1 默认图为硬编码 __input__ → codex → claude，验证通信闭环。
 *   TODO(M2)：PUT /api/graph 落地 agents/graph.json 原子写入后，readGraph 切到读 graph.json。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { getProjectRoot } from '../../utils/project-root.js';

const GraphNodeIdSchema = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/, 'invalid graph node id');
const AgentNodeKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9_-]*$/, 'invalid agent nodeKey (expected provider:localId)');
const PositionSchema = z.object({ x: z.number(), y: z.number() });

export const GraphNodeSchema = z.discriminatedUnion('type', [
  z.object({ id: GraphNodeIdSchema, type: z.literal('input'), position: PositionSchema.optional() }),
  z.object({
    id: GraphNodeIdSchema,
    type: z.literal('agent'),
    agentNodeKey: AgentNodeKeySchema,
    position: PositionSchema.optional(),
  }),
]);

export const GraphEdgeSchema = z.object({
  source: GraphNodeIdSchema,
  target: GraphNodeIdSchema,
});

export const GraphSchema = z.object({
  schemaVersion: z.literal(1),
  inputNode: GraphNodeIdSchema,
  nodes: z.array(GraphNodeSchema).min(1),
  edges: z.array(GraphEdgeSchema),
});

export type Graph = z.infer<typeof GraphSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphAgentNode = Extract<GraphNode, { type: 'agent' }>;

/** M1 硬编码默认图：__input__ → codex:codex-node → claude:claude-node */
export function getDefaultGraph(): Graph {
  return {
    schemaVersion: 1,
    inputNode: '__input__',
    nodes: [
      { id: '__input__', type: 'input' },
      { id: 'n1', type: 'agent', agentNodeKey: 'codex:codex-node' },
      { id: 'n2', type: 'agent', agentNodeKey: 'claude:claude-node' },
    ],
    edges: [
      { source: '__input__', target: 'n1' },
      { source: 'n1', target: 'n2' },
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

/**
 * 结构性校验：唯一 id / agentNodeKey 唯一 / 边引用合法 / 恰好一个 input / inputNode 存在且为 input 类型 /
 * M1 agent 入度 ≤ 1 / 无重边 / 无自环 / 无环 / 所有 agent 节点从 input 可达。
 *
 * agentNodeKey 唯一（审核#7）：M2 禁止同一 agent 在一张图里出现多次，
 * 否则两节点共享同一 active-session.json 会上下文串味；多实例隔离留 M4。
 */
export function validateGraph(graph: Graph): void {
  const nodeIds = new Set<string>();
  const agentNodeKeys = new Set<string>();
  for (const n of graph.nodes) {
    if (nodeIds.has(n.id)) throw new GraphValidationError(`duplicate node id: ${n.id}`);
    nodeIds.add(n.id);
    if (n.type === 'agent') {
      if (agentNodeKeys.has(n.agentNodeKey)) {
        throw new GraphValidationError(`duplicate agentNodeKey in graph: ${n.agentNodeKey} (multi-instance isolation is M4)`);
      }
      agentNodeKeys.add(n.agentNodeKey);
    }
  }

  const inputNodes = graph.nodes.filter((n) => n.type === 'input');
  if (inputNodes.length !== 1) throw new GraphValidationError(`expected exactly one input node, got ${inputNodes.length}`);
  const inputNode = inputNodes[0];
  if (graph.inputNode !== inputNode.id) throw new GraphValidationError(`inputNode '${graph.inputNode}' is not the input node`);

  const inDegree = new Map<string, number>();
  for (const n of graph.nodes) inDegree.set(n.id, 0);
  const edgeKeys = new Set<string>();
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);

  for (const e of graph.edges) {
    if (!nodeIds.has(e.source)) throw new GraphValidationError(`edge source not found: ${e.source}`);
    if (!nodeIds.has(e.target)) throw new GraphValidationError(`edge target not found: ${e.target}`);
    if (e.source === e.target) throw new GraphValidationError(`self-loop not allowed: ${e.source}`);
    const key = `${e.source}->${e.target}`;
    if (edgeKeys.has(key)) throw new GraphValidationError(`duplicate edge: ${key}`);
    edgeKeys.add(key);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    adj.get(e.source)!.push(e.target);
  }

  // M1：agent 入度 ≤ 1（串行链；M4 放开为 fan-in reducer）
  for (const n of graph.nodes) {
    if (n.type === 'agent' && (inDegree.get(n.id) ?? 0) > 1) {
      throw new GraphValidationError(`M1 requires agent in-degree ≤ 1, node '${n.id}' has ${inDegree.get(n.id)}`);
    }
  }

  // 无环（DFS 三色标记）
  const color = new Map<string, number>(); // 0 unvisited 1 visiting 2 done
  for (const n of graph.nodes) color.set(n.id, 0);
  let hasCycle = false;
  const dfs = (id: string): void => {
    const c = color.get(id);
    if (c === 1) {
      hasCycle = true;
      return;
    }
    if (c === 2) return;
    color.set(id, 1);
    for (const next of adj.get(id) ?? []) dfs(next);
    color.set(id, 2);
  };
  dfs(inputNode.id);
  if (hasCycle) throw new GraphValidationError('graph contains a cycle');

  // 所有 agent 节点从 input 可达
  const reachable = new Set<string>();
  const bfs = (start: string): void => {
    const queue = [start];
    reachable.add(start);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of adj.get(cur) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
  };
  bfs(inputNode.id);
  for (const n of graph.nodes) {
    if (n.type === 'agent' && !reachable.has(n.id)) {
      throw new GraphValidationError(`agent node '${n.id}' is not reachable from input`);
    }
  }
}

/**
 * 读取图：agents/graph.json 不存在 → 默认图；存在 → 解析+校验（非法抛错）。
 */
export function readGraph(): Graph {
  const file = graphFile();
  if (!existsSync(file)) return getDefaultGraph();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new GraphValidationError(`graph.json is not valid JSON: ${(err as Error).message}`);
  }
  const graph = GraphSchema.parse(raw);
  validateGraph(graph);
  return graph;
}

/**
 * 原子写入 graph.json：写临时文件 → rename（单用户单 tab，前端权威本地状态 + last-write-wins）。
 * 调用方应在写入前完成 agentNodeKey 存在校验。
 */
export function writeGraph(graph: Graph): void {
  const parsed = GraphSchema.parse(graph);
  validateGraph(parsed);
  const file = graphFile();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
  renameSync(tmp, file);
}
