# 0AgentTeams

可配置多 CLI Agent 节点 + Graph 编排的协作平台。每个节点 = 一个 CLI 工具
（当前已验证 codex / claude / opencode；gemini 仅保留未安装 stub），自带私有 CLI 数据、skills、rules 和 prompt。

CLI 节点的配置、平台运行状态和 CLI 原生数据分别保存在 `config/`、`runtime/`、`data/cli/`，详细约束见 [`docs/CLI_STORAGE.md`](docs/CLI_STORAGE.md)。
网页可向节点发消息、实时显示流式回复；节点（如 codex）能直接改写项目自身。

## 快速开始

```bash
pnpm install
pnpm dev          # 同时启动 web + api (pnpm -r --parallel run dev)
```

- web: http://localhost:3000
- api: http://localhost:3004

## 文档

- 架构: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 计划与进度: [docs/PLAN.md](docs/PLAN.md)

## 设计目标

1. **基础功能**: 网页输入框 + 按钮 → 消息送 codex CLI → 实时显示流式回复。
   网页能给自身提需求（如"输入框大一点"），codex 改 web 文件，刷新即生效。
2. **最终目标**: 网页可增删任意 CLI 节点，每个节点是一个 Agent，由 Graph 组织。
   codex / claude / opencode 等 CLI 分别集成并相互通信。
