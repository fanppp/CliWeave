# 能力策略与 V5 迁移

本文档约束 CliWeave 的应用层能力边界，以及 V3→V4→V5 图的迁移策略。

## 1. 应用层能力策略（CapabilityPolicy）

首版**只承诺应用层能力策略**（由 `packages/api/src/agents/graph/routing.ts` 的 `resolveCapabilityProfile` 在 RunCoordinator 解析 lane + risk 后产出）。这是**意图声明 + prompt 约束 + 入口隔离**，不是操作系统级硬隔离。

```ts
interface CapabilityProfile {
  projectRead: boolean;       // 读项目仓库
  projectWrite: boolean;      // 改项目仓库
  commandExec: 'none' | 'safe_read' | 'test' | 'full_project';
  network: 'deny' | 'allow';
  externalSideEffects: 'deny' | 'human_approval';
}
```

### 各角色能力（V5 默认路线）

| 角色 | projectRead | projectWrite | commandExec | network | externalSideEffects |
|------|-------------|--------------|-------------|---------|---------------------|
| Router / Responder / Scribe | ✗ | ✗ | none | deny | deny |
| Investigator / Architect / Reviewer | ✓ | ✗ | safe_read | deny | deny |
| Implementer（small_change / planned_change） | ✓ | ✓ | full_project（critical 风险降为 test） | deny | deny（critical 升 human_approval） |
| Verifier | ✓ | ✗ | test | deny | deny |
| clarify / unsupported | ✗ | ✗ | none | deny | deny |

规则要点：
- **Router/Responder/Scribe 无工具**：Router 只决策通道，Responder 只回答，Scribe 只总结 issues 草案，均不触碰仓库。
- **Implementer 是唯一可写角色**：项目读写 + 执行；critical 风险降级为 `test`（只跑测试不写），外部副作用升级 `human_approval`。
- **Verifier 读 + 测试**：产物限 ignored/temp，不写业务代码。
- **Knowledge 写入只能经服务端窄 API**（`issue-store` 的 recordFinding/confirm/resolve/...）；Scribe 不直接写 findings，只输出 `ISSUE_SUMMARY_DRAFT`，由服务端校验后原子更新。

### 这不是硬隔离

> **OpenCode/Claude/Codex 当前仍不构成硬隔离**：`danger-full-access` / `--dangerously-skip-permissions` 模式下，CLI 在绑定的工作目录内可读写任意文件、执行任意命令。**cwd 不是安全边界。**

CapabilityProfile 是"应用层不把任务/工具交给不该有的角色"的约束，**防的是误用与编排错误，不是恶意 CLI**。真正的硬隔离须由独立的**容器 / OS sandbox / VM**实施（后续工作），与本项目正交，**本文档不宣称 cwd 是安全边界**。

## 2. 图迁移策略

V3、V4、V5 是**三个独立 runner**，**不在读取时自动迁移语义**（`parseAndNormalize` 只认 `schemaVersion`，不改写图语义；V1/V2→V3 的旧归一化保留）。

| 当前 schema | 迁移目标 | 策略 |
|-------------|----------|------|
| V3 | 保持 legacy | `walkLegacyGraph` 跑回边 maxIter best-effort。不自动转 V4。 |
| V4 | 保持 Evaluator-Optimizer | `walkEvaluatorOptimizerGraph` 跑 gate/candidate/pause-resume。不自动转 V5。 |
| V4 → V5 | 预览式**显式**升级 | 提供迁移向导：预览新 V5 图（router + lanes + knowledge/scribe），用户确认后才写。**普通 PUT 拒绝降级**（`writeProjectGraph` 对 V5→V4/V3 抛错）。 |
| 新项目 | 默认 V5 模板 | `POST /api/projects` 调 `scaffoldV5Workspace` 建 12 角色 + 7 通道图。 |

### 约束
- **stable edge ID**：V5 边 id 永不按 `source->target` 重写（V3 才在 `parseGraphRaw` 归一化 id）。
- **`agents/projects/test/` 永远不参与升级**：它是 V3 legacy 测试画布，scaffold 只作用于一键新建的项目；既有项目不自动升级。
- **缺 Provider 明确报告，不静默替换**：`buildAgent` 对未注册 provider 抛 `Provider 'X' not registered`；scaffold 收集 `missingProviders` 返回，不偷偷用别的 provider 顶替。
- **system-improvement 项目**手工升级到 V5（已建 `opencode:project-scribe` 节点）；不在自动流程内。

### V4→V5 迁移向导（后续落地，不在本批提交）
1. 读 V4 图，按 work/gate 拓扑映射到 V5 lane（单链→`small_change`；含 Architect→`planned_change`；只读→`investigate`/`review_only`）。
2. 加 Router + ProjectKnowledge + Scribe + observe 边。
3. 把 gate 的 `maxRevisions/onExhausted/onBlocked` 迁到 V5 gate（加 `lanes`）。
4. 预览新 V5 图给用户；确认后 `writeProjectGraph`（旧 V4 图移入 `.trash`）。
5. 失败可回滚（`.trash` 内 V4 图恢复）。

## 3. 运行模型回顾（四层）

`Project → Thread（跨轮记忆）→ Run（不可变图执行）→ NodeInvocation（一次 CLI 调用，run-scoped session）`

- V3/V4 节点会话：fresh（图运行永不传 `active`，不触碰 `active-session.json`）；rework 走 resume 该 producer 的 session；`session_fallback` 协议在 resume 不可用且无实质输出时由 provider 内部 fresh 重试（`:fb` 独立审计），Router 只观察不自重试。
- V5 Router：每次 fresh，只接收消息 + Thread 摘要 + 最近 turns + 项目元数据，不执行工具。
- Thread：`events.jsonl` 事实源 + revision lock + pending run 持久化；ContextBuilder 把"最近 8 轮 + summary + pins + serverContext"前置注入每个节点 prompt，历史 `[untrusted data]` 包裹防注入。

详见 `docs/PLAN.md` 的进度总览与 `packages/api/src/agents/graph/`（graph.ts/routing.ts/V5Router.ts/EvaluatorOptimizerRouter.ts）+ `agents/knowledge/`（issue-store/publish/scribe）。
