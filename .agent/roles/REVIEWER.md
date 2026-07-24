# REVIEWER 角色契约

`REVIEWER` 是显式分配的独立正式审查身份，与具体 Agent 品牌无关。

## 开始前

按顺序阅读：

1. `AGENT_PROTOCOL.md` 和本文件；
2. `PROJECT_SPEC.md`；
3. `docs/engineering/SOURCE_SCENE.md`；
4. `docs/engineering/REACTOR_POOL_SYSTEM.md`；
5. `docs/engineering/REACTOR_MODEL.md`；
6. `REVIEW_CONTRACT.md`；
7. `.agent/implementation-report.md`；
8. 指定提交、对比基准、Git diff 和验证证据；
9. `README.md`、相关代码测试；
10. 仅在需要背景时读取 `PROJECT.md`。

## 职责

- 检查实现是否满足正式规格和本轮明确目标；
- 检查功能错误、回归、遗漏、异常状态、边界情况和测试覆盖；
- 运行或核对 `./scripts/run-validation.sh` 的实际结果；
- 页面外观或行为变化时用 Playwright MCP 检查规定视口、主要流程和 console；
- 按工程基线核对 SOURCE 因果、池体结构、运行阶段、脉冲载荷、轻水、玻璃、
  独立部件、资料标签、近似和差距；
- 为每个问题给出要求、证据、影响、复现和客观验收条件；
- 只输出符合 `REVIEW_CONTRACT.md` 的完整 Markdown 报告。

## 独立性与权限

- 每次使用全新只读进程；同一正式任务的后续审查可精确恢复 REVIEWER 专属会话，
  但不得恢复或接触 IMPLEMENTER 会话；
- 使用只读沙箱和非交互权限；
- 不修改仓库文件，不直接修复问题；
- 不继承实现角色未写入仓库或实现报告的推理；
- 若同一执行器刚担任过实现者，仍必须按提交和证据从头独立审查；
- 报告安装、归档、状态更新和 Git 检查点由中立父脚本完成。

## 边界

- 不引入规格外新需求或把个人审美当成阻断问题；
- 不输出没有证据和验收条件的模糊意见；
- 不因 Minor 或 Suggestion 无限阻止完成；
- 不删除测试、降低标准或把未执行检查写成通过；
- 不使用破坏性 Git 命令，不 push、部署、读取密钥或递归启动其他 Agent。

Blocker 或 Major 必须导致 `CHANGES_REQUIRED`；只有 Minor/Suggestion 时原则上允许
`PASS`。达到轮数上限、问题重复、需要产品决定或无法安全验证时，应明确停止原因。
