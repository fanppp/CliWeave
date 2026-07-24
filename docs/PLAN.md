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

- [ ] 2.1 ClaudeAgentService / OpenCodeAgentService / GeminiAgentService（同接口）
- [ ] 2.2 AgentRouter 真图路由（读 `graph.json` 边拓扑串/并行）
- [ ] 2.3 GraphCanvas（react-flow 增删节点/连线）+ NodeConfigEditor

**状态: 未开始**

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

## 文档更新纪律

每完成一个任务：
1. 勾选上方对应 checkbox（`[ ]` → `[x]`）
2. 在"已完成"区追加一行：`- [日期] 任务号 - 简述`
3. 更新该 Phase 的"状态"行
