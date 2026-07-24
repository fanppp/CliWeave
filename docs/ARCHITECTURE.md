# 架构

> 借鉴 D:\000agent\opensource\clowder-ai 的核心抽象，去掉生产级模块
> （Redis / OTel / MCP / 记忆库 / A2A 球权 / audit / liveness），
> 保留正确的可扩展骨架。

## 大局观

以"**配置驱动的 Agent 节点**"为核心。每个节点是一份数据
（`agents/<id>.json`），不是硬编码 service。加任意 CLI = 加 1 个
provider 类 + 1 个 JSON 文件，零改路由 / UI。Agent 能写 JSON 给自己加邻居
（元能力）。

## 五大核心抽象

| 需求 | 抽象 | 借鉴 clowder-ai |
|------|------|----------------|
| 任意 CLI 是节点 | `AgentService.invoke(prompt,opts): AsyncIterable<AgentMessage>` | `domains/cats/services/types.ts` |
| 节点配置 | `NodeDescriptor` (`agents/*.json`) | `cat-catalog.json` |
| per-node prompt/rules | `L0Injector`（identity+rules → developer_instructions / system prompt） | `l0-compiler` + `compileDeveloperInstructionsArgs` |
| per-node skills | 能力注册表（`descriptor.skills` → MCP 注入）〔Phase 3〕 | `buildCatCafeMcpArgs` |
| per-node memory | `SessionChain`（resume）〔Phase 1〕 + 知识库 sqlite 〔Phase 3〕 | `SessionChainStore` + `--resume` |
| Graph 编排 | `AgentRouter`（读 `graph.json` 边，拓扑串/并行） | `AgentRouter.routeExecution` |

## 目录结构

```
0AgentTeams/
├── agents/                      节点配置 = 数据（codex 可自改/自增）
│   ├── codex-node.json          NodeDescriptor
│   ├── codex-node/
│   │   ├── identity.md         该节点人设（L0 prompt）
│   │   ├── rules/*.md           该节点家规
│   │   └── sessions/            per-node 会话链（resume）
│   └── graph.json               显式静态图（边 from→to）〔Phase 2〕
├── packages/
│   ├── api/   Fastify + socket.io + TS   端口 3004
│   └── web/   Next.js + react-flow + zustand  端口 3000
└── docs/
```

## NodeDescriptor schema (`agents/<id>.json`)

```jsonc
{
  "id": "codex-node",
  "name": "Codex",
  "provider": "codex",              // 选哪个 AgentService 实现
  "cli": {
    "command": "codex",
    "baseArgs": ["exec","--json","--sandbox","danger-full-access","--full-auto","--add-dir",".git"],
    "promptVia": "stdin",           // stdin / argv
    "cwd": "${PROJECT_ROOT}"
  },
  "model": "gpt-5",
  "prompt":  { "identity": "agents/codex-node/identity.md" },
  "rules":   { "files": ["agents/codex-node/rules/*.md"] },
  "skills":  { "mcp": [] },        // Phase 3
  "memory":  { "session": { "resume": true, "dir": "agents/codex-node/sessions" } }
}
```

## 数据流（Phase 1 单节点路径）

```
Web input@codex-node ─POST /api/messages {content,nodeId}─▶ API
  → NodeDescriptor 读 agents/codex-node.json
  → AgentServiceFactory.build() = L0Inject(identity+rules) + SessionChain.resume
  → CodexAgentService.invoke(prompt)
       (cwd=项目根, --sandbox danger-full-access, prompt 经 stdin)
  → spawnCli → parseNDJSON → transformCodexEvent → AgentMessage
  → SocketManager.broadcast(msg, nodeId)
  → Web socket.on('agent_message') → 渲染
```

**自修改闭环**：codex 子进程 `cwd=项目根` + `--sandbox danger-full-access`，
能读写 web/api 自己的源码。用户输入"把输入框改宽"→ codex 编辑
`ChatInput.tsx` → Next HMR 即时生效。codex 编辑
`agents/codex-node/rules/*.md` → 下次该节点 `L0Injector` 读到新规则 → 行为改变。

## 技术栈

- **web**: Next.js 14 (App Router) + React 18 + zustand + socket.io-client
  + @xyflow/react（Phase 2 节点画布）
- **api**: Fastify + socket.io + TypeScript
- **codex**: `codex exec --json --sandbox danger-full-access --full-auto`
  （prompt 经 stdin `-- -`）

## per-node 记忆全部存在本项目里

每个节点的 CLI 记忆落在 `agents/<node>/memory/.codex/`（项目内），不进全局 `~/.codex`：
- `sessions/.../rollout-<ts>-<sessionId>.jsonl` —— 完整对话 transcript（真实记忆）
- `auth.json` / `config.toml` —— 首次从全局 `~/.codex` copy-on-missing（之后 codex 自刷新 token）

实现：`CodexAgentService` spawn 时设子进程 env `CODEX_HOME=agents/<node>/memory/.codex`，
`ensureCodexHome()` 建目录+复制 auth/config。`codex-transcript.ts` 从该 per-node home 读 transcript。
`SessionChain.active.json` 记当前 sessionId，resume 用它 → 显示=真实记忆，单一真相源。

## 工程红线（clowder-ai 踩坑）

1. **Windows spawn**: codex 是 `codex.ps1`，`spawn('codex')` 会 ENOENT。
   需解析 shim 到 `node <script>` 或 `shell:true`（照搬 `cli-spawn-win.ts`）。
2. **prompt 经 stdin**: `-- -` 让 codex 从 stdin 读，防 `ps` 泄露对话。
3. **stderr 不外泄**: 含 thinking / 密钥，只缓冲日志，不 yield 给前端。
4. **codex exit-1 抑制**: 0.98+ 成功后也 exit 1，有实质输出则抑制。
5. **socket.io 路径**: Next rewrites 要代理 `/socket.io/`（含 ws 升级），
   否则 WS 握手失败。
