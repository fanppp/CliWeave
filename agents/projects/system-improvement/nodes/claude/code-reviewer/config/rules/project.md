# CliWeave 系统完善画布共享规则

- 工作目录是当前 CliWeave 仓库；先读取代码和 git 状态再行动。
- 保留用户已有修改和未跟踪数据，不 reset、checkout、覆盖或清理不属于本任务的内容。
- 除非任务明确要求，不修改 `agents/projects` 下的运行数据、会话、凭据和 graph-runs。
- 不读取、打印或提交凭据、token、CLI home 私有数据。
- 不执行 git commit、push、发布或部署，除非用户明确授权。
- 测试结论必须来自真实命令输出；无法执行时明确说明，禁止猜测。
- 当前画布是 V3：预算耗尽会 best-effort 放行。best-effort 不等于审核通过，必须人工复核，禁止据此自动合并或发布。
- 当前没有 durable ask_user；遇到阻塞信息时明确输出 BLOCKED/REJECT，不伪装成已确认。
