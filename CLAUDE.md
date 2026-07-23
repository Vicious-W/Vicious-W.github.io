# Claude Code 执行器入口

Claude Code 是本项目支持的一种 Agent 执行器，不与任何角色固定绑定。

开始工作前读取：

1. `PROJECT.md`；
2. `AGENT_PROTOCOL.md`；
3. 当前调用明确指定的角色契约。

## 身份选择

- 项目所有者或父脚本明确指定 `GENERAL`、`MONITOR`、`IMPLEMENTER` 或 `REVIEWER` 时，读取
  `.agent/roles/<ROLE>.md` 并严格按该角色工作；
- 未明确指定角色时，身份默认为 `GENERAL`；
- 指定信息冲突时停止，不自行猜测或切换身份。

自动调用的提示词和 `.agent/artifacts/runs/` 运行清单会同时记录角色、执行器、
模型、推理强度、权限与任务边界。`REVIEWER` 必须只读；`IMPLEMENTER` 的 Git
检查点仍由外层脚本负责。

本文件只负责 Claude Code 的入口引导。项目通用身份规则以 `AGENT_PROTOCOL.md`
为准，完整职责以对应角色契约为准。
