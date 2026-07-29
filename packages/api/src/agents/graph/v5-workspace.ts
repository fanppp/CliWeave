/**
 * V5 Project Workspace —— 默认角色 + 7 通道路由模板 + 新项目脚手架。
 *
 * 默认路线：
 * - direct_answer: Router → Responder → End
 * - investigate:   Router → Investigator → End / reroute once
 * - plan_only:     Router → Architect → Plan Reviewer → End（发布/部署/迁移只产计划，到此结束不自动执行）
 * - small_change:  Router → Implementer → Code Reviewer → Verifier → End
 * - planned_change: Router → Architect → Plan Reviewer → Implementer → Code Reviewer → Security Reviewer → Verifier → End
 * - review_only:   Router → Review Analyst → End
 * - verify_only:   Router → Verification Analyst → End
 *
 * 高风险：planned_change 额外经过 Security Reviewer（gate-security lanes=[planned_change] minRisk=high；
 *   small_change 不在 lanes 内故跳过）。Security/Code/Verify 均为 implementer 的 gate（rework 回 implementer）。
 *
 * 新项目由 create-project 路由调用 scaffoldV5Workspace 建角色节点 + 写 V5 图；既有项目（含 test）不自动升级。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { instantiateNodeInstance } from '../project-storage.js';
import { writeProjectGraph } from './graph.js';
import { PROVIDERS } from '../register-providers.js';
import type { GraphV5, RouteLane } from './graph.js';

export interface V5Role {
  nodeKey: string;
  name: string;
  provider: string;
  model?: string;
  identity: string;
  /** decision 角色：scaffold 时写默认 rubric.json。 */
  decision?: boolean;
}

/** 默认角色（nodeKey 与图模板一致）。opencode 角色用 GLM-5.2；codex/claude 走各自默认模型。 */
export const V5_ROLES: V5Role[] = [
  { nodeKey: 'opencode:project-router', name: '项目路由器', provider: 'opencode', model: 'alibaba-cn/glm-5.2', identity: '# 项目路由器\n\n你只判断走哪条通道（direct_answer/investigate/plan_only/small_change/planned_change/review_only/verify_only/clarify/unsupported），不执行工具、不读仓库、不回答问题。每次 fresh session，仅依据当前消息 + Thread 摘要 + 最近轮次 + 项目元数据输出 JSON RouteDecision。\n' },
  { nodeKey: 'opencode:responder', name: '直接应答者', provider: 'opencode', model: 'alibaba-cn/glm-5.2', identity: '# 直接应答者\n\n处理 direct_answer 通道：简单问答与只读查询。直接给出答案，不修改项目文件。\n' },
  { nodeKey: 'opencode:investigator', name: '调研者', provider: 'opencode', model: 'alibaba-cn/glm-5.2', identity: '# 调研者\n\n处理 investigate 通道：在项目内只读调研，补充路由或规划所需信息，不做修改。产出调研结论。\n' },
  { nodeKey: 'opencode:architect', name: '架构师', provider: 'opencode', model: 'alibaba-cn/glm-5.2', identity: '# 架构师\n\n处理 plan_only / planned_change 通道的规划阶段：产出完整实施计划，不直接改代码。计划经 Plan Reviewer 审核通过后才继续（planned_change）或结束（plan_only，发布/部署/迁移到此暂停不自动执行）。\n' },
  { nodeKey: 'codex:plan-review', name: '计划审核', provider: 'codex', identity: '# 计划审核\n\n审核架构师产出的计划是否完整、可执行、满足原始需求。输出 JSON Evaluation。\n', decision: true },
  { nodeKey: 'opencode:implementer', name: '实施者', provider: 'opencode', model: 'alibaba-cn/glm-5.2', identity: '# 实施者\n\n处理 small_change / planned_change 通道的执行阶段：按计划修改项目代码。产物依次经 Code Reviewer、（高风险时）Security Reviewer、Verifier 审核。\n' },
  { nodeKey: 'codex:code-review', name: '代码审核', provider: 'codex', identity: '# 代码审核\n\n审核实施者产物的正确性、质量、是否满足原始需求与计划。输出 JSON Evaluation。\n', decision: true },
  { nodeKey: 'codex:security-review', name: '安全审核', provider: 'codex', identity: '# 安全审核\n\n仅高风险运行激活：审核产物的安全风险（注入、密钥泄漏、越权、危险外部副作用）。输出 JSON Evaluation。\n', decision: true },
  { nodeKey: 'claude:verify', name: '验证', provider: 'claude', identity: '# 验证\n\n最终验证：运行测试 / 校验产物满足验收标准。输出 JSON Evaluation。\n', decision: true },
  { nodeKey: 'opencode:review-analyst', name: '审查分析师', provider: 'opencode', model: 'alibaba-cn/glm-5.2', identity: '# 审查分析师\n\n处理 review_only 通道：对已有代码/产物做审查分析，产出审查报告，不修改。\n' },
  { nodeKey: 'opencode:verify-analyst', name: '验证分析师', provider: 'opencode', model: 'alibaba-cn/glm-5.2', identity: '# 验证分析师\n\n处理 verify_only 通道：对已有产物做验证分析（测试/校验），产出验证报告，不修改。\n' },
  { nodeKey: 'opencode:project-scribe', name: '项目 Scribe', provider: 'opencode', model: 'alibaba-cn/glm-5.2', identity: '# 项目 Scribe\n\n你是可选的 documenter 节点，接 Knowledge observe 边。不进主链、不影响 run 成败。只把 confirmed/resolved/accepted 问题总结为 ISSUE_SUMMARY_DRAFT（Markdown），不确认/关闭/删除/合并任何 finding。每次 fresh session。\n' },
];

/** V5 默认图模板（7 通道 + 高风险 security gate；clarify/unsupported 由 router 决策，不需 route 边）。 */
export function getDefaultV5ProjectGraph(): GraphV5 {
  const router = 'opencode:project-router';
  const responder = 'opencode:responder';
  const investigator = 'opencode:investigator';
  const architect = 'opencode:architect';
  const planReview = 'codex:plan-review';
  const implementer = 'opencode:implementer';
  const codeReview = 'codex:code-review';
  const securityReview = 'codex:security-review';
  const verify = 'claude:verify';
  const reviewAnalyst = 'opencode:review-analyst';
  const verifyAnalyst = 'opencode:verify-analyst';
  const lanes = (...l: RouteLane[]): RouteLane[] => l;
  return {
    schemaVersion: 5,
    inputNode: '__input__',
    endNode: '__end__',
    maxNodeExecutions: 80,
    nodes: [
      { id: '__input__', type: 'input' },
      { id: 'router', type: 'router', agentNodeKey: router, policyRef: 'router-policy.json' },
      { id: 'responder', type: 'agent', agentNodeKey: responder },
      { id: 'investigator', type: 'agent', agentNodeKey: investigator },
      { id: 'architect', type: 'agent', agentNodeKey: architect },
      { id: 'plan-review', type: 'decision', agentNodeKey: planReview, rubricRef: 'rubric.json' },
      { id: 'implementer', type: 'agent', agentNodeKey: implementer },
      { id: 'code-review', type: 'decision', agentNodeKey: codeReview, rubricRef: 'rubric.json' },
      { id: 'security-review', type: 'decision', agentNodeKey: securityReview, rubricRef: 'rubric.json' },
      { id: 'verify', type: 'decision', agentNodeKey: verify, rubricRef: 'rubric.json' },
      { id: 'review-analyst', type: 'agent', agentNodeKey: reviewAnalyst },
      { id: 'verify-analyst', type: 'agent', agentNodeKey: verifyAnalyst },
      { id: '__knowledge__', type: 'project_knowledge' },
      { id: 'scribe', type: 'documenter', agentNodeKey: 'opencode:project-scribe' },
      { id: '__end__', type: 'end' },
    ],
    edges: [
      { id: 'in->router', source: '__input__', target: 'router', kind: 'forward' },
      { id: 'route-answer', source: 'router', target: 'responder', kind: 'route', lanes: lanes('direct_answer') },
      { id: 'route-investigate', source: 'router', target: 'investigator', kind: 'route', lanes: lanes('investigate') },
      { id: 'route-architect', source: 'router', target: 'architect', kind: 'route', lanes: lanes('plan_only', 'planned_change') },
      { id: 'route-implementer', source: 'router', target: 'implementer', kind: 'route', lanes: lanes('small_change') },
      { id: 'route-review', source: 'router', target: 'review-analyst', kind: 'route', lanes: lanes('review_only') },
      { id: 'route-verify-analyst', source: 'router', target: 'verify-analyst', kind: 'route', lanes: lanes('verify_only') },
      { id: 'responder->end', source: 'responder', target: '__end__', kind: 'forward' },
      { id: 'investigator->end', source: 'investigator', target: '__end__', kind: 'forward' },
      { id: 'architect->implementer', source: 'architect', target: 'implementer', kind: 'forward', lanes: lanes('planned_change') },
      { id: 'architect->end', source: 'architect', target: '__end__', kind: 'forward', lanes: lanes('plan_only') },
      { id: 'gate-plan', source: 'architect', target: 'plan-review', kind: 'gate', order: 1, maxRevisions: 2, onExhausted: 'ask_user', onBlocked: 'ask_user', lanes: lanes('plan_only', 'planned_change') },
      { id: 'rework-plan', source: 'plan-review', target: 'architect', kind: 'rework' },
      { id: 'implementer->end', source: 'implementer', target: '__end__', kind: 'forward', lanes: lanes('small_change', 'planned_change') },
      { id: 'gate-code', source: 'implementer', target: 'code-review', kind: 'gate', order: 1, maxRevisions: 2, onExhausted: 'ask_user', onBlocked: 'ask_user', lanes: lanes('small_change', 'planned_change') },
      { id: 'rework-code', source: 'code-review', target: 'implementer', kind: 'rework' },
      { id: 'gate-security', source: 'implementer', target: 'security-review', kind: 'gate', order: 2, maxRevisions: 1, onExhausted: 'ask_user', onBlocked: 'fail', lanes: lanes('planned_change'), minRisk: 'high' },
      { id: 'rework-security', source: 'security-review', target: 'implementer', kind: 'rework' },
      { id: 'gate-verify', source: 'implementer', target: 'verify', kind: 'gate', order: 3, maxRevisions: 2, onExhausted: 'ask_user', onBlocked: 'ask_user', lanes: lanes('small_change', 'planned_change') },
      { id: 'rework-verify', source: 'verify', target: 'implementer', kind: 'rework' },
      { id: 'review-analyst->end', source: 'review-analyst', target: '__end__', kind: 'forward' },
      { id: 'verify-analyst->end', source: 'verify-analyst', target: '__end__', kind: 'forward' },
      { id: 'observe-scribe', source: '__knowledge__', target: 'scribe', kind: 'observe' },
    ],
  };
}

export interface ScaffoldResult {
  created: string[];
  missingProviders: string[];
  graphError?: string;
}

/**
 * 新项目脚手架：实例化全部 V5 角色 + 写默认 V5 图。既有项目不调用（不自动升级；test 永远不升级）。
 * 缺 Provider 时收集到 missingProviders（节点配置仍建，运行时 buildAgent 会明确报错，不静默替换）。
 */
export function scaffoldV5Workspace(projectId: string): ScaffoldResult {
  const created: string[] = [];
  const missingProviders: string[] = [];
  for (const role of V5_ROLES) {
    const meta = PROVIDERS.find((p) => p.id === role.provider);
    if (!meta) { if (!missingProviders.includes(role.provider)) missingProviders.push(role.provider); continue; }
    if (existsSync(projectId)) { /* noop guard */ }
    try {
      const instance = instantiateNodeInstance(projectId, role.nodeKey, {
        name: role.name,
        command: meta.command,
        memoryHome: meta.memoryHome,
        ...(role.model ?? meta.defaultModel ? { model: role.model ?? meta.defaultModel } : {}),
        identity: role.identity,
      });
      if (role.decision) {
        const rubricFile = join(instance.nodeDir, 'config', 'rubric.json');
        if (!existsSync(rubricFile)) {
          mkdirSync(dirname(rubricFile), { recursive: true });
          writeFileSync(rubricFile, JSON.stringify({ schemaVersion: 1, name: `${role.name} rubric`, criteria: [{ id: 'correctness', description: '产物正确、完整并满足原始需求', required: true, weight: 1 }] }, null, 2) + '\n', 'utf-8');
        }
      }
      created.push(role.nodeKey);
    } catch {
      // 节点已存在或其它失败：跳过（幂等脚手架）
    }
  }
  let graphError: string | undefined;
  try {
    writeProjectGraph(projectId, getDefaultV5ProjectGraph());
  } catch (e) {
    graphError = (e as Error).message;
  }
  return { created, missingProviders, ...(graphError ? { graphError } : {}) };
}
