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
| per-node storage | `config/runtime/data` + `SessionChain`（resume） | `SessionChainStore` + `--resume` |
| Graph 编排 | `AgentRouter`（读 `graph.json` 边，拓扑串/并行） | `AgentRouter.routeExecution` |

## 目录结构

```
0AgentTeams/
├── agents/                      节点配置 = 数据（codex 可自改/自增）
│   ├── codex-node.json          NodeDescriptor
│   ├── codex-node/
│   │   ├── config/              可版本控制的节点配置
│   │   │   ├── identity.md      该节点人设（L0 prompt）
│   │   │   └── rules/*.md       该节点规则
│   │   ├── runtime/             平台运行状态（Git ignore）
│   │   └── data/cli/            CLI 原生 home（Git ignore）
│   └── graph.json               显式静态图（边 from→to）〔Phase 2〕
├── shared/                       共享数据保留根（尚未启用）
│   ├── project/                  项目级 scope
│   └── teams/<team-id>/          团队级 scope
├── packages/
│   ├── api/   Fastify + socket.io + TS   端口 3004
│   └── web/   Next.js + react-flow + zustand  端口 3000
└── docs/
```

## NodeDescriptor schema (`agents/<id>.json`)

```jsonc
{
  "schemaVersion": 2,
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
  "skills":  { "mcp": [] },        // Phase 3
  "storage": {
    "config": {
      "identityFile": "agents/codex-node/config/identity.md",
      "rulesFiles": ["agents/codex-node/config/rules/*.md"]
    },
    "runtime": {
      "activeSessionFile": "agents/codex-node/runtime/active-session.json",
      "resume": true
    },
    "data": { "cliHome": "agents/codex-node/data/cli/.codex" }
  }
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
`agents/codex-node/config/rules/*.md` → 下次该节点 `L0Injector` 读到新规则 → 行为改变。

## 技术栈

- **web**: Next.js 14 (App Router) + React 18 + zustand + socket.io-client
  + @xyflow/react（Phase 2 节点画布）
- **api**: Fastify + socket.io + TypeScript
- **codex**: `codex exec --json --sandbox danger-full-access --full-auto`
  （prompt 经 stdin `-- -`）

## per-node 记忆全部存在本项目里

已安装的 Codex、Claude、OpenCode 分别通过 `CODEX_HOME`、`CLAUDE_CONFIG_DIR` 和完整 XDG 环境把原生会话隔离到 `agents/<node>/data/cli/`。平台活动会话指针位于 `runtime/active-session.json`；显示、列表和 resume 都直接使用 CLI 原生 transcript/数据库，保持单一真相源。

共享数据未来位于独立的 `shared/project` 与 `shared/teams/<team-id>` scope，只共享知识和产物，不共享节点原生会话。当前仅保留路径契约，不创建目录或开放读写。

完整目录、迁移和未安装 provider 的接入红线见 [CLI_STORAGE.md](./CLI_STORAGE.md)。Gemini 当前只是未验证 stub，不计入已实现 provider。

## 工程红线（clowder-ai 踩坑）

1. **Windows spawn**: Codex/Claude 的脚本 shim 可使用 shell；OpenCode 必须解析 npm shim 并直接 spawn 原生 `opencode.exe`。禁止对 OpenCode 使用 `shell:true`，否则 cmd 退出后可能遗留持锁进程。
2. **prompt 经 stdin**: `-- -` 让 codex 从 stdin 读，防 `ps` 泄露对话。
3. **stderr 不外泄**: 含 thinking / 密钥，只缓冲日志，不 yield 给前端。
4. **codex exit-1 抑制**: 0.98+ 成功后也 exit 1，有实质输出则抑制。
5. **socket.io 路径**: Next rewrites 要代理 `/socket.io/`（含 ws 升级），
   否则 WS 握手失败。
