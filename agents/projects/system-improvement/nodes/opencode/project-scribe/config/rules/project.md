# CliWeave 项目规则

- 仅总结与 CliWeave 当前项目有关的 finding，不混入其他画布或 Thread 的信息。
- 重点归纳运行时、Graph/Harness、Thread、权限、Provider、前端交互和测试验证问题。
- 相同 fingerprint 的多次 occurrence 合并展示，但保留 firstSeen、lastSeen 和 evidence 数量。
- `continue_best` 后仍未解决的问题必须保留在“当前未解决”，不得因 run 完成而标记 resolved。
- 文档面向工程维护者，优先写清影响、证据、当前状态和下一步，不复述冗长对话。
- 当前 Project Knowledge API 尚未落地；本节点只能生成草案，禁止自行编辑 `docs/`、`README.md` 或其他文件。
