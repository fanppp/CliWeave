# 计划与进度

## 锁定决策

- 节点配置存储: **JSON 文件 `agents/*.json`**（Agent 可自改/自增节点）
- Graph 执行模型: **显式静态图**（用户在 UI 连线，AgentRouter 读边拓扑）
- per-node 记忆起步: **仅会话 resume**（Phase 1），知识库 sqlite 留 Phase 3
- 前端: Next.js（与 clowder-ai 一致）
- 后端通信: Fastify + socket.io
- codex 沙箱: danger-full-access

## Phase 1 — 抽象骨架 + 单 codex 节点 + 自修改闭环

- [x] 1.1 pnpm workspace 脚手架 + Next.js + Fastify+socket.io
- [x] 1.2 AgentService 接口 + AgentMessage + NodeDescriptor + AgentServiceFactory
- [x] 1.3 L0Injector + SessionChain
- [x] 1.4 CodexAgentService + cli-spawn / ndjson / Windows shim
- [x] 1.5 SocketManager + messages/agents 路由
- [ ] 1.6 Web 聊天页 + 节点配置只读展示
- [x] 1.7 验证: ①改输入框→HMR ②加规则→行为改变
- [x] 1.8 历史对话: 直接读 codex 自己的 session transcript（单一真相源=CLI 记忆，不再并行存 history.jsonl）

**状态: ✅ Phase 1 完成（1.1–1.7 全部通过）**

## Phase 2 — 多 provider + 显式静态图

- [x] 2.1 已安装 provider：codex/claude/opencode AgentService + 事件转换 + 项目内记忆
- [ ] 2.1b Gemini provider：当前仅代码 stub，本机未安装，不计入已实现范围
- [x] 2.2 web 加/删/选节点：POST 脚手架建目录+默认 identity/rules + DELETE + GET providers + NodeSelector/新节点表单
- [ ] 2.3 Graph 画布（@xyflow/react 增删节点/连线/拖动）→ 存 graph.json
- [ ] 2.4 AgentRouter（读 graph.json 边拓扑串/并行调度）

**状态: 进行中（已安装的三个 provider 完成；Gemini 待未来按存储契约接入）**

## Phase 3 — per-node 深度

- [ ] 3.1 per-node 知识库（sqlite 语义检索）
- [ ] 3.2 per-node skills / MCP 挂载
- [ ] 3.3 rules sunset（熵减）
- [ ] 3.4 A2A 球权（动态 handoff）

**状态: 未开始**

## 已完成

- [2026-07-24] 1.1 - pnpm workspace 脚手架完成：packages/api (Fastify+socket.io :3004) + packages/web (Next.js :3000)，均启动验证通过。esbuild 警告无害（预编译二进制）。
- [2026-07-24] 1.2 - 核心抽象层：AgentService 接口、AgentMessage 判别联合、NodeDescriptor (zod 校验+读写)、AgentServiceFactory (注册表模式)。tsc 通过。
- [2026-07-24] 1.3 - L0Injector (identity+rules 编译，437字符) + SessionChain (per-node active.json resume)。运行时冒烟通过。
- [2026-07-24] 1.4 - codex 0.145.0 集成闭环跑通：buildAgent→CodexAgentService.invoke→spawnCli(shell:true on Win)→codex exec --json→NDJSON→transform→AgentMessage。实测输出 session_init→text"hello"→done(usage)。去掉了 --full-auto(0.145已移除)与无效的 -m gpt-5(用 codex 默认模型)。exit-1 抑制 + 兜底 done 已加。
- [2026-07-24] 1.5 - SocketManager(broadcast+join_node) + messages 路由(POST→202 in 95ms + 后台流式广播到 WS) + agents 路由(list/detail/post/put identity)。index.ts 接线完成。
- [2026-07-24] 1.6 - Web 聊天页完成：chatStore(zustand) + useSocket(socket.io 订阅 agent_message) + useSendMessage(POST) + ChatInput/MessageStream/NodeConfigPanel 组件。Next.js 渲染通过。
- [2026-07-24] 1.7 - 自修改双验证 PASS：①加规则→general.md 含"复述纪律"→compileL0 读进 L0(473字符)→行为改变 ②codex 直接改 ChatInput.tsx(rows={4}+fontSize:16)→自修改 web(HMR)。codex cwd=项目根+danger-full-access，能读写自身源码与 agents/*.json。**Phase 1 基础功能全部完成。**
- [2026-07-24] 1.8 - 历史对话功能：后端 HistoryStore(agents/<node>/sessions/history.jsonl，JSONL 追加) + messages 路由持久化用户/Agent 消息 + GET /api/agents/:id/history + web useNodeHistory 切换/刷新节点时加载历史填进消息流。真实记忆仍在 codex --resume。端到端验证：history 含 user"say hi"+agent"Hi!"。CORS 改 origin:true(反射任意来源)修复 localhost/127.0.0.1 不同源；web .next 缓存损坏时清掉重建。
- [2026-07-24] 1.8 改 - 历史改为直接读 codex 自己的 session transcript（~/.codex/sessions/.../rollout-<ts>-<sessionId>.jsonl），单一真相源=CLI 记忆，不再维护并行 history.jsonl。codex-transcript.ts 解析 rollout 的 response_item(message user/assistant + function_call)。实测读出 18 条真实对话（含用户让 codex 加 light 模式的全过程）。resume 用同一 sessionId→显示=真实记忆。
- [2026-07-24] 1.9 - 记忆全部存本项目：per-node CODEX_HOME=agents/<node>/memory/.codex（NodeDescriptor.memory.cliHome）。CodexAgentService spawn 时设子进程 env CODEX_HOME，ensureCodexHome() 从全局 copy-on-missing auth.json+config.toml。codex 的 session/记忆全落项目（不再进 ~/.codex）。codex-transcript 从 per-node home 读。端到端：POST→rollout 落 agents/codex-node/memory/.codex/sessions/，GET history 读出 user"say hi"+agent回复。.gitignore 排除 auth.json/config.toml/sqlite/日志（秘密），保留 sessions（对话在项目里）。
- [2026-07-24] 1.10 - 会话切换器：listCodexSessions 列项目内全部会话(sessionId+预览+条数)；GET /api/agents/:id/sessions + POST .../sessions/activate；web SessionPicker 下拉切换/恢复指定 CLI 对话。把全局里属于本项目的 6 个旧 transcript 迁移进项目，激活 light 模式那次(019f9323,20条)。chatStore 加 reloadKey/triggerReload 触发重新加载历史。
- [2026-07-24] 1.11 - 会话流控: messages 路由调用结束广播 done + 防并发发送 + ChatInput 忙闲状态指示 + chatStore done/session_init 后刷新历史/会话列表。git 初始化并提交(e36bd1e + 1ff353d)。
- [2026-07-24] 2.1 - 多 provider 完成：新增 ClaudeAgentService(claude -p --output-format stream-json --verbose --dangerously-skip-permissions，项目内 CLAUDE_CONFIG_DIR + 凭证 copy-on-missing + claude-transcript 读 projects/\<hash\>/\<sid\>.jsonl，实测 hello+历史2条)、OpenCodeAgentService(opencode run --format json，位置参数 prompt，实测 sessionInit+hello)、GeminiAgentService(按 clowder-ai 文档 best-effort，gemini 未装待测)。transcript-router 按 provider 调度 read/list。注册表 registerAllProviders 注册四个。新增 claude-node + opencode-node 节点配置。加新 CLI = provider 类+事件转换+注册一行+可选 transcript reader。
- [2026-07-24] 2.2 - web 加/删/选节点：POST /api/agents/:id 改为脚手架建目录+默认 identity/rules/sessions（按 provider 补默认 cliHome）+ isNew 检测；新增 DELETE /api/agents/:id（删 JSON+目录）；GET /api/agents/providers 返回四 provider 元数据(installed 标记)。web：NodeSelector(下拉切换节点+刷新历史)、AddNodeModal(选 provider+填 id/name/model→POST→切换)、删除按钮。实测：建 test-node 脚手架生成 identity/rules/sessions，DELETE 清除干净。
- [2026-07-25] 2.2 改 - opencode 历史读取改为对项目内 XDG SQLite 调用 `opencode export <sid>`；`active.json` 只保存 sessionId。会话列表使用 `opencode session list --format json`，不再把默认 table 输出误当 JSON。
- [2026-07-25] 2.2 存储闭环 - Codex/Claude/OpenCode 的 CLI home 增加节点目录越界保护，三者的 tmp 均落节点 memory；OpenCode 补齐 XDG_STATE_HOME。增加只复制的 dry-run/apply 迁移工具。Gemini 未安装，仅保留 stub 并由 `docs/CLI_STORAGE.md` 约束后续接入。
- [2026-07-25] 节点存储 v2 - 节点统一为 `config/`、`runtime/`、`data/cli/`，启动时自动迁移旧布局；共享数据预留 `shared/project` 和 `shared/teams/<team-id>` 两级 scope，但暂不启用读写。
- [2026-07-25] 节点存储 v3 - 节点按 `agents/<provider>/<local-id>/` 分类，canonical key 为 `provider:localId`；同 provider 下 localId 与显示名唯一，POST 只创建且冲突返回 409，provider/localId 创建后不可修改。v2 扁平节点自动迁移，Windows 锁定时继续兼容并延后重试。
- [2026-07-25] 2.2 Windows 进程修复 - OpenCode 不再经 `shell:true`/npm cmd shim 启动，改为解析并直接 spawn 原生 `opencode.exe`，修复 cmd 提前 code 1、原生进程残留和 snapshot index.lock 冲突。

## 已解决问题（2026-07-25）

### opencode 项目内存储与会话列表
- API invoke 已能在项目内 `.opencode/data/opencode/opencode.db` 创建并恢复 session。
- 原问题包含两部分：旧节点 descriptor 缺少显式 `cliHome`；session list 未传 `--format json`，解析默认 table 后返回空列表。
- OpenCode 1.18.4 的 `debug paths` 证明 data/config/cache 可由现有三个 XDG 变量重定向；本次再补 `XDG_STATE_HOME` 和项目内 tmp，消除剩余 C 盘写入路径。

## 全部 Gap（对照最终目标：任意 CLI 节点 + 每节点 memory/skills/rules + web 加节点可拖动）

| 维度 | 现状 | 状态 |
|------|------|------|
| codex provider（记忆/sessions/skills 全在项目） | CODEX_HOME 项目内 + transcript + resume | ✅ |
| claude provider（记忆/sessions 在项目） | CLAUDE_CONFIG_DIR 项目内 + transcript + resume | ✅ |
| opencode provider | 项目内 XDG data/config/cache/state/tmp + SQLite transcript + resume/list | ✅ |
| gemini provider | 仅 provider stub，本机未安装；接入规则见 CLI_STORAGE.md | ⚪ 未实现 |
| per-node rules/identity 注入 | codex/claude 走 L0(developer_instructions/append-system-prompt)；opencode instructions 配置会卡死 | ⚠️ opencode 待解 |
| per-node skills/MCP 注入 | descriptor.skills.mcp 空，无注入 | ❌ Phase 3 |
| web 加/删/选节点 | NodeSelector + AddNodeModal + DELETE + 脚手架 | ✅ |
| Graph 画布（@xyflow/react 增删/连线/拖动） | 未装 react-flow，无画布 | ❌ 2.3 |
| AgentRouter（读 graph.json 拓扑串/并行调度） | 单节点直连，无路由层 | ❌ 2.4 |
| 节点间通信（A.done→B.prompt） | 无 | ❌ 2.4 |
| worktree 隔离（每节点独立工作树） | 各节点共享项目根 cwd，无隔离 | ❌ Phase 3（clowder-ai 用 git worktree） |

下一步优先级：① Graph 画布 + 拖动 ② AgentRouter 多节点调度 ③ per-node skills/MCP。

## 差距评估（2026-07-24，对照最终目标）

最终目标：任意 CLI 节点（即插即用/即删即弃），可选哪个 CLI，每节点有 memory/skills/rules，web 上加节点并可拖动。

| 维度 | 现状 | 差距 |
|------|------|------|
| 任意 CLI 节点 | codex/claude/opencode 已实现；Gemini 仅 stub | ⚠️ 新 provider 须按 CLI_STORAGE.md 验收 |
| 可选哪个 CLI 建 | web 表单展示 provider 元数据，Gemini 标记未安装 | ✅ |
| 即插即用/即删即弃 | ✅ POST 脚手架建 + DELETE 删 + web UI | ✅ |
| web 加节点 | ✅ NodeSelector + AddNodeModal | ✅ |
| 拖动节点（react-flow）| ❌ | 2.3 |
| AgentRouter 多节点调度 | ❌ | 2.4 |
| per-node skills/MCP | ❌ | Phase 3 |

下一步优先级：① Graph 画布 @xyflow/react ② AgentRouter ③ per-node skills/MCP；Gemini 等本机安装后再按 CLI_STORAGE.md 接入。
骨架（注册表 + NodeDescriptor 数据驱动）已铺好，全是加法不重写。

## M2 — Graph 画布 + 多节点自由创建 + 执行（2026-07-25 起）

**范围**：单图（一张 graph.json）下的画布编辑 + 持久化 + 运行历史 + 节点创建增强。

| 子任务 | 状态 |
|--------|------|
| M2.1 mode 持久化 + join_graph ack 修复（codex 不显示真凶）+ 图模式右侧 + docs | 进行中 |
| M2.4 graph.ts position + agentNodeKey 唯一校验 + PUT /api/graph 原子写 + readGraph 切 graph.json | 待办 |
| M2.3 装 @xyflow/react + GraphCanvas + 图模式布局（保 GraphRunPanel 下方） | 待办 |
| M2.5 routes 层 WriteStream 历史 + run_meta 快照图 + GET runs + RunPicker | 待办 |
| M2.2 扩展现有 POST /api/providers/:provider/agents 加 identity + AddNodeModal textarea | 待办 |
| M2.6 typecheck + 联调验收 | 待办 |

**多图目标（前向兼容标注，非当前实现）**：
- M2 当前为**单图**：`agents/graph.json` 一张，`GET /api/graph` 返回该单图对象（无 graphId 字段）。
- 未来支持**多图**（每图一套节点 + 拓扑）：升级为 `GET /api/graphs` + `GET /api/graphs/:id`，graph 按文件 `agents/graphs/<id>.json`。
- **不预存假 graphId**：单图阶段 run 记录不写 graphId（或 null），避免造一个未来要对齐的不稳定标识。多图落地时再定 id 规范。

**M2 限制（已知，留后续）**：
- 同 agentNodeKey 在一张图内**唯一**（validateGraph 校验）→ 同 agent 多实例隔离（per-graph-node 会话槽）留 M4。
- opencode 节点入图运行可能卡死（snapshot/watcher 已缓解但未根治），画布加"实验性"警告。

## 文档更新纪律

每完成一个任务：
1. 勾选上方对应 checkbox（`[ ]` → `[x]`）
2. 在"已完成"区追加一行：`- [日期] 任务号 - 简述`
3. 更新该 Phase 的"状态"行

---

## 画布多轮对话 / 智能终止 / 指定节点入口（M6+，2026-07-28 起）

**目标**：统一为四层运行模型 `Project → Thread（跨轮记忆）→ Run（不可变图执行）→ NodeInvocation（一次 CLI 调用，run-scoped session）`。回答三个核心问题：

1. **Q1**：首节点能答就不必跑后续（智能终止）。
2. **Q2**：多轮记忆如何处理、每个 CLI 是否要带上一轮结果。
3. **Q3**：可否直接从某节点开始。

### 进度总览（已纠正：V4 早已存在，非"未开始"）

| 阶段 | 内容 | 状态 | commit |
|------|------|------|--------|
| **Step 1** | Session 基座（切断 graph↔active-session + `session_fallback` 协议 + node-mode WS/路由全迁 project-aware） | ✅ 完成 | `3650b52` |
| **Step 2** | Thread 基座（append-only events + revision lock + pending run 持久化 + CRUD） | ✅ 完成 | `4f9ec5e` |
| **Step 3** | ContextBuilder（Thread 跨轮记忆注入 + serverContext + 12k 预算裁剪 + untrusted 包裹） | ✅ 完成 | `6ae6016` |
| **V4 Harness** | V4 schema（decision/gate/rework + maxRevisions/onExhausted/onBlocked）+ `walkEvaluatorOptimizerGraph`/`resumeEvaluatorOptimizerGraph` + `evaluation.ts`（selectBest/extractEvaluation/snapshotRubrics/evaluatorPrompt/revisionPrompt）+ `completion.ts`（extractCompletion/AUTO_ROUTE_INSTRUCTION ROUTE 控制块）+ `HarnessCheckpoint`/`verifyCheckpointToken`/pause-resume + `projects.ts` resume 路由 + `gatePolicyOverrides` + rubric 路径 jail + run_meta.rubrics 快照 + resumeToken 净化 | ✅ **早已存在**（V3/V4 双 runner，不读时迁移） | — |
| **V4.1** | 修复 Auto 提前结束：extractCompletion 四分类（empty_artifact/unsafe_category/malformed_control/missing_control）+ FINISH 空 artifact 定向重试 Architect 一次 + 仍空→run_error + 任意 work 空输出永不进 Decision | ✅ 完成（本提交） | — |
| **V4.2** | 修复 blocked/bestCandidate：HarnessCheckpoint.allowedActions/bestCandidateId/pauseReason + blocked 不参选（rank null）+ 无 best 只 revise_once|fail 禁 continue_best + 有历史 best 才 allow continue_best + Resume API 校验 action∈allowedActions（`isAllowedResumeAction`）+ revise_once 从该 work 第一 gate 重审 + 前端按钮来自服务端 options | ✅ 完成（本提交） | — |
| **V4.3** | 完成质量 Payload：WorkPayload{payload, quality{status,exhausted,bestCandidateId,evaluations,unresolvedGateIds}} + 下游只用 payload + quality 独立元数据 + evaluator 自然语言永不作主 payload + continue_best 保留未解决 gate/evaluation + Thread turn 存 artifact 与质量摘要 | ❌ 未开始（commit #2） | — |
| **V4.4** | 事件和恢复：补齐 gate_blocked/candidate_rejected/resume_rejected 事件 + 公开 event 与内部 checkpoint 分离 + token hash/到期/allowedActions 写 JSONL + 前端 sessionStorage + 服务重启扫 paused checkpoint 恢复 RunRegistry + token 消费在 Thread/checkpoint/动作全校验后 + V4 仍限单 input 分支 | ❌ 未开始（commit #2） | — |
| **V4.5** | 测试门槛贯穿：空 FINISH artifact 重试与失败 / 空 candidate 永不进 evaluator / blocked 无 best 拒 continue_best / blocked 有历史 best 允许 / Verify reject→Implementer→Code Reviewer→Verify / 多 gate 独立预算 / resume token 一次性过期非法 action / rubrics 用 run_meta 快照 / 前端刷新恢复 pause / V3 全套不回归 | 🟡 部分完成（V4.1/V4.2 相关项已覆盖；V4.3/V4.4 相关项待 commit #2） | — |
| **V5 Schema** | RouterNode/ProjectKnowledgeNode/DocumenterNode + RouteEdge/ObserveEdge + forward/gate 加 lanes/minRisk + 校验 + RouteDecision + CreateRunRequest(intentMode) + RunCoordinator + 独立 runner 不读时迁移 | ❌ 未开始（commit #3） | — |
| **V5 角色/模板** | 默认路线 direct_answer/investigate/plan_only/small_change/planned_change/review_only/verify_only + 高风险加 Security Reviewer + 发布部署迁移只产计划暂停 + 新项目默认 V5 模板 + opencode:project-router GLM-5.2 fresh + 缺 Provider 明确报告 | ❌ 未开始（commit #4） | — |
| **Project Knowledge** | knowledge/ 事实源(.gitignore) + FindingEvent 状态机 + 服务端 fingerprint + API GET/confirm/resolve/accept/reopen/publish + Issues 面板 + Publish 路径 jail/secret scan/冲突/dirty-worktree | ❌ 未开始（commit #5） | — |
| **Project Scribe** | opencode:project-scribe GLM-5.2 可选 documenter 接 Knowledge observe 边 + 不进主链/不影响 run 成败 + 只输出 ISSUE_SUMMARY_DRAFT + 无 Scribe 时 IssueProjector 确定性模板 | ❌ 未开始（commit #6） | — |
| **V5 画布/Issues UI** | 四泳道 Direct/Investigation/Engineering/Knowledge + Router 显示 lane/risk/confidence + Knowledge open/resolved 数 + Scribe 状态 + Issues 面板 | ❌ 未开始（commit #7） | — |
| **能力策略/迁移文档** | 应用层 CapabilityPolicy（projectRead/Write、commandExec、network、externalSideEffects 各角色）+ V3→legacy/V4→保持/V4→V5 预览式显式升级 + OpenCode/Claude 不构成硬隔离 | ❌ 未开始（commit #8） | — |

### 三问状态

- **Q2 多轮记忆**：✅ **后端完成**（Step 2+3）。Thread 事件源 + ContextBuilder 把"最近 8 轮 Q&A + summary + pins + serverContext"前置注入每个节点 prompt，历史 `[untrusted data]` 包裹防注入、超预算裁最旧；永不裁 system/当前消息/上游 payload。每个 work 节点 fresh 跑，靠构造 prompt 携带跨轮记忆。前端未接线（Step 7/commit #7）。
- **Q1 智能终止**：🟡 **V4 已实现首节点 auto-route 早结束（FINISH simple_answer→early_complete），V4.1 已硬化**（空 artifact 重试、unsafe_category 强制 forward、空输出不进 gate）。完整 CompletionClaim disposition（finish|forward）+ branch 级早结束留 V5 Coordinator。
- **Q3 从节点开始**：❌ 未动（V5 RunEntry / commit #3-4）。注：Step 1B 的 `POST /api/projects/:pid/nodes` 是创建节点**实例**，不是"从某节点发起 run"。

### 关键设计决策（已锁定）

- **Session**：provider 在 resume 不可用且**无实质输出**时发 `session_fallback` 诊断并内部 fresh 重试（用 `${invocationId}:fb` 独立审计）；Router 只观察、不自重试（防双执行）。图运行永不传 `active` → 不触碰 `active-session.json`。
- **WS**：`NodeMessageEnvelope{instanceKey,message}` + `join_node(ack)` + 按 instanceKey 过滤（防 projA/projB 同 nodeKey 串台）；`joinedInstanceKey===activeInstanceKey` 才发。
- **切换仲裁**：`projectStore` 统一仲裁（`chatBusy || graph starting/running`），忙则整个切换失败；`chatStore.setProjectId` 一旦调用无条件原子重置 + 项目级 active-node localStorage key。
- **Thread**：`events.jsonl` 事实源（append-only）+ `thread.json` 可变（revision+activeRunId）；revision lock（continue 须传 `expectedThreadRevision`，不匹配→409）；同 Thread 单 active run→409；pending run 落盘（create↔start 之间重启不丢）。
- **ContextBuilder**：首版纯 raw turns 回退（summary 留空到 commit #6 Scribe/commit #8 增强）；char/4 token 估算；serverContext 的 location 由调用方提供（不推断），缺失则省略。
- **V3/V4/V5 三独立 runner，不读时迁移**：`schemaVersion===3→walkLegacyGraph`，`===4→walkEvaluatorOptimizerGraph`，`===5→（V5 Router+Coordinator）`；V3→V4/V4→V5 提供显式预览式迁移向导，不在读取时自动重写语义；PUT 拒绝降级。
- **V4 稳定化优先**：先修 V4（completion/blocked resume/quality payload/replay），V4 单独提交作 V5 基线；V5 不复用 Architect 文本路由，新增独立 Router/RunCoordinator/ProjectKnowledge。

### 已完成细节

- **Step 1**：`session-policy.ts` + `invoke-agent.ts` + `AgentRouter` 薄壳；3 provider session_fallback+`:fb`+spawnFn 测试缝。测试：invoke-agent(7)+walk policy+active-session(3)+codex-session-fallback(2)。
- **Step 2**：`thread-store.ts`（CRUD/openTurn/completeTurn/failTurn/abortPendingTurn/pinMemory/unpinMemory/pending run 读写）+ run-registry/RunMeta 加 threadId/turnId/threadRevision + `projects.ts` POST /run + /start 读 pending + 终态回调 + Thread CRUD。测试：thread-store(11)。
- **Step 3**：`context-builder.ts`（buildThreadContext/buildServerContext）+ ExecuteOptions.contextPrefix + walkBranch 前置注入 + RunMeta.contextSnapshot + `/start` 构造注入+快照。测试：context-builder(8)+walk 前置(1)。
- **V4 Harness（早已存在）**：`EvaluatorOptimizerRouter.ts`（walk/resume + HarnessCheckpoint + verifyCheckpointToken + pause + Architect auto-route + 多 gate 有序 + selectBest best-effort + candidate/evaluation 事件源）、`evaluation.ts`（Rubric zod + readDecisionRubric 路径 jail + snapshotRubrics + extractEvaluation malformed 重试1次→blocked + selectBest 排除 blocked + evaluatorPrompt untrusted_candidate 包裹）、`completion.ts`（ROUTE 控制块 + SAFE_FINISH + 保守 forward）、`graph.ts` V4 schema + validateV4Topology/validateV4Runnable（单 input 分支）、`graph-run-store.ts` resumeToken 净化 + rubrics 快照、`projects.ts` resume 路由 + gatePolicyOverrides + snapshotRubrics。测试：evaluator-optimizer-router(5)+evaluation(3)+completion(4)+graph+agent-router。
- **V4.1（本提交）**：`completion.ts` 加 `CompletionDiagnostic`（ok/empty_artifact/unsafe_category/malformed_control/missing_control）+ `completionRetryPrompt`，**保持 V3 决策语义不变**（finish+空→forward、clarify+空→clarify，V4 靠 claim+diagnostic 触发重试）；`EvaluatorOptimizerRouter` firstWork auto：声明 FINISH/CLARIFY 但空 artifact → 定向重试 Architect 一次（`completionRetryPrompt`），仍空→run_error；任意 work 空输出→run_error 不进 gate。
- **V4.2（本提交）**：`HarnessCheckpoint` 加 `allowedActions`/`bestCandidateId?`/`pauseReason`；blocked/exhausted 分支计算 best（selectBest 已排除 blocked via rank null）→ 无 best 只 `[revise_once,fail]`，有 best 才加 `continue_best`；`pause()` emit options 来自 allowedActions + run_state 带 pauseReason/bestCandidateId；`isAllowedResumeAction` 导出供路由+测试；`projects.ts` resume 路由在消费 token 前校验 action∈allowedActions（409）；evaluatorMalformed→pauseReason 'malformed'；前端 `GraphRunPanel` 按钮从 `paused.options` 渲染。测试：completion(8)+evaluator-optimizer-router(15)+isAllowedResumeAction。

**累计测试 107 过**（含 V4.1/V4.2 新增 12 例：completion +6、V4 router +10、isAllowedResumeAction +1）；api+web typecheck 绿；web build 绿；启动烟测 /api/providers+/api/projects 200（tsx watch 热重载未崩）。

### 重要提醒

- Step 2/3 的**后端契约已完成并测试**，但**前端尚未接线**（`graphRunStore.startRun` 仍发 `{prompt}`、无 Thread 选择器/继续对话 UI、RunPicker 不按 thread 分组）。即从 web UI 还用不上多轮记忆——那是 commit #7。后端已可独立验证（curl + 测试）。
- ContextBuilder 前缀当前注入**所有** agent 节点（含 decision/reviewer）；设计原指"每个 work 节点"，V5 Coordinator 可细化。
- 无前端设置 project `location` 的 UI（`ProjectLocal.location` 字段已就位，首版始终省略）。
- 真实 V4 运行时烟测需建 V4 图+rubric+CLI 节点（test 项目当前是 V3）；V4.1/V4.2 行为由 15 个单测全覆盖（auto finish/重试/重试失败/unsafe forward/空输出不进 gate/blocked 无 best/blocked 有 best/exhausted/malformed/非法 action）。

### 下一步

- **commit #2**：V4.3 WorkPayload 质量 + V4.4 事件/恢复（gate_blocked/candidate_rejected/resume_rejected + token hash/allowedActions 写 JSONL + 前端 sessionStorage + 服务重启扫 paused checkpoint 恢复 RunRegistry）。
- 之后 commit #3 V5 schema+Coordinator → #4 V5 角色/模板 → #5 Project Knowledge → #6 Scribe → #7 画布/Issues UI → #8 能力策略/迁移文档。

