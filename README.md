# cliograph

> 可插拔多 CLI Agent 节点 + Graph 画布协作平台。
> 把 codex / claude / opencode 等 CLI 工具变成画布上的节点，连线成拓扑，按拓扑序串行协作（A 的输出 → B 的输入）。

名字取自 **cli** + **graph**：用 CLI 作为节点，在画布上织成一张协作图。

每个节点 = 一个 CLI 工具实例，自带**项目内私有 CLI 数据**（session / 记忆 / auth）、**身份 identity**、**规则 rules** 和 **prompt 注入**。在网页画布上增删节点、连线、运行，节点间按拓扑结构相互通信。

---

## 特性

- **多 CLI 节点**：codex / claude / opencode 已验证可用；gemini 保留 stub（本机安装后即用）。加新 CLI = 写一个 provider 类 + 注册。
- **Graph 画布**（@xyflow/react）：拖动节点、连线成拓扑、加/删节点、原子持久化到 `agents/graph.json`。
- **AgentRouter**：从 input 节点起拓扑串行执行，上游最终输出（过滤 `[notice]`）+ 原始需求作为下游 prompt。
- **per-node 隔离**：每个节点的 CLI 数据（CODEX_HOME / CLAUDE_CONFIG_DIR / opencode XDG）全部落在项目内 `agents/<provider>/<id>/data/cli/`，不污染全局；auth 从全局 copy-on-missing。
- **记忆单一真相源 = CLI 自己的 transcript**：历史直接读 codex/claude/opencode 的会话文件，不另存。
- **图运行历史**：per-run jsonl（`agents/graph-runs/<runId>.jsonl`，含图结构快照），可重放、可回看任意 run。
- **停止按钮**：节点级 / 图级 abort，AbortController 杀子进程，fail-fast。
- **会话自愈**：resume 陈旧 session 失败时自动回退全新会话，不卡死。
- **per-node mutex**：同一节点同时只允许一个调用，防 CLI session 串写。
- **执行可视化**：执行中节点边缘闪光 + 「执行中」角标，支持多节点同时执行（M4 fan-out 铺路）。
- **节点编辑**：点节点 → 右侧编辑 identity / rules，保存即生效（下次 invoke 重新编译 L0）。

## 快速开始

```bash
pnpm install
pnpm dev          # 同时启动 web + api
```

- web: http://localhost:3000
- api: http://localhost:3004

前置：本机装有 [codex](https://github.com/openai/codex) / [claude code](https://docs.anthropic.com/claude-code) / [opencode](https://opencode.ai) 之一，并已登录（首次运行会从全局 `~/.codex` 等复制 auth）。

## 用法

1. 打开 http://localhost:3000，顶部切「图运行」。
2. 画布上「+ 加入节点」选 agent → 拖动排列 → 拖节点 handle 连线成拓扑（input → A → B）。
3. **输入节点**（🟰 输入）框内输入需求 → 发送 → 按拓扑顺序触发各 CLI 协作，右侧流式显示各节点输出。
4. 点任一 agent 节点 → 右侧切到该节点的 identity/rules 编辑；运行流也按该节点过滤。
5. 「运行历史」可回看任意一次 run（含图快照，重放不失真）。

## 架构

```
[Web] GraphCanvas(@xyflow) ──PUT /api/graph──▶ [API]
                                                  │ readGraph() (agents/graph.json)
                                                  ▼
                                            AgentRouter.executeGraph
                                                  │ 拓扑序: __input__(伪) → agent1 → agent2
                                                  ▼
                                  buildAgent(nodeKey).invoke(prompt)   ← 复用 provider
                                                  │ AgentMessage 流 (带 nodeKey)
                                                  ▼
                                  SocketManager → room graph:<runId> → WS graph_message
                                                  ▼
[Web] GraphRunSocketBridge → graphRunStore → GraphRunStream（按节点过滤）+ AgentNode 闪光
```

- `packages/api`（Fastify + socket.io :3004）：AgentRouter、graph 校验、per-node mutex、abort-registry、graph-run-store（历史）、providers（codex/claude/opencode/gemini）。
- `packages/web`（Next.js :3000）：GraphCanvas、GraphRunStream、RunPicker、NodeConfigPanel、SocketProvider（共享连接）。
- `agents/<provider>/<id>/`：每节点 `node.json` + `config/`(identity/rules) + `runtime/`(active-session) + `data/cli/`(CLI 原生 home，gitignored)。

## 节点存储契约

```
agents/<provider>/<localId>/
├── node.json                 # 节点配置（schemaVersion 3，tracked）
├── config/
│   ├── identity.md           # 节点身份（tracked）
│   └── rules/*.md            # 规则（tracked）
├── runtime/
│   └── active-session.json   # 当前活跃会话 id（gitignored）
└── data/cli/.<provider>/     # CLI 原生 home（session/记忆/auth，gitignored）
```

canonical 节点 key = `provider:localId`（如 `codex:codex-node`）。详见 [`docs/CLI_STORAGE.md`](docs/CLI_STORAGE.md)。

## 文档

- [docs/PLAN.md](docs/PLAN.md) — 计划与进度、锁定决策、gap。
- [docs/CLI_STORAGE.md](docs/CLI_STORAGE.md) — 节点存储契约。

## 路线图

- ✅ M1：多 CLI 通信（AgentRouter 串行 + 停止 + 历史落盘）。
- ✅ M2：Graph 画布（@xyflow 拖动/连线/增删）+ graph.json 持久化 + 运行历史重放 + 节点编辑 + 执行可视化。
- 🔜 M3：右侧抽屉式 live 状态、条件边、fan-out 并行 + fan-in reducer、环路。
- 🔜 M4：同 agent 多实例会话隔离、条件路由、动态 handoff。
- 🔜 M5：per-node skills/MCP、worktree 隔离、知识库 sqlite、多图（每图一套节点+拓扑）。

## 局限 / 已知

- gemini：仅 stub，二进制未装。
- opencode 入图运行可能卡死（snapshot/watcher 已缓解未根治），画布可加警告。
- M2 单图；多图为后续目标（数据模型已预留 `graphId` 不存假值）。

## License

MIT
