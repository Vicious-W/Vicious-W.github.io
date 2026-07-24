# Agent 交接与运行状态目录

本目录是角色化 Agent 协作的正式交接面。角色不与 Claude Code 或 Codex 绑定；
共同身份规则见 `AGENT_PROTOCOL.md`，角色契约位于 `roles/`。

## 文件职责

- `roles/GENERAL.md`：默认通用身份；
- `roles/MONITOR.md`：跨额度窗口的只读监督身份；
- `roles/IMPLEMENTER.md`：专用实现身份；
- `roles/REVIEWER.md`：专用独立审查身份；
- `next-task.md`：所有者确认的当前执行切片；
- `state.env`：任务、轮次、结论和上一轮实际运行配置；
- `runtime.env`：三种专用角色的默认执行器、模型、effort、超时和恢复策略；
- `implementation-report.md`：最近一轮实现交接，由 IMPLEMENTER 更新；
- `latest-review.md`：最近一次正式审查，由中立审查包装器替换；
- `review-history/`：只追加的正式审查归档；
- `artifacts/`：被 Git 忽略的日志、截图、验证、运行清单和循环简报。

## 身份规则

直接启动 Agent 且没有明确指定身份时，默认是 `GENERAL`。只有项目所有者或父脚本
明确分配后，Agent 才成为 `MONITOR`、`IMPLEMENTER` 或 `REVIEWER`。同一执行器
可以在不同的新进程中承担不同角色；同一任务内只恢复同角色专属会话，绝不跨角色
复用，也不得在一个进程中自行切换。

一次专用调用的实际身份由以下内容共同确定：

```text
角色 + 执行器 + 模型/effort + 权限配置 + 任务/提交边界
```

每次调用的完整配置写入 `.agent/artifacts/runs/*.env`，循环简报会记录各轮实际
执行器，而不是把提交固定标成 Claude 或 Codex。

## 默认与自定义循环

默认配置在 `runtime.env`，当前是 Claude Code 实现、Codex 审查：

```bash
./scripts/agent-cycle.sh preflight
./scripts/agent-cycle.sh cycle
```

交换角色：

```bash
./scripts/agent-cycle.sh cycle \
  --implementer codex \
  --implementer-model gpt-5.6-sol \
  --implementer-effort high \
  --reviewer claude \
  --reviewer-model sonnet \
  --reviewer-effort high
```

也可以让同一种执行器承担两种角色；父脚本仍会为两者创建独立角色会话和全新进程，
并强制审查阶段只读。模型名必须是相应 CLI 实际支持的值。

预计一次任务会跨越多个额度窗口时，使用外层监督器：

```bash
./scripts/agent-cycle.sh supervise \
  --implementer claude --implementer-model sonnet --implementer-effort high \
  --reviewer claude --reviewer-model sonnet --reviewer-effort max
```

`agent-supervisor.sh` 调用有界的 `agent-cycle.sh`，在额度中断后保存合法实现现场、
记录恢复时间并由 shell 等待。等待期间没有 Agent 进程，不消耗模型 token。
MONITOR 不持续轮询，只在未知异常时生成只读事件报告。

完整顺序为：

```text
预检
→ 新进程：IMPLEMENTER
→ 机械边界检查与统一验证
→ 中立脚本创建本地实现提交
→ 新进程：REVIEWER（只读、只使用 REVIEWER 专属会话）
→ 校验/归档报告
→ 中立脚本创建本地审查提交
→ PASS 结束；CHANGES_REQUIRED 串行进入下一轮
```

父脚本始终等待当前子进程退出后才启动下一步，不需要 Agent 相互启动。默认最大轮数
由 `state.env` 的 `MAX_ROUNDS` 控制，也可用 `--max-rounds N` 只覆盖当前运行。

每次调用的原始 JSON/JSONL 事件和标准化用量摘要保存在
`.agent/artifacts/implementation/` 或 `.agent/artifacts/review/`，运行清单记录会话
ID、`new/resume` 模式及这些文件的路径。

## 权限原则

- 无人值守调用均使用非交互权限；缺少能力时失败，不弹窗等待；
- IMPLEMENTER 有项目工作区写权限，但不能控制 Git、修改受保护控制面、push 或
  部署；外层脚本会机械检查；
- REVIEWER 始终只读，不能直接修复；
- Claude 适配器通过 tool allow/deny 转换角色权限；
- Codex 适配器通过 `workspace-write` 或 `read-only` sandbox 转换角色权限；
- 不给任何执行器机器级全权，不用 `sudo` 或 bypass 模式处理项目权限问题。

## 常用入口

```bash
./scripts/agent-cycle.sh status
./scripts/agent-cycle.sh preflight
./scripts/agent-cycle.sh implement --agent claude --model sonnet --effort high
./scripts/agent-cycle.sh review --agent codex --model gpt-5.6-sol --effort high
./scripts/agent-cycle.sh cycle
./scripts/agent-cycle.sh supervise
./scripts/agent-cycle.sh supervisor-status
./scripts/agent-cycle.sh summary
./scripts/test-agent-runtime.sh
./scripts/test-agent-supervisor.sh
```

两个测试脚本都只使用假的 shell 子进程，不启动真实 Agent。

## 失败与恢复

先查看：

```bash
./scripts/agent-cycle.sh status
cat .agent/artifacts/preflight/summary.md
cat .agent/artifacts/runtime/last-stop.env
```

权限、认证、额度、MCP、超时、工作区污染、越权或报告无效都会立即停止，不会增加
审查轮次。普通 `cycle` 会停止；`supervise` 只对明确分类的额度事件进行有界恢复，
其他错误会唤醒只读 MONITOR 后停止。不要用 `git reset --hard`、`git clean -fd`
或删除活动锁来恢复；先检查保留现场，再由所有者决定。
