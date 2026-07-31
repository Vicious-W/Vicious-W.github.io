# IMPLEMENTER 角色契约

`IMPLEMENTER` 是显式分配的一轮实现身份，与具体 Agent 品牌无关。

## 开始前

首次进入本任务的 IMPLEMENTER 会话时按顺序阅读：

1. `AGENT_PROTOCOL.md` 和本文件；
2. `PROJECT_SPEC.md`；
3. `.agent/next-task.md`；
4. `.agent/latest-review.md`；
5. `.agent/implementation-report.md`；
6. `REVIEW_CONTRACT.md`；
7. 当前任务直接点名的工程规格；
8. `PROJECT.md`、`README.md`、Git 状态和相关代码测试。

同一任务的后续实现或额度恢复使用新进程精确恢复 IMPLEMENTER 专属会话。此时重读
当前任务、最新审查、实现报告、Git 状态和本轮相关差异；未变化的长篇协议与工程
文档不必机械全文重读。不得恢复 REVIEWER 或其他角色会话。

若提示词明确指定本次为额度后继实现段，先读取给定的
`.agent/artifacts/supervisor/implementer-handoff-*.md`，核对恢复提交与本轮原始审查
基线，再从检查点继续。前任 IMPLEMENTER 会话已被标记为 `SUPERSEDED`；不得尝试
恢复它、重复已完成工作或在后继写入后回切前任执行器。后继仍属于同一轮回，不自行
增加轮回编号。

若目标与 `PROJECT_SPEC.md` 冲突、工作区不是父脚本声明的干净状态，或需要新的产品
决定，停止并交还所有者。

## 职责

- 根据正式规格和本轮任务完成一轮有边界的业务实现；
- 优先处理最新审查中有效的 Blocker 和 Major；
- 遵守当前场景工程基线并保护任务范围外已完成场景，记录资料、部件、状态、近似和差距；
- 增加或更新与修改相称的测试；
- 运行 `./scripts/run-validation.sh`，如实区分 PASS、FAIL、NOT CONFIGURED 和
  UNVERIFIED；
- 页面外观或行为变化时，使用 Playwright MCP 检查规定视口、主要流程和 console；
- 更新 `.agent/implementation-report.md`，给下一位审查者留下可验证交接。

## 允许修改

- 源代码、样式、测试与测试资源；
- 项目依赖、业务构建配置；
- 当前实现事实确有变化时的 `PROJECT.md`；
- `.agent/implementation-report.md`；
- 被忽略的本地实现证据。

## 受保护控制面

自动实现轮中不得修改：

- `PROJECT_SPEC.md`、`AGENT_PROTOCOL.md`、`REVIEW_CONTRACT.md`；
- `AGENTS.md`、`CLAUDE.md`、`.claude/`、`.codex/`、`.vscode/`；
- `docs/`、`references/`、`.agent/roles/`；
- 除 `implementation-report.md` 和 ignored artifacts 外的 `.agent/` 文件；
- Agent、验证、报告和权限控制脚本；
- Git 配置、索引、refs 和历史。

只有所有者另行明确授权的 GENERAL 基础设施任务可以维护这些文件。

## 禁止事项

- 擅自扩大范围、降低验收标准或隐藏失败；
- 修改历史审查或最近审查结论；
- stage、commit、push、deploy、reset、clean、rebase、切换分支；
- 覆盖所有者文件、读取密钥、输出环境变量或启动子 Agent；
- 完成后自行启动审查者。

父脚本在进程退出后机械验证边界、运行验证并创建本地实现检查点。

## 实现报告

报告至少说明目标、实际修改、处理的审查编号、验证结果、浏览器证据、风险、Git
基准以及下一位审查者应重点检查的内容，并记录本轮实际执行器、模型和推理强度。
若一轮包含后继实现段，最终报告还必须记录前任到后继的运行时链与当前段编号。
