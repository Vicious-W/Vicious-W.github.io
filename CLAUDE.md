# Claude Code 项目规则

本项目采用“Claude Code 实现、Codex 独立审查”的双 Agent 协作模式。你是本项目唯一被授权修改业务代码的 Agent。

## 每轮开始前

按顺序阅读：

1. `PROJECT_SPEC.md`：唯一正式的目标、范围与验收来源；
2. `docs/engineering/SOURCE_SCENE.md`：SOURCE 连续运行、轻水、玻璃和跨系统物理基线；
3. `docs/engineering/REACTOR_POOL_SYSTEM.md`：完整反应堆池、环境设备和连续运行基线；
4. `docs/engineering/REACTOR_MODEL.md`：反应堆工程设计基线和差距清单；
5. `REVIEW_CONTRACT.md`：审查问题的等级、证据和验收约定；
6. `.agent/latest-review.md`：最近一轮 Codex 审查；
7. `.agent/implementation-report.md`：上一轮实现交接；
8. `PROJECT.md`：技术决策与当前状态；
9. `README.md`：项目目录地图；
10. 当前 Git 状态、与本轮任务直接相关的代码和测试。

开始修改前必须确认工作区中哪些改动属于项目所有者，不得覆盖或删除未提交修改。若目标与 `PROJECT_SPEC.md` 冲突或需要新的产品决定，停止并询问项目所有者。

## 职责

- 根据 `PROJECT_SPEC.md` 和所有者本轮明确目标实现功能；
- SOURCE 修改必须符合 `docs/engineering/SOURCE_SCENE.md`，并在实现报告中记录
  连续运行状态、复位规则、水体耦合、玻璃损伤/破碎、声音激活边界、所用近似和
  未关闭的决策；
- 反应堆池修改必须符合 `docs/engineering/REACTOR_POOL_SYSTEM.md`，逐项记录
  `RP-*` 部件、结构连接、设备状态、脉冲载荷路径、资料标签和未关闭差距；
- 反应堆修改必须符合 `docs/engineering/REACTOR_MODEL.md`，并在实现报告中逐项记录
  资料、部件、状态、近似和仍未关闭的差距 ID；
- 修复最新审查报告中的有效问题，优先处理 Blocker 和 Major；
- 选择简单、可维护且符合现有技术路线的实现；
- 必要时增加或更新测试、配置、构建脚本和项目文档；
- 运行 `./scripts/run-validation.sh`，不得把 `NOT CONFIGURED` 描述为通过；
- 对页面外观或行为的改动，必须启动本地 Vite 服务并使用 Playwright MCP 实际渲染，检查桌面、平板、移动视口和浏览器 console；不得用 Bash Playwright 脚本替代；
- 只有当前实现事实、技术结构或下一步发生变化时才精简更新 `PROJECT.md`；
- 完成后更新 `.agent/implementation-report.md`，写清 Git 边界并停止，等待 Codex 审查。

## 允许修改

- 源代码与样式；
- 测试与测试资源；
- 项目配置、构建脚本与依赖；
- `PROJECT.md` 中的当前状态、技术决策与追加式日志；
- `.agent/implementation-report.md`；
- 被 `.gitignore` 忽略的本地实现证据。

通过 `run-implementation.sh` 自动运行时，协作协议、权限配置、轮次状态、
审查报告和 Agent/验证控制脚本属于受保护控制面，只有外层中立脚本或项目所有者
明确授权的基础设施维护轮次可以修改。外层脚本负责验证、暂存和本地提交；Claude
不拥有 Git 提交权。

## 禁止事项

- 擅自修改项目最终目标、扩大范围或降低验收标准；
- 删除失败测试、隐藏错误或把未执行检查写成通过；
- 在没有证据的情况下忽略 Blocker 或 Major；
- 修改或删除 `.agent/review-history/` 中的 Codex 历史审查；
- 直接改写 `.agent/latest-review.md` 的审查结论；
- 修改 `.agent/state.env`、`.agent/next-task.md`、权限配置或 Agent 控制脚本；
- 修改 `docs/` 方法/指南、`references/` 所有者参考或 `.vscode/` 共享结构设置，
  除非所有者明确授权基础设施维护；
- 使用破坏性 Git 命令覆盖用户修改；
- 自动 push、force push、部署或执行无限重试循环。

## 每轮结束交接

`.agent/implementation-report.md` 必须说明：

- 本轮目标；
- 修改了什么以及为什么；
- 对应处理了哪些审查编号；
- 运行了哪些构建、测试、lint、类型检查和浏览器验证；
- 每项验证是通过、失败、未配置还是未验证；
- 尚未解决的问题与风险；
- 基准提交、结果提交或当前工作区状态；
- 下一轮 Codex 应重点检查什么。
