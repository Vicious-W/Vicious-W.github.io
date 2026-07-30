# Agent 交接与运行状态目录

本目录是角色化 Agent 协作的正式交接面。角色不与 Claude Code 或 Codex 绑定；
共同身份规则见 `AGENT_PROTOCOL.md`，角色契约位于 `roles/`。

## 文件职责

- `roles/GENERAL.md`：默认通用、控制面维护与跨额度窗口监督身份；
- `roles/IMPLEMENTER.md`：专用实现身份；
- `roles/REVIEWER.md`：专用独立审查身份；
- `next-task.md`：所有者确认的当前执行切片；
- `state.env`：任务、轮回、结论和上一轮实际运行配置；
- `runtime.env`：实现、审查与 GENERAL 监督上下文的默认执行器、模型、effort、超时、
  Monitor 兼容模式名、
  Claude 自主预算和恢复策略；
- `implementation-report.md`：最近一轮实现交接，由 IMPLEMENTER 更新；
- `latest-review.md`：最近一次正式审查，由中立审查包装器替换；
- `review-history/`：只追加的正式审查归档；
- `artifacts/`：被 Git 忽略的日志、截图、验证、运行清单和轮回简报。

## 身份规则

直接启动 Agent 且没有明确指定身份时，默认是 `GENERAL`。GENERAL 同时负责普通协作、
控制面维护与轮转监督；只有项目所有者或父脚本明确分配后，Agent 才成为
`IMPLEMENTER` 或 `REVIEWER`。同一执行器
可以在不同的新进程中承担不同角色；同一任务内只恢复同角色专属会话，绝不跨角色
复用，也不得在一个进程中自行切换。

一次专用调用的实际身份由以下内容共同确定：

```text
角色 + 执行器 + 模型/effort + 权限配置 + 任务/提交边界
```

每次调用的完整配置写入 `.agent/artifacts/runs/*.env`，轮回简报会记录各轮实际
执行器，而不是把提交固定标成 Claude 或 Codex。

## 默认与自定义轮回

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
  --reviewer claude --reviewer-model sonnet --reviewer-effort max \
  --monitor-mode attached
```

`agent-supervisor.sh` 调用有界的 `agent-cycle.sh`，在额度中断后保存合法实现现场、
记录恢复时间并由 shell 等待。等待期间没有工作 Agent 或模型请求，不消耗模型 token。
`attached` 表示当前可见 GENERAL 对话从头到尾持有这个前台进程；该对话结束后
shell 无法重新唤醒它。无人值守时使用 `--monitor-mode persistent-cli`，父脚本在
启动时由 `agent-supervisor-service.sh` 放入独立 WSL session/进程组，再创建一个
任务级只读 CLI GENERAL 控制会话，并在后续事件边界恢复同一会话。父脚本进程与
GENERAL 逻辑会话必须同时持久，缺一不可。

Claude `--print` 调用同时受 agentic-turn 上限和 API 等价预算约束。任一保险先到会产生
`AUTONOMY_SLICE_LIMIT`。合法现场保存后进入 GENERAL 决策点，而不是直接假定额度
耗尽：可立即续片、轮换上下文后续片、等待窗口或停止。Claude 的逐事件
`stream-json` 让心跳能够显示 assistant 事件、token 和缓存增长；最终 turns 只采用
执行器终态结果，两个计数不互相冒充。监督窗口累计账本位于
`.agent/artifacts/supervisor/usage-ledger.json`。最后一轮缓存上下文超过阈值时，
下一次不再恢复膨胀的原始 transcript，而以当前 Git 检查点和结构化交接创建同一
逻辑角色会话的新代次。

一次轮回固定为一次 IMPLEMENTER。请求三次时，完整顺序为：

```text
预检
→ 新进程：IMPLEMENTER
→ 机械边界检查与统一验证
→ 中立脚本创建本地实现提交
→ 新进程：REVIEWER（只读、只使用 REVIEWER 专属会话）
→ 校验/归档报告
→ 中立脚本创建本地审查提交
→ 新进程：IMPLEMENTER
→ REVIEWER
→ 新进程：IMPLEMENTER
→ 最后一次实现后停止，交由所有者查看
```

审查只出现在相邻两次实现之间，用于准备下一次实现。最后一次实现不自动审查；
若所有者追加轮回，父脚本先审查待定实现，再进入已明确请求的下一次实现；PASS 表示
没有阻塞项，`CHANGES_REQUIRED` 则提供强制修复项，两者都不减少请求的实现次数。
父脚本始终等待当前子进程退出后才启动下一步，不需要 Agent 相互启动。默认请求一次
轮回，可用 `--rounds N` 指定本次追加的实现次数；`--max-rounds` 仅保留为兼容别名。
若所有者满意，运行 `./scripts/agent-cycle.sh accept`，即可在不启动 REVIEWER 的
情况下记录接受决定并创建本地状态提交。

同一 `ACTIVE_TASK_ID` 下，IMPLEMENTER 与 REVIEWER 各自持有一个逻辑角色会话。
追加轮回会恢复各自原会话；只有任务、角色、执行器、模型、effort 改变，或上下文
阈值触发新 generation，才创建新的原始会话。

每次调用的原始 JSON/JSONL 事件和标准化用量摘要保存在
`.agent/artifacts/implementation/` 或 `.agent/artifacts/review/`，运行清单记录会话
ID、`new/resume` 模式、会话代次、预算保险及这些文件的路径。

`state.env` 中 `CURRENT_ROUND` 只计已完成的 IMPLEMENTER 次数，
`COMPLETED_REVIEWS` 单独计审查次数；`PENDING_REVIEW=YES` 表示最新实现尚未被审查或
所有者接受，`PENDING_REVIEW_BASE_COMMIT` 保存其精确比较基准。实现进行期间，
`ACTIVE_IMPLEMENTATION_ROUND` 与
`ACTIVE_IMPLEMENTATION_REVIEW_BASE_COMMIT` 保存整轮不可变起点；恢复检查点不得
把它缩短为某次续跑进程的起点。`DEFAULT_ROUNDS` 是每次命令默认追加的轮回数，
不是任务生命周期的总上限。

附着式 GENERAL 在 `AWAITING_MONITOR_ACTION` 状态用以下命令提交决策：

```bash
./scripts/agent-cycle.sh supervisor-action CONTINUE_NOW <EVENT_ID>
./scripts/agent-cycle.sh supervisor-action ROTATE_AND_CONTINUE <EVENT_ID>
./scripts/agent-cycle.sh supervisor-action WAIT_FOR_QUOTA <EVENT_ID>
./scripts/agent-cycle.sh supervisor-action STOP_OWNER <EVENT_ID>
```

`persistent-cli` 后台监督使用：

```bash
./scripts/agent-cycle.sh supervisor-status
./scripts/agent-cycle.sh supervisor-log 120
./scripts/agent-cycle.sh supervisor-stop
```

状态使用 PID 与 Linux `/proc` start ticks 共同校验，避免 PID 已复用时误判或误停
其他进程。

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

权限、认证、额度、自主切片保险、MCP、超时、工作区污染、越权或报告无效都会立即
停止，不会增加审查次数。普通 `cycle` 会停止；`supervise` 只对明确分类的额度或
自主切片事件进行有界恢复，其他错误交给附着式或持久 CLI GENERAL 控制会话后停止。不要用
`git reset --hard`、`git clean -fd`
或删除活动锁来恢复；先检查保留现场，再由所有者决定。
