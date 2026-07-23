# 双 Agent 协作目录

本目录是 Claude Code（实现者）与 Codex（审查者）之间的正式交接面。临时聊天不是项目状态来源。

面向项目所有者的命令速查位于
`docs/guides/PROJECT_COMMAND_MANUAL.md`；本文件只解释双 Agent 交接面本身。

## 文件职责

- `latest-review.md`：Codex 最近一次正式审查；由 Codex/审查脚本替换。
- `implementation-report.md`：Claude Code 最近一轮实现报告；由 Claude Code 更新。
- `state.env`：简单、无密钥的轮次状态；核心协议文件，需要纳入 Git。
- `review-history/`：每次完成审查的只追加归档；需要纳入 Git，Claude Code 不得修改旧文件。
- `artifacts/`：验证日志、浏览器截图和审查过程日志；属于本地生成物，由 `.gitignore` 忽略。

## 默认自动流程

项目所有者确认 `.agent/next-task.md` 中的阶段目标后，只需在干净工作区运行：

```bash
./scripts/agent-cycle.sh preflight
./scripts/agent-cycle.sh cycle
```

第一条只检查 Git、CLI 登录、Playwright MCP、权限配置、npm 依赖和本地提交能力，绝不启动 Agent。第二条会再次预检，然后严格串行执行：Claude Code 实现 → 自动验证 → 本地 Git 检查点 → Codex 只读审查 → 审查报告检查点。`CHANGES_REQUIRED` 时把报告交回 Claude，最多三轮；`PASS` 或任何安全/工具错误时停止。它不会同时运行两个 Agent，不会 push、部署、reset、clean 或无限重试。

## 权限与无人值守边界

- 不给两个 Agent 机器级“全权”。Claude 使用项目级 `dontAsk`：只允许项目内读写、明确列出的 npm/只读 Git/本地预览命令、公开网页检索和 Playwright MCP；任何未预批能力直接拒绝，不弹出人工授权。它不能暂存、提交、push、切分支、reset、clean、rebase、sudo、输出环境变量或另起后台/sub-Agent。
- Git 暂存和本地提交只由中立包装脚本在验证后执行；实现返回后还会检查本地 Git 配置、refs 与预暂存状态。自动提交禁用仓库 hooks 和 GPG 签名提示，push 与部署始终不自动执行。
- Claude 返回后，包装脚本会机械检查 Git 历史和受保护路径。`PROJECT_SPEC.md`、角色规则、权限配置、`.agent/` 控制状态、审查历史及 Agent/验证脚本一旦被越界修改，流程会在验证、暂存和 Codex 启动前停止，并保留现场。
- Codex 使用 `read-only` 沙箱和 `approval_policy="never"`。它不能修改业务文件，也不会等待交互式授权；需要额外权限时直接失败。
- `claude auth status`、`codex login status` 和 Playwright MCP 健康状态在完整 cycle 开始前检查，并在每个对应 Agent 真正启动前复查。Agent 运行所需的 `npx` 缓存固定到专用 Playwright 缓存目录，不需要开放整个主目录或默认 `~/.npm`。
- 非交互进程每 30 秒输出一次心跳。Claude 单轮默认最多 7200 秒，Codex 单轮默认最多 3600 秒，终止宽限 15 秒；可在 `.agent/runtime.env` 调整，但预检会拒绝越界值。
- 子进程失败会分类为 `PERMISSION`、`AUTHENTICATION`、`USAGE_OR_BILLING_LIMIT`、`MCP_OR_BROWSER`、`TIMEOUT` 或普通执行错误，写入忽略的 `.agent/artifacts/runtime/last-stop.env`。任何此类失败都不增加审查轮次，也不会启动下一个 Agent。
- 预检与 Agent 子进程都断开交互式 stdin；预检使用前台 `timeout`，到期后有强制 KILL 宽限，因此在真实 TTY 中也不会因 job-control stopped 状态永久挂起。
- `.agent/.cycle.lock` 会记录父进程 PID 和 Linux 启动时间。真实活动锁阻止第二个流程；进程已消失、PID 被复用或旧版没有元数据时，下次启动会只删除已知锁元数据并安全回收陈旧锁。

不要用 `sudo` 启动流程，不要把 Claude 改成 `bypassPermissions`/交互式权限模式，也不要给 Codex 改成可写审查。权限问题应修复具体的预检项，而不是扩大到整个 WSL、主目录或 GitHub 远端。

运行监控器的无 Agent 烟雾测试：

```bash
./scripts/test-agent-runtime.sh
```

它只启动假的 shell 子进程，模拟成功、权限拒绝、额度失败和超时，并检查活动锁与
陈旧锁处理；不会调用真实 Claude 或 Codex。

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
阅读 PROJECT_SPEC.md、docs/engineering/SOURCE_SCENE.md、
docs/engineering/REACTOR_POOL_SYSTEM.md、docs/engineering/REACTOR_MODEL.md、
CLAUDE.md、REVIEW_CONTRACT.md、PROJECT.md 和 .agent/latest-review.md。
你是唯一实现者。
完成我本轮明确的目标，并修复最新审查中的所有 Blocker 和 Major；不得扩大范围或
降低标准。运行 ./scripts/run-validation.sh；页面外观或行为有变化时用 Playwright
MCP 验证。完成后更新 .agent/implementation-report.md，给出明确 Git 检查点，然后
停止等待 Codex 审查。
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
./scripts/agent-cycle.sh preflight
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

## 预检失败时

先看终端中的失败项和 `.agent/artifacts/preflight/summary.md`。常见情况：

- `authentication`：在普通交互终端分别完成 `claude auth login` 或 `codex login`，再重新预检；不要把令牌写入仓库。
- `Playwright MCP`：确认用户级 `playwright` MCP 已注册；预检会验证 Claude 的实际连接健康和 Codex 的启用状态。
- `.git is not writable`：必须从项目所有者的普通 WSL 终端运行父脚本；不要用一个仍处于只读审查沙箱中的 Agent 启动 cycle。
- `working tree is not clean`：先人工检查并建立安全提交；脚本不会吸收或丢弃既有修改。
- `last-stop.env` 显示权限、认证、MCP 或超时：本轮已安全终止。修复明确原因后由所有者重新启动，不会自动无限重试。
- `USAGE_OR_BILLING_LIMIT`：CLI 已登录，但 Claude/OpenAI 账户的月度用量、余额、计费或速率上限阻止模型调用；必须在对应服务的账户页面处理，扩大项目文件权限无效。
- 启动后长时间看不到 `=== Claude implementation round ... ===`：正常预检通常数秒完成；若曾被强制关闭，直接重新运行即可，父脚本会识别并回收陈旧锁。不要手工删除一个仍属于活动 PID 的锁。

## 当前未配置

- 自动测试；
- lint；
- 类型检查；
- CI；
- 仓库内 Playwright 测试套件。

浏览器验收由两个 Agent 使用环境中的 Playwright MCP 执行；脚本不会用 Bash 自动化冒充 MCP 验证。
