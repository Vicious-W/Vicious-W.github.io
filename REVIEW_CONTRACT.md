# Codex 审查契约

本文件规定 Codex 正式审查的证据要求、严重等级、固定报告格式和终止条件。所有结论必须关联 `PROJECT_SPEC.md` 或项目所有者本轮明确要求。

## 审查输入与隔离

正式审查至少需要：

- 一个明确的目标提交和对比基准；
- 干净的 Git 工作区；
- `PROJECT_SPEC.md`；
- `.agent/implementation-report.md`；
- `./scripts/run-validation.sh` 的最新结果；
- 与改动相关的代码、diff、测试和浏览器证据。

Codex 使用只读沙箱检查仓库，只允许由外层审查脚本写入审查报告、归档、状态和本地 artifacts。若工作区不干净、目标提交不明确或存在覆盖用户修改的风险，应停止正式审查。

## 严重等级

### Blocker

项目当前不可接受，例如：

- 无法安装现有依赖、构建或启动；
- 核心页面完全不可访问、核心功能不可用或发生严重回归；
- 数据损坏、明确安全问题或会暴露密钥；
- 实现破坏静态部署或需要未声明的后端/线上依赖。

### Major

明显影响项目目标或主要用户流程，例如：

- 主要交互行为错误或关键降级缺失；
- 移动端、平板或桌面端之一明显不可用；
- 浏览器存在影响主要流程的未处理错误或 shader 编译失败；
- 关键修改缺少足以发现回归的验证；
- 明显偏离 `PROJECT_SPEC.md` 的技术路线或当前阶段目标。

### Minor

不阻断核心体验的局部质量问题，例如：

- 非核心样式或小范围响应式异常；
- 局部可访问性问题；
- 次要错误反馈不清；
- 有明确影响的小范围可维护性问题。

### Suggestion

不影响验收的可选改进。Suggestion 不得阻止项目通过，也不得出现在 Required next actions 中。

## 结论规则

完成的正式审查只能输出以下结论之一，并在报告中单独成行：

```text
VERDICT: PASS
```

或：

```text
VERDICT: CHANGES_REQUIRED
```

- 存在 Blocker 或 Major：必须 `CHANGES_REQUIRED`。
- 核心目标未实现、构建失败或主要流程不可用：必须 `CHANGES_REQUIRED`。
- 只有 Minor 或 Suggestion：原则上 `PASS`，但仍需记录问题。
- 无法验证关键验收条件时，说明阻塞原因；若因此无法建立核心目标已满足的合理证据，可判 `CHANGES_REQUIRED`。
- 无法验证非关键事项不能自动导致失败。
- 主观美感由项目所有者决定；除非违反明确反馈或可测要求，不能以审查者偏好判失败。

## 单个问题的必填字段

每个问题使用稳定编号（如 `R-001`），并包含：

1. 标题；
2. Severity；
3. Requirement；
4. Evidence；
5. Location；
6. Impact；
7. Reproduction；
8. Expected；
9. Actual；
10. Acceptance criteria；
11. Suggested direction（可选且不得代替实现者决策）。

禁止用“继续优化体验”“代码可以更优雅”“页面更现代”“建议继续重构”等模糊措辞充当问题，除非同时给出对应要求、证据、影响和可验证验收条件。

## 固定报告格式

`.agent/latest-review.md` 必须使用以下结构；没有问题的等级写 `None.`，不得省略章节。

```markdown
# Codex Review

## Review metadata

- Reviewed commit: <full sha>
- Compared against: <full sha>
- Review date: <ISO-8601>
- Specification: PROJECT_SPEC.md
- Validation command: ./scripts/run-validation.sh
- Scope: <本轮范围>
- Working tree: clean

VERDICT: PASS

## Executive summary

<是否达到目标、是否有阻塞问题、本轮最重要发现。>

## Blocker

None.

## Major

None.

## Minor

None.

## Suggestions

None.

## Validation results

- Dependency check:
- Build:
- Tests:
- Lint:
- Type check:
- Browser console:
- Responsive checks:
- Main user flow:
- Other:

## Confirmed working

<已用证据确认的内容。>

## Unverified areas

<因环境、网络、浏览器或其他原因无法验证的内容。>

## Required next actions

None.
```

问题条目模板：

```markdown
### R-001: <问题标题>

- Severity: Blocker | Major | Minor | Suggestion
- Requirement: <PROJECT_SPEC.md 小节或所有者明确要求>
- Evidence: <命令、日志、截图、console、diff 或可重复观察>
- Location: <文件、组件、区块或交互>
- Impact: <用户或项目影响>
- Reproduction:
  1. <步骤一>
  2. <步骤二>
  3. <观察结果>
- Expected: <正确结果>
- Actual: <当前结果>
- Acceptance criteria: <修复后如何客观验证>
- Suggested direction: <可选方向>
```

## 验证记录规则

- `PASS` 只表示实际执行且满足条件。
- 项目没有对应命令时写 `NOT CONFIGURED`。
- 环境不允许执行时写 `UNVERIFIED` 并说明原因。
- 执行失败时写 `FAIL` 并引用日志路径或关键错误。
- 网页外观或行为发生改变时，必须用 Playwright MCP 检查 `390 × 844`、`768 × 1024`、`1440 × 900`，并记录 console 与主要流程结果。
- 截图和日志可保存在忽略的 `.agent/artifacts/`，报告内只引用路径和必要摘要。

## 归档与终止

- 每次完成审查后，同时更新 `.agent/latest-review.md` 并在 `.agent/review-history/` 新增不可改写的归档。
- Claude Code 不得修改历史审查；Codex 不得重写旧历史，只能在新报告中说明旧问题状态。
- 最大自动协作轮数为 3；`agent-cycle.sh cycle` 按“Claude 实现 → 验证 → 本地提交 → Codex 只读审查”严格串行运行，PASS、达到轮数、相同问题反复、需要产品决策或任何流程错误时立即停止。
- 达到最大轮数、连续两轮出现同一未解决问题、需要改变目标或产品决策、需要凭据/付款/外部授权、验证环境不可靠、Git 状态不安全时，停止并交还项目所有者。
