# CLI 节点存储契约

## 节点私有存储

每个节点固定使用三类目录：

```text
agents/<provider>/<local-id>/
├── node.json
├── config/
│   ├── identity.md
│   └── rules/
├── runtime/
│   └── active-session.json
└── data/
    └── cli/
        └── <provider-native-home>/
```

- `config/` 是平台维护、可提交 Git 的身份与规则。
- `runtime/` 是平台运行状态，`active-session.json` 只保存当前 session ID。
- `data/cli/` 是 CLI 原生 home。其内部目录是 CLI 私有格式，不得重命名或手工归并。
- descriptor 的配置、运行状态和 CLI 数据路径必须分别位于上述对应目录。绝对 C 盘路径、`..` 越界路径、其他节点目录和共享区路径都必须拒绝。

节点在 API、WebSocket 和前端状态中使用 canonical `nodeKey = provider:localId`。不同 provider 可以复用同一 `localId`；同一 provider 内 `localId` 唯一，显示名也按忽略大小写唯一。重复创建返回 HTTP `409`。`provider` 与 `localId` 创建后不可修改。

| Provider | CLI home | 原生会话位置 | 必需环境变量 |
|---|---|---|---|
| Codex | `data/cli/.codex` | `.codex/sessions/**/*.jsonl` | `CODEX_HOME` |
| Claude | `data/cli/.claude` | `.claude/projects/**/*.jsonl` | `CLAUDE_CONFIG_DIR` |
| OpenCode | `data/cli/.opencode` | `.opencode/data/opencode/opencode.db` | `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` |

三种 provider 还必须把 `TEMP`、`TMP` 和 `TMPDIR` 指向各自 home 下的 `tmp/`。invoke、resume、session list 和 transcript reader 必须使用同一原生数据源，禁止回退到用户全局目录。

Windows 下 OpenCode 必须解析 npm shim 并直接 spawn `opencode.exe`，否则外层 cmd 可能提前退出并留下持锁进程。

## 布局迁移

API 启动时按顺序将 v1/v2 扁平节点迁移到 `schemaVersion: 3`：

- `identity.md`、`rules/` 移入 `config/`。
- `sessions/active.json` 移为 `runtime/active-session.json`。
- `memory/<provider-home>` 整体移入 `data/cli/`，内部层级保持不变。
- 迁移可重复执行；目标已存在且内容冲突时停止启动并报告源、目标路径，绝不覆盖。
- descriptor 在数据移动完成后原子更新。只删除已经没有数据的旧目录。
- v2 的 `agents/<local-id>.json` 与 `agents/<local-id>/` 整体迁入 `agents/<provider>/<local-id>/node.json`。
- Windows 因正在运行的 CLI 锁定 home 时，节点以 `migrationPending` 兼容态继续读取旧路径，不返回 404；后续访问自动重试。只有 `EPERM/EBUSY` 可进入该状态，真实目录冲突仍隔离节点。

从用户全局 home 导入历史数据仍使用：

```powershell
pnpm migrate:cli-memory
pnpm migrate:cli-memory -- --apply
```

导入脚本默认 dry-run，且永不删除全局源数据。

## 共享数据扩展边界

共享能力尚未实现，预留的唯一根为：

```text
shared/project/                 # 项目内全部节点
shared/teams/<team-id>/         # 指定节点组
```

每个共享作用域未来仍使用 `config/`、`data/knowledge/`、`data/artifacts/`、`runtime/` 分层。共享区只允许知识和任务产物，不允许放置任何节点的 CLI home、原生 session、transcript 或凭据。

当前代码不得自行创建或写入 `shared/`。未来必须在权限检查、并发写入和共享存储服务落地后，才能启用 `project` 或 `team:<id>` scope。

## Git 与未安装 Provider

- 节点 `config/` 可跟踪；`runtime/` 和整个 `data/cli/` 必须忽略。
- 未来共享区的 `runtime/` 与 `artifacts/` 默认忽略；人工维护的 `config/`、`knowledge/` 可跟踪。
- Gemini 当前仅保留未安装 stub，不实现 home、transcript 或迁移代码。
- 新 provider 启用前必须证明所有可写路径都在节点 `data/cli/` 内，并覆盖路径越界、history/resume 和本机 CLI 冒烟测试。
