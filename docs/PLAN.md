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

- [x] 2.1 多 provider：codex/claude/opencode/gemini 四个 AgentService 实现 + 各自事件转换 + 注册表
- [ ] 2.2 web 加/删节点（选 CLI→填配置→脚手架 agents/\<id\>/{identity,rules,memory}）+ DELETE 路由
- [ ] 2.3 Graph 画布（@xyflow/react 增删节点/连线/拖动）→ 存 graph.json
- [ ] 2.4 AgentRouter（读 graph.json 边拓扑串/并行调度）

**状态: 进行中（2.1 完成）**

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

## 差距评估（2026-07-24，对照最终目标）

最终目标：任意 CLI 节点（即插即用/即删即弃），可选哪个 CLI，每节点有 memory/skills/rules，web 上加节点并可拖动。

| 维度 | 现状 | 差距 |
|------|------|------|
| 任意 CLI 节点 | ✅ codex/claude/opencode/gemini 四 provider 全实现 | ✅（gemini 未装待测，其余实测通过） |
| 可选哪个 CLI | NodeDescriptor 有 provider/command/model/sandbox 字段 | ❌ web 无"选 CLI 建节点"UI |
| per-node memory | ✅ codex；其它 CLI 各有 home | ⚠️ claude/opencode/gemini 各需 home 解析+transcript reader |
| per-node skills | ❌ descriptor.skills.mcp 空，无 MCP 注入 | ❌ Phase 3（clowder-ai buildCatCafeMcpArgs） |
| per-node rules/identity | ✅ L0Injector | — |
| 即插即用/即删即弃 | 有 POST /api/agents 建 + .../new 新会话；无 DELETE | ❌ 无删节点路由+UI；建需脚手架 agents/\<id\>/{identity,rules,memory} |
| web 加节点 | 无 UI | ❌ 加节点面板（选 CLI→填配置→生成 JSON+目录） |
| 拖动节点 | 无 react-flow | ❌ 未装 @xyflow/react，无 Graph 画布 |
| AgentRouter | 单节点直连 | ❌ 读 graph.json 拓扑串/并行调度 |

下一步优先级：① 多 provider（claude/opencode/gemini）② web 加/删节点 ③ Graph 画布 @xyflow/react ④ AgentRouter ⑤ per-node skills/MCP。
骨架（注册表 + NodeDescriptor 数据驱动）已铺好，全是加法不重写。

## 文档更新纪律

每完成一个任务：
1. 勾选上方对应 checkbox（`[ ]` → `[x]`）
2. 在"已完成"区追加一行：`- [日期] 任务号 - 简述`
3. 更新该 Phase 的"状态"行
