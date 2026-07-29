/**
 * V5 路由协调（routing）—— Router 决策契约 + RunCoordinator 纯逻辑。
 *
 * - Router 是独立 opencode:project-router 节点，每次 fresh session，只接收当前消息 + Thread 摘要 + 最近 turns + 项目元数据；
 *   不执行工具、不读仓库、不回答问题。malformed 重试一次，再失败进 Investigator。
 * - RunCoordinator 校验 Router 决策：answer/inspect 绝不能升级为写；明显修改不能走 direct；低置信进 Investigator；
 *   Investigator 后最多 reroute 一次；仍不确定则 durable pause（映射为 clarify needs_input）。
 * - 决定真正的 lane、entry node、gates、权限 profile，并持久化 route_decided + run_plan_created。
 *
 * 本模块只含纯逻辑（可单测）；Router/Investigator 的实际 CLI 调用由 V5 runner 编排。
 */
import { z } from 'zod';
import type { GraphV5, RouteLane, Risk, AnyGraph } from './graph.js';
import { isEdgeActive } from './graph.js';

export type IntentMode = 'auto' | 'answer' | 'inspect' | 'change';

/** CreateRunRequest：兼容旧 runMode（auto→auto、full→change）。 */
export interface CreateRunRequest {
  threadId?: string;
  expectedThreadRevision?: number;
  message: string;
  intentMode: IntentMode;
  gatePolicyOverrides?: Record<string, 'ask_user' | 'continue_best' | 'fail'>;
  /** #12 RunEntry：默认 {kind:'input'} 走整图；{kind:'work'} 从指定 work 节点启动。 */
  entry?: RunEntry;
}

/** 历史产物引用：只读同项目历史 run 的 finalText 或某 candidate 的 artifact，服务端 SHA-256 校验。 */
export interface ArtifactRef {
  runId: string;
  source: { kind: 'run_final' } | { kind: 'candidate'; candidateId: string };
  sha256: string;
}

/** RunEntry：input=整图从 input 节点跑；work=从指定 agent 节点手工启动。 */
export type RunEntry =
  | { kind: 'input' }
  | {
      kind: 'work';
      nodeId: string;
      mode: 'node_only' | 'downstream';
      /** V5 多 lane 节点须显式传；唯一 lane 自动推导（normalize 阶段填充）。 */
      lane?: RouteLane;
      /** 写通道手工进入默认 high（normalize 阶段填充）；用户显式降低须写 run_meta。 */
      risk?: Risk;
      artifactRef?: ArtifactRef;
    };

/** Router 输出契约（schemaVersion 1）。 */
export interface RouteDecision {
  schemaVersion: 1;
  lane: RouteLane;
  confidence: number;
  risk: Risk;
  sideEffects: 'none' | 'project_write' | 'external';
  reason: string;
  missingRequirements: string[];
}

export const RouteDecisionSchema = z.object({
  schemaVersion: z.literal(1),
  lane: z.enum(['direct_answer', 'investigate', 'plan_only', 'small_change', 'planned_change', 'review_only', 'verify_only', 'clarify', 'unsupported']),
  confidence: z.number().min(0).max(1),
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  sideEffects: z.enum(['none', 'project_write', 'external']),
  reason: z.string().min(1),
  missingRequirements: z.array(z.string()),
}).strict();

/** 应用层能力策略（首版不宣称 cwd 是安全边界；容器/OS sandbox 独立实施）。 */
export interface CapabilityProfile {
  projectRead: boolean;
  projectWrite: boolean;
  commandExec: 'none' | 'safe_read' | 'test' | 'full_project';
  network: 'deny' | 'allow';
  externalSideEffects: 'deny' | 'human_approval';
}

/** Coordinator 解析后的执行计划：真正的 lane + entry + gates + profile + 原始决策。 */
export interface RunPlan {
  lane: RouteLane;
  entryNodeId: string;
  endNodeId?: string;
  gateNodeIds: string[];
  profile: CapabilityProfile;
  routeDecision: RouteDecision;
  /** Investigator 重新路由过一次。 */
  rerouted: boolean;
}

export type RouteValidation = { ok: true } | { ok: false; reason: string; fallbackLane: RouteLane };

const WRITE_LANES: ReadonlySet<RouteLane> = new Set<RouteLane>(['small_change', 'planned_change']);
const ANSWER_LANES: ReadonlySet<RouteLane> = new Set<RouteLane>(['direct_answer', 'read_only_lookup' as RouteLane, 'investigate', 'review_only', 'verify_only']);
void ANSWER_LANES;

/** Router prompt：只给当前消息 + 摘要 + 最近 turns + 项目元数据，禁工具/禁读仓库/禁回答。 */
export function routerPrompt(message: string, threadSummary: string, recentTurns: string, projectMeta: string): string {
  return `【项目元数据】\n${projectMeta}\n\n【Thread 摘要】\n${threadSummary || '（首轮，无摘要）'}\n\n【最近轮次】\n${recentTurns || '（无）'}\n\n【当前消息】\n${message}\n\n你是项目路由器。只判断走哪条通道，不执行工具、不读仓库、不回答问题。仅输出一个 JSON RouteDecision：\n${JSON.stringify({ schemaVersion: 1, lane: 'direct_answer|investigate|plan_only|small_change|planned_change|review_only|verify_only|clarify|unsupported', confidence: 0, risk: 'low|medium|high|critical', sideEffects: 'none|project_write|external', reason: '一行', missingRequirements: [] })}\n\nlane 语义：direct_answer=简单问答/只读查询可由首节点直接答；investigate=需先调研；plan_only=只出计划；small_change=小改动；planned_change=需先规划再改；review_only=只审核；verify_only=只验证；clarify=缺关键信息；unsupported=超出能力。`;
}

function jsonPayload(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return JSON.parse((fenced?.[1] ?? text).trim());
}

/** 解析 Router 输出为 RouteDecision；malformed 抛错（由 runner 重试一次）。 */
export function parseRouteDecision(text: string): RouteDecision {
  return RouteDecisionSchema.parse(jsonPayload(text)) as RouteDecision;
}

/**
 * 校验 Router 决策与意图一致（RunCoordinator 规则）。
 * - answer/inspect 绝不能升级为写（sideEffects 必 none，lane 不得是写通道）。
 * - change 不得走 direct_answer（明显修改请求不能被首节点直接答）。
 * - 不一致 → 回落 lane（answer/inspect→investigate；change→planned_change）。
 */
export function validateRouteDecision(rd: RouteDecision, intentMode: IntentMode): RouteValidation {
  if (intentMode === 'answer' || intentMode === 'inspect') {
    if (rd.sideEffects !== 'none') return { ok: false, reason: `${intentMode} must not have side effects (got ${rd.sideEffects})`, fallbackLane: 'investigate' };
    if (WRITE_LANES.has(rd.lane)) return { ok: false, reason: `${intentMode} must not route to write lane '${rd.lane}'`, fallbackLane: 'investigate' };
    if (intentMode === 'answer' && rd.lane === 'investigate') return { ok: false, reason: 'answer intent should be answered directly, not investigated', fallbackLane: 'direct_answer' };
    return { ok: true };
  }
  if (intentMode === 'change') {
    if (rd.lane === 'direct_answer') return { ok: false, reason: 'change intent cannot be answered directly', fallbackLane: 'planned_change' };
    return { ok: true };
  }
  // auto：信任 Router，但写通道必须有声明的 sideEffects
  if (WRITE_LANES.has(rd.lane) && rd.sideEffects === 'none') return { ok: false, reason: `write lane '${rd.lane}' must declare side effects`, fallbackLane: rd.lane };
  return { ok: true };
}

/** 按 lane + risk 解析能力 profile（Implementer 才有项目读写+执行；Verifier 读+测试）。 */
export function resolveCapabilityProfile(lane: RouteLane, risk: Risk): CapabilityProfile {
  const base: CapabilityProfile = { projectRead: false, projectWrite: false, commandExec: 'none', network: 'deny', externalSideEffects: 'deny' };
  switch (lane) {
    case 'direct_answer':
    case 'review_only':
    case 'verify_only':
      return { ...base, projectRead: true, commandExec: lane === 'verify_only' ? 'test' : 'safe_read' };
    case 'investigate':
    case 'plan_only':
      return { ...base, projectRead: true, commandExec: 'safe_read' };
    case 'small_change':
    case 'planned_change':
      return { ...base, projectRead: true, projectWrite: true, commandExec: risk === 'critical' ? 'test' : 'full_project', externalSideEffects: risk === 'critical' ? 'human_approval' : 'deny' };
    case 'clarify':
    case 'unsupported':
      return base;
    default:
      return base;
  }
}

/**
 * 解析 lane → entry/end/gates：在 V5 图里找匹配该 lane 的 route 边得 entry，沿 forward 链走到 End，
 * 收集路径上 work 节点的 gate（按 order）。forward/gate 活跃判定统一走 isEdgeActive（lanes + minRisk）。
 */
export function resolveLanePlan(graph: GraphV5, rd: RouteDecision, rerouted: boolean): RunPlan {
  const router = graph.nodes.find((n) => n.type === 'router');
  if (!router) throw new Error('V5 graph has no router node');
  const routeEdge = graph.edges.find((e): e is Extract<GraphV5Edge, { kind: 'route' }> => e.kind === 'route' && e.source === router.id && e.lanes.includes(rd.lane));
  if (!routeEdge) throw new Error(`no route edge for lane '${rd.lane}'`);
  const forward = graph.edges.filter((e): e is Extract<GraphV5Edge, { kind: 'forward' }> => e.kind === 'forward');
  const activeForward = (from: string): Extract<GraphV5Edge, { kind: 'forward' }> | undefined =>
    forward.find((e) => e.source === from && isEdgeActive(e, rd.lane, rd.risk));
  const gateNodeIds: string[] = [];
  let cur: string | undefined = routeEdge.target;
  let endNodeId: string | undefined;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const node = graph.nodes.find((n) => n.id === cur);
    if (!node) break;
    if (node.type === 'end') { endNodeId = node.id; break; }
    if (node.type === 'agent') {
      const gates = graph.edges
        .filter((e): e is Extract<GraphV5Edge, { kind: 'gate' }> => e.kind === 'gate' && e.source === node.id && isEdgeActive(e, rd.lane, rd.risk))
        .sort((a, b) => a.order - b.order);
      for (const g of gates) gateNodeIds.push(g.id);
    }
    cur = activeForward(cur)?.target;
  }
  return {
    lane: rd.lane,
    entryNodeId: routeEdge.target,
    ...(endNodeId ? { endNodeId } : {}),
    gateNodeIds,
    profile: resolveCapabilityProfile(rd.lane, rd.risk),
    routeDecision: rd,
    rerouted,
  };
}

/**
 * #12 手工 downstream 入口：从指定 work 节点起，沿 forward 链走到 End，收集路径上 gate（按 order，isEdgeActive 过滤 lanes+minRisk）。
 * 与 resolveLanePlan 的区别：不从 route 边找 lane 入口，直接从用户指定节点起（用于 mid-lane 手工续跑）。
 */
export function resolveDownstreamPlan(graph: GraphV5, nodeId: string, lane: RouteLane, risk: Risk): RunPlan {
  const forward = graph.edges.filter((e): e is Extract<GraphV5Edge, { kind: 'forward' }> => e.kind === 'forward');
  const activeForward = (from: string): Extract<GraphV5Edge, { kind: 'forward' }> | undefined =>
    forward.find((e) => e.source === from && isEdgeActive(e, lane, risk));
  const gateNodeIds: string[] = [];
  let cur: string | undefined = nodeId;
  let endNodeId: string | undefined;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const node = graph.nodes.find((n) => n.id === cur);
    if (!node) break;
    if (node.type === 'end') { endNodeId = node.id; break; }
    if (node.type === 'agent') {
      const gates = graph.edges
        .filter((e): e is Extract<GraphV5Edge, { kind: 'gate' }> => e.kind === 'gate' && e.source === node.id && isEdgeActive(e, lane, risk))
        .sort((a, b) => a.order - b.order);
      for (const g of gates) gateNodeIds.push(g.id);
    }
    cur = activeForward(cur)?.target;
  }
  const rd: RouteDecision = { schemaVersion: 1, lane, confidence: 1, risk, sideEffects: 'project_write', reason: 'manual downstream entry', missingRequirements: [] };
  return {
    lane,
    entryNodeId: nodeId,
    ...(endNodeId ? { endNodeId } : {}),
    gateNodeIds,
    profile: resolveCapabilityProfile(lane, risk),
    routeDecision: rd,
    rerouted: false,
  };
}

// 局部类型别名，避免在函数签名里重复内联 Extract。
type GraphV5Edge = import('./graph.js').GraphV5Edge;

const WRITE_LANES_SET: ReadonlySet<RouteLane> = new Set<RouteLane>(['small_change', 'planned_change']);

/**
 * #12 规范化 RunEntry（/run 阶段，图已加载）：
 * - 缺省/ {kind:'input'} 走整图。
 * - work：nodeId 必须是 agent 节点（拒 router/decision/end/knowledge/documenter）。
 * - downstream 拒 V3（无 gate/forward 概念）。
 * - V5 多 lane 节点须显式传 lane；唯一 lane 自动推导。写通道 risk 缺省 high。
 * - artifactRef 只校验形状（runId/source/sha256）；跨项目 + SHA-256 在 /start resolveArtifactRef 校验。
 */
export function normalizeRunEntry(raw: unknown, graph: AnyGraph): { entry: RunEntry } | { error: string } {
  if (raw == null) return { entry: { kind: 'input' } };
  if (typeof raw !== 'object' || raw === null) return { error: 'entry must be an object' };
  const r = raw as Record<string, unknown>;
  if (r.kind === 'input') return { entry: { kind: 'input' } };
  if (r.kind !== 'work') return { error: "entry.kind must be 'input' or 'work'" };
  if (typeof r.nodeId !== 'string' || r.nodeId.length === 0) return { error: 'entry.nodeId is required' };
  if (r.mode !== 'node_only' && r.mode !== 'downstream') return { error: "entry.mode must be 'node_only' or 'downstream'" };
  const node = graph.nodes.find((n) => n.id === r.nodeId);
  if (!node) return { error: `entry node '${r.nodeId}' not found in graph` };
  if (node.type !== 'agent') return { error: `entry node '${r.nodeId}' must be an agent work node (got ${node.type})` };
  if (r.mode === 'downstream' && graph.schemaVersion === 3) return { error: 'downstream entry requires a V4 or V5 graph' };
  const mode = r.mode;
  let lane: RouteLane | undefined;
  let risk: Risk | undefined;
  if (graph.schemaVersion === 5) {
    const lanes = new Set<RouteLane>();
    for (const e of graph.edges) {
      if (e.kind === 'route' && e.target === r.nodeId) for (const l of e.lanes) lanes.add(l);
      if ((e.kind === 'forward' || e.kind === 'gate') && e.source === r.nodeId && e.lanes) for (const l of e.lanes) lanes.add(l);
    }
    if (mode === 'downstream') {
      if (typeof r.lane === 'string') {
        if (!lanes.has(r.lane as RouteLane)) return { error: `entry lane '${r.lane}' does not include node '${r.nodeId}'` };
        lane = r.lane as RouteLane;
      } else if (lanes.size === 1) {
        lane = [...lanes][0];
      } else {
        return { error: `node '${r.nodeId}' belongs to ${lanes.size} lanes; entry.lane is required` };
      }
    }
    if (lane && WRITE_LANES_SET.has(lane)) {
      risk = typeof r.risk === 'string' ? r.risk as Risk : 'high';
    } else if (typeof r.risk === 'string') {
      risk = r.risk as Risk;
    }
  }
  let artifactRef: ArtifactRef | undefined;
  if (r.artifactRef != null) {
    if (typeof r.artifactRef !== 'object' || r.artifactRef === null) return { error: 'entry.artifactRef must be an object' };
    const ar = r.artifactRef as Record<string, unknown>;
    if (typeof ar.runId !== 'string' || typeof ar.sha256 !== 'string' || typeof ar.source !== 'object' || ar.source === null) return { error: 'entry.artifactRef requires runId, source, sha256' };
    const src = ar.source as Record<string, unknown>;
    if (src.kind === 'run_final') artifactRef = { runId: ar.runId, source: { kind: 'run_final' }, sha256: ar.sha256 };
    else if (src.kind === 'candidate' && typeof src.candidateId === 'string') artifactRef = { runId: ar.runId, source: { kind: 'candidate', candidateId: src.candidateId }, sha256: ar.sha256 };
    else return { error: "entry.artifactRef.source must be {kind:'run_final'} or {kind:'candidate',candidateId}" };
  }
  const entry: Extract<RunEntry, { kind: 'work' }> = { kind: 'work', nodeId: r.nodeId, mode, ...(lane ? { lane } : {}), ...(risk ? { risk } : {}), ...(artifactRef ? { artifactRef } : {}) };
  return { entry };
}
