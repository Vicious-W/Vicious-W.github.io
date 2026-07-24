# 项目参与者指令手册

版本：v4.0

更新日期：2026-07-24

适用目录：`/home/vicious/projects/Vicious-W.github.io`

## 1. 先看什么

这是一份命令速查，不代替正式项目文档。所有命令默认从仓库根目录运行。

```bash
cd /home/vicious/projects/Vicious-W.github.io
```

- 当前事实与技术结构：`PROJECT.md`
- 正式目标与验收标准：`PROJECT_SPEC.md`
- SOURCE 物理系统：`docs/engineering/SOURCE_SCENE.md`
- 反应堆池工程基线：`docs/engineering/REACTOR_POOL_SYSTEM.md`
- 反应堆模型基线：`docs/engineering/REACTOR_MODEL.md`
- Agent 身份总协议：`AGENT_PROTOCOL.md`
- 四种角色：`.agent/roles/`
- 正式审查格式：`REVIEW_CONTRACT.md`

## 2. 最常用命令

```bash
# 查看 Git、默认角色配置、任务、轮次和停止原因
./scripts/agent-cycle.sh status

# 启动本地网页
npm run dev -- --port 8000

# 只预检，不启动任何 Agent
./scripts/agent-cycle.sh preflight

# 按 runtime.env 默认配置启动完整循环
./scripts/agent-cycle.sh cycle

# 启动可跨多个额度窗口的监督循环
./scripts/agent-cycle.sh supervise

# 查看各轮中文简报
./scripts/agent-cycle.sh summary
```

只想体验网页时运行第二条。准备自动工作时依次运行 `status`、`preflight`、`cycle`。

## 3. Agent 身份不是 Agent 品牌

本项目把三个概念分开：

| 概念 | 可选值 | 含义 |
| --- | --- | --- |
| 角色 | GENERAL / MONITOR / IMPLEMENTER / REVIEWER | 本次调用要承担什么职责 |
| 执行器 | claude / codex | 使用哪个 CLI 与服务运行 |
| 运行参数 | model / effort / timeout / permissions | 这次调用怎样运行 |

`GENERAL` 是默认身份：所有者直接请一个 Agent 进入项目而没有指定专用身份时，它
作为通用协作者工作，不自动写正式交接或推进循环。

`MONITOR` 是跨额度窗口的监督身份：只检查流程、进程、Git 和恢复证据，不评价业务
质量。`attached` 模式由当前可见 MONITOR 对话从开始到终止持有 supervisor；
`persistent-cli` 模式由父脚本创建并恢复一个后台任务级 MONITOR 会话。

`IMPLEMENTER` 和 `REVIEWER` 是显式分配的专用身份。任何受支持的执行器都可以承担
任一角色，同一执行器也可以在两个全新进程中先实现再审查。后一种配置具有权限和
上下文隔离，但没有模型多样性，简报会如实记录。

`AGENTS.md` 与 `CLAUDE.md` 只是各执行器的薄入口；共同规则在
`AGENT_PROTOCOL.md` 与角色契约中。

## 4. 本地网页命令

首次安装或依赖变化后：

```bash
npm install
```

开发服务器：

```bash
npm run dev -- --port 8000
```

生产构建与本地预览：

```bash
npm run build
npm run preview
```

这些命令不会 push 或部署。项目只使用 npm 与 `package-lock.json`。

## 5. 配置实现者和审查者

默认值位于 `.agent/runtime.env`：

```dotenv
IMPLEMENTER_AGENT=claude
IMPLEMENTER_MODEL=sonnet
IMPLEMENTER_EFFORT=high
IMPLEMENTER_TIMEOUT_SECONDS=7200
REVIEWER_AGENT=codex
REVIEWER_MODEL=gpt-5.6-sol
REVIEWER_EFFORT=high
REVIEWER_TIMEOUT_SECONDS=3600
MONITOR_AGENT=codex
MONITOR_MODEL=gpt-5.6-terra
MONITOR_EFFORT=medium
MONITOR_TIMEOUT_SECONDS=900
MONITOR_MODE=attached
CLAUDE_IMPLEMENTER_MAX_TURNS=36
CLAUDE_IMPLEMENTER_MAX_BUDGET_USD=6.00
CLAUDE_REVIEWER_MAX_TURNS=24
CLAUDE_REVIEWER_MAX_BUDGET_USD=4.00
CLAUDE_MONITOR_MAX_TURNS=8
CLAUDE_MONITOR_MAX_BUDGET_USD=1.00
CLAUDE_CONTEXT_ROTATE_TOKENS=160000
QUOTA_WAIT_SECONDS=18000
MAX_QUOTA_RESUMES=6
```

这只是默认调用配置，不是永久身份绑定。可以在每次 `cycle` 启动时覆盖。

### 5.1 使用默认配置

```bash
./scripts/agent-cycle.sh cycle
```

### 5.2 交换角色

```bash
./scripts/agent-cycle.sh cycle \
  --implementer codex \
  --implementer-model gpt-5.6-sol \
  --implementer-effort high \
  --reviewer claude \
  --reviewer-model sonnet \
  --reviewer-effort high
```

### 5.3 同一种执行器承担两种角色

```bash
./scripts/agent-cycle.sh cycle \
  --implementer codex \
  --implementer-model gpt-5.6-sol \
  --implementer-effort high \
  --reviewer codex \
  --reviewer-model gpt-5.6-sol \
  --reviewer-effort high
```

角色间仍是两个独立会话、两个独立进程；同一任务后续轮次只恢复自己的角色会话，
审查进程仍强制只读。

模型名必须是对应 CLI 支持的实际值。`effort` 可用
`low`、`medium`、`high`、`xhigh`、`max`；具体模型是否支持某个强度由 CLI
最终判断。改变默认值或覆盖参数后先运行同样参数的预检。

## 6. 完整自动循环

启动前确认：

1. `PROJECT_SPEC.md` 已写入当前正式目标；
2. `.agent/next-task.md` 是本次可执行切片；
3. `.agent/state.env` 状态为 `READY` 或 `NEEDS_CHANGES`；
4. `CURRENT_ROUND < MAX_ROUNDS`；
5. Git 工作区完全干净；
6. 选中的执行器已登录，Playwright MCP 可用；
7. 没有另一个循环持有 `.agent/.cycle.lock`。

推荐：

```bash
./scripts/agent-cycle.sh status
./scripts/agent-cycle.sh preflight
./scripts/agent-cycle.sh cycle
```

只运行一次实现和一次审查，不改项目默认轮数：

```bash
./scripts/agent-cycle.sh cycle \
  --max-rounds 1 \
  --implementer claude --implementer-model opus-4.8 --implementer-effort high \
  --reviewer codex --reviewer-model gpt-5.6-sol --reviewer-effort high
```

开始后会看到：

```text
Cycle configuration
  IMPLEMENTER: claude / sonnet / high
  REVIEWER:    codex / gpt-5.6-sol / high

=== IMPLEMENTER (claude) round 1/3 ===
```

流程严格串行：

```text
预检
→ IMPLEMENTER 新进程（恢复本任务的 IMPLEMENTER 专属会话）
→ 越权检查、统一验证、本地实现提交
→ REVIEWER 新进程（只读，恢复本任务的 REVIEWER 专属会话）
→ 报告格式检查、归档、本地审查提交
→ PASS 结束；CHANGES_REQUIRED 进入下一轮
```

Agent 不负责启动下一个 Agent。中立父脚本一直等待子进程结束，确认交接后再启动
下一阶段，因此不会因为自动交接而让两个 Agent 长时间并行运行。

默认最多三轮；`--max-rounds N` 只覆盖当前 cycle/supervise，不修改
`.agent/state.env` 的默认值。权限、认证、额度、MCP、超时、脏工作区、越权、无效报告或未知
结论都会立即停止。流程不会 push、部署、reset、clean、rebase 或无限重试。

### 6.1 跨额度窗口的监督循环

如果预计单次额度不足以完成全部轮次，使用：

```bash
./scripts/agent-cycle.sh supervise \
  --implementer claude \
  --implementer-model sonnet \
  --implementer-effort high \
  --reviewer claude \
  --reviewer-model sonnet \
  --reviewer-effort max \
  --monitor codex \
  --monitor-model gpt-5.6-terra \
  --monitor-effort medium \
  --monitor-mode attached
```

如果由你自己在普通终端启动、希望异常时也能完全无人值守：

```bash
./scripts/agent-cycle.sh supervise --monitor-mode persistent-cli
```

如果需要在确定时间才首次启动：

```bash
./scripts/agent-cycle.sh supervise \
  --start-at "2026-07-23 10:42:15 PDT" \
  --implementer claude --implementer-model sonnet --implementer-effort high \
  --reviewer claude --reviewer-model sonnet --reviewer-effort max
```

监督器分为两层：

```text
agent-supervisor.sh：跨额度窗口、恢复次数、定时等待、异常交接
└── agent-cycle.sh：最多 N 轮的实现—审查状态机
    ├── IMPLEMENTER
    └── REVIEWER
```

额度中断或 Claude 主动预算保险触发时，监督器会先确认工作 Agent 已退出。若实现阶段留下合法半成品，它运行
统一验证并创建标题明确的 recovery checkpoint；该提交只保存现场，不代表通过，
也不增加审查轮次。额度事件进入 `WAITING_FOR_QUOTA`，主动预算保险进入
`WAITING_FOR_BUDGET_WINDOW`，随后都由 shell 的 `sleep` 等待。这段等待不会调用
模型，因此不会消耗 Agent token。

Claude 非交互调用不是一次模型请求，而是工具调用—模型调用循环。为防止几十分钟内
重复读取数千万缓存 token，默认对 IMPLEMENTER、REVIEWER 和后台 MONITOR 分别设置
最大 turns 与 API 等价预算。命中任一值记录为 `AUTONOMY_SLICE_LIMIT`，状态进入
`WAITING_FOR_BUDGET_WINDOW`。这些金额是控制 Claude CLI 返回的等价用量，不等于
订阅账单金额。

到点后，监督器从中断角色启动全新进程：实现阶段中断就继续 IMPLEMENTER，已有
实现检查点后的审查中断就直接继续 REVIEWER；新进程会精确恢复同一任务的对应角色
会话，而不是重新选择“最近会话”。如果最后一轮缓存上下文达到
`CLAUDE_CONTEXT_ROTATE_TOKENS`，父脚本会在安全检查点后创建同一逻辑角色会话的新
代次，并在清单记录旧会话 ID；这样保留任务连续性，但不再让每个工具轮次携带膨胀
的全部原始历史。默认每次额度等待 5 小时，最多恢复 6 次，均可用
`--quota-wait-seconds` 和 `--max-quota-resumes` 覆盖。

每次调用的运行清单位于 `.agent/artifacts/runs/`，其中记录会话 ID、`new/resume`
模式、原始 JSON/JSONL 事件和标准化用量摘要路径。用量字段由执行器实际返回决定；
订阅模式没有费用数据时显示为 `null`，不代表费用为零。

查看监督状态：

```bash
./scripts/agent-cycle.sh supervisor-status
./scripts/agent-cycle.sh status
```

若所有者在正式 cycle 之外形成了一个已经验证的实现检查点，可以直接从审查阶段
开始，但必须保留完整比较基准：

```bash
./scripts/agent-cycle.sh supervise \
  --start-stage reviewer \
  --review-base <实现开始前的提交> \
  --reviewer claude --reviewer-model sonnet --reviewer-effort max
```

`--review-base` 会一直随 REVIEWER 的额度中断恢复传递，避免恢复后错误地只审查
`HEAD^..HEAD`。若 `.agent/state.env` 已记录 `LAST_IMPLEMENTATION_BASE_COMMIT`，
可以省略该参数。

`SCHEDULED`、`WAITING_FOR_QUOTA` 和 `WAITING_FOR_BUDGET_WINDOW` 表示没有工作
Agent 在运行；`RUNNING` 表示正在执行一个有界 cycle；`COMPLETE` 或 `STOPPED`
是终态。

单个 Agent 的 timeout 只累计监督循环实际运行的轮询时间。Windows 睡眠或 WSL
暂停期间 Agent 没有工作，这段墙上时间不计入 timeout；恢复后继续累计。supervisor
会先写入 `COMPLETE`、`STOPPED`、`WAITING_FOR_QUOTA` 或
`WAITING_FOR_BUDGET_WINDOW`，再重新生成简报，因此简报看到的是同一事件的最终
外层状态。

`--start-at` 默认也作为固定额度窗口锚点。例如首次恢复为 10:42、窗口为 5 小时，
后续会对齐 15:42、20:42，而不是从 Agent 实际中断时刻再等待整整 5 小时。首次
启动时间与额度锚点不相同时，可另传 `--quota-anchor`。

在 `attached` 模式中，当前可见 MONITOR 对话必须一直保留前台工具调用；一旦该
对话回合结束，外部 shell 无法重新唤醒它。等待仍由 shell 完成，不需要模型轮询。
在 `persistent-cli` 模式中，父脚本于启动事件创建 MONITOR 会话，并在异常、等待和
恢复边界精确恢复该会话；它不会显示成当前 VS Code 对话。

## 7. 父脚本命令

| 命令 | 作用 | 启动 Agent |
| --- | --- | --- |
| `status` | 查看状态、默认配置、验证和停止原因 | 否 |
| `preflight [options]` | 检查选定配置 | 否 |
| `cycle [options]` | 完整串行循环 | 是 |
| `supervise [options]` | 跨额度窗口运行完整轮转 | 串行启动 |
| `supervisor-status` | 查看外层监督状态和恢复时间 | 否 |
| `implement [options]` | 单独运行一轮 IMPLEMENTER 并提交 | 一个 |
| `review [options] [target base]` | 单独运行一次只读 REVIEWER | 一个 |
| `validate` | 统一构建/测试检查 | 否 |
| `summary` | 生成并打印多轮简报 | 否 |
| `archive` | 手动归档尚未归档的最近审查 | 否 |

查看完整参数：

```bash
./scripts/agent-cycle.sh --help
./scripts/agent-preflight.sh --help
./scripts/agent-supervisor.sh --help
./scripts/run-implementation.sh --help
./scripts/run-review.sh --help
```

分步示例：

```bash
./scripts/agent-cycle.sh implement \
  --agent claude --model sonnet --effort high

./scripts/agent-cycle.sh review \
  --agent codex --model gpt-5.6-sol --effort high HEAD HEAD^
```

单独 `review` 会更新审查报告、归档和状态，但不会自动提交这些交接文件；完整
`cycle` 才会在检查写入范围后创建审查提交。

## 8. 验证与运行层测试

统一验证：

```bash
./scripts/run-validation.sh
```

它检查包管理器、锁文件和依赖，运行必需构建，并按实际配置运行 test、lint、
typecheck。未配置的项目写 `NOT CONFIGURED`，不能算作 PASS。摘要位于：

```text
.agent/artifacts/validation/summary.md
```

页面改动仍须由相应角色通过 Playwright MCP 检查 `390 × 844`、`768 × 1024`、
`1440 × 900`、主要交互和 console。

只测试父脚本、超时、锁、配置验证、运行清单和适配路由：

```bash
./scripts/test-agent-runtime.sh
./scripts/test-agent-supervisor.sh
```

这两个测试都不会启动真实 Claude 或 Codex。

## 9. 在哪里看结果

总体状态：

```bash
./scripts/agent-cycle.sh status
```

多轮简报：

```bash
./scripts/agent-cycle.sh summary
```

关键路径：

```text
.agent/implementation-report.md
.agent/latest-review.md
.agent/review-history/
.agent/artifacts/cycle/latest-summary.md
.agent/artifacts/supervisor/state.env
.agent/artifacts/supervisor/events.log
.agent/artifacts/runs/
.agent/artifacts/implementation/<executor>-round-N.log
.agent/artifacts/review/<executor>-round-N.log
```

每个 `.agent/artifacts/runs/*.env` 都记录角色、执行器、模型、effort、权限、
任务、轮次和提交边界。Git 历史中的自动标题为：

```text
agent: implementation round N
agent: review round N
```

查看提交当时的报告：

```bash
git show <实现提交>:.agent/implementation-report.md
git show <审查提交>:.agent/latest-review.md
```

## 10. 权限与适配层

不同 CLI 的实际控制方式不同：

- Claude IMPLEMENTER：`dontAsk` + 项目工具白名单/禁止列表；
- Claude REVIEWER：无 Write/Edit，只有只读命令、公开资料和 Playwright MCP；
- Claude/Codex MONITOR：与 REVIEWER 同级的只读权限，只写忽略目录中的候选报告；
- Codex IMPLEMENTER：`workspace-write` + `approval_policy="never"`；
- Codex REVIEWER：`read-only` + `approval_policy="never"`。

两种实现路径都要经过 Git 历史、refs、索引和受保护路径的机械检查。两种审查路径
都只能输出候选报告，报告安装、归档、状态写入和提交由中立脚本完成。

不要使用机器级全权、`sudo`、Claude `bypassPermissions` 或可写审查来避免卡住。
无人值守模式缺权限会直接失败并保留停止原因，不会等待你回来点授权。

## 11. 停止原因与恢复

```bash
./scripts/agent-cycle.sh status
cat .agent/artifacts/runtime/last-stop.env
```

常见分类：

| 分类 | 含义 | 处理 |
| --- | --- | --- |
| `USAGE_OR_BILLING_LIMIT` | 额度、余额或速率限制 | `supervise` 自动保存并定时续跑 |
| `AUTHENTICATION` | 登录或令牌失效 | 在普通终端恢复对应 CLI 登录 |
| `MODEL_UNAVAILABLE` | 模型标识无效或账户无访问权 | 改用 CLI 支持的别名/完整 slug 后重新预检 |
| `PERMISSION` | 角色所需能力未授权 | 只调整确有需要的最小权限 |
| `MCP_OR_BROWSER` | Playwright 或浏览器不可用 | 修复注册/浏览器后重新预检 |
| `TIMEOUT` | 超过单轮活跃监督时限 | 检查日志，拆小任务或合理调时限；系统休眠不计入 |
| `POLICY_VIOLATION` | 实现者触碰控制面 | 检查保留现场，不自动提交 |
| 达到 `MAX_ROUNDS` | 纠错上限到达 | 阅读简报，由所有者决定 |
| 达到 `MAX_QUOTA_RESUMES` | 额度恢复次数上限 | 停止并由所有者调整计划 |

不要使用这些命令恢复：

```text
git reset --hard
git clean -fd
git checkout -- .
```

它们可能删除所有者文件或尚未检查的 Agent 半成品。中断后先查看 Git 状态、停止
原因、运行清单和日志。

## 12. 一轮或多轮结束后

1. 运行 `./scripts/agent-cycle.sh summary`；
2. 确认最终结论和各轮实际执行器；
3. 对重要细节查看实现报告、审查报告和运行清单；
4. 启动本地服务器亲自体验观感、手感、声音、响应式和性能；
5. 决定接受结果、提出下一阶段目标或调整下一次角色配置；
6. push 和部署仍由所有者另行决定。
