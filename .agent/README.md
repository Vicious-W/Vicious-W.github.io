# 双 Agent 协作目录

本目录是 Claude Code（实现者）与 Codex（审查者）之间的正式交接面。临时聊天不是项目状态来源。

## 文件职责

- `latest-review.md`：Codex 最近一次正式审查；由 Codex/审查脚本替换。
- `implementation-report.md`：Claude Code 最近一轮实现报告；由 Claude Code 更新。
- `state.env`：简单、无密钥的轮次状态；核心协议文件，需要纳入 Git。
- `review-history/`：每次完成审查的只追加归档；需要纳入 Git，Claude Code 不得修改旧文件。
- `artifacts/`：验证日志、浏览器截图和审查过程日志；属于本地生成物，由 `.gitignore` 忽略。

## 默认自动流程

项目所有者确认 `.agent/next-task.md` 中的阶段目标后，只需在干净工作区运行：

```bash
./scripts/agent-cycle.sh cycle
```

脚本会严格串行执行：Claude Code 实现 → 自动验证 → 本地 Git 检查点 → Codex 只读审查 → 审查报告检查点。`CHANGES_REQUIRED` 时把报告交回 Claude，最多三轮；`PASS` 或任何安全/工具错误时停止。它不会同时运行两个 Agent，不会 push、部署、reset、clean 或无限重试。

## 分步入口

### 1. Claude Code 实现

先确保前一轮报告和用户素材已经形成安全 Git 检查点，再在仓库根目录启动：

```bash
claude
```

自动实现一轮可直接运行：

```bash
./scripts/agent-cycle.sh implement
```

该入口读取 `.agent/next-task.md`，Claude Code 完成后由外层脚本运行验证并建立本地提交。交互式 `claude` 仍作为排错或需要产品讨论时的备用方式。

推荐提示：

```text
阅读 PROJECT_SPEC.md、CLAUDE.md、REVIEW_CONTRACT.md、PROJECT.md 和
.agent/latest-review.md。你是唯一实现者。完成我本轮明确的目标，并修复最新审查中的
所有 Blocker 和 Major；不得扩大范围或降低标准。运行 ./scripts/run-validation.sh；
页面外观或行为有变化时用 Playwright MCP 验证。完成后更新
.agent/implementation-report.md，给出明确 Git 检查点，然后停止等待 Codex 审查。
```

### 2. 独立验证

```bash
./scripts/run-validation.sh
```

结果写入 `.agent/artifacts/validation/summary.md`。当前仓库只有 build 命令；测试、lint、类型检查会诚实显示为 `NOT CONFIGURED`。

### 3. Codex 正式审查

确保工作区完全干净且实现已经提交，然后运行：

```bash
./scripts/run-review.sh
```

也可以明确指定目标和基准：

```bash
./scripts/run-review.sh <target-commit> <base-commit>
```

脚本会先运行统一验证，再以只读沙箱启动一次 Codex，更新 `latest-review.md` 并写入 `review-history/`。单独使用时不会自动提交报告；完整 `cycle` 会为报告建立本地检查点后再进入下一轮。

### 4. 查看状态

```bash
./scripts/agent-cycle.sh status
```

其他入口：

```bash
./scripts/agent-cycle.sh validate
./scripts/agent-cycle.sh review
./scripts/agent-cycle.sh archive
./scripts/agent-cycle.sh implement
./scripts/agent-cycle.sh cycle
```

`agent-cycle.sh cycle` 只处理 `.agent/next-task.md` 中经所有者确认的任务，严格串行且最多三轮。新阶段仍必须先由所有者设定目标，脚本不会自行发明或扩展产品范围。

## Git 边界

- Claude Code 修改前读取 `git status`，不得覆盖用户未提交修改。
- Codex 只审查干净工作区中的明确提交；不干净时脚本立即停止。
- 两个 Agent 都不得自动 reset、clean、强制 checkout、rebase、push、部署或删除用户文件。
- 审查完成后的最新报告、历史归档和状态变化应随下一安全检查点纳入 Git。

## 当前未配置

- 自动测试；
- lint；
- 类型检查；
- CI；
- 仓库内 Playwright 测试套件。

浏览器验收由两个 Agent 使用环境中的 Playwright MCP 执行；脚本不会用 Bash 自动化冒充 MCP 验证。
