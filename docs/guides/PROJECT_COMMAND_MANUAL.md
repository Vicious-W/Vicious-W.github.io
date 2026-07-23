# 项目参与者指令手册

版本：v1.0

更新日期：2026-07-23

适用目录：`/home/vicious/projects/Vicious-W.github.io`

## 1. 这份手册解决什么问题

这是一份“现在该敲什么命令”的速查手册，不代替完整项目文档。

- 项目目标、技术背景和历史决策：读 `PROJECT.md`。
- 当前正式目标、范围和验收标准：读 `PROJECT_SPEC.md`。
- 反应堆资料、部件、状态和真实性边界：读 `docs/engineering/REACTOR_MODEL.md`。
- Claude Code 的实现边界：读 `CLAUDE.md`。
- Codex 的审查边界：读 `AGENTS.md`。
- 审查等级、报告格式和通过规则：读 `REVIEW_CONTRACT.md`。
- 日常启动、检查、查看结果和故障恢复：看本手册。

所有命令默认从仓库根目录运行：

```bash
cd /home/vicious/projects/Vicious-W.github.io
```

## 2. 最常用的五条命令

```bash
# 查看 Git、当前任务、轮次、最新审查、验证和停止原因
./scripts/agent-cycle.sh status

# 启动本地开发服务器
npm run dev -- --port 8000

# 只检查环境、权限、登录、MCP 和 Git 条件，不启动 Agent
./scripts/agent-cycle.sh preflight

# 启动完整的 Claude 实现 → 验证/提交 → Codex 审查循环
./scripts/agent-cycle.sh cycle

# 查看多轮工作的中文简报
./scripts/agent-cycle.sh summary
```

如果你只是想打开网页玩或做主观体验测试，通常只需要第二条命令。

如果你已经设定好正式目标并准备让两个 Agent 自动工作，依次使用
`status`、`preflight`、`cycle`。

## 3. 项目的角色规则

| 参与者 | 主要职责 | 是否修改业务代码 |
| --- | --- | --- |
| 项目所有者 | 提出目标、决定范围、进行最终主观验收和产品决策 | 可以，但通常不需要 |
| Claude Code | 唯一业务实现者，研究、编码、验证并提交实现报告 | 是 |
| Codex | 独立审查实现、验证证据和正式验收条件 | 否，常规审查只读 |
| 中立父脚本 | 串行启动子进程、监督超时、验证状态、创建本地 Git 检查点 | 只操作控制面和检查点 |

完整自动循环中始终最多只有一个 Agent 在运行。Claude 和 Codex 不负责启动
对方，也不互相监管；父脚本等待当前子进程退出并验证交付物后，才决定是否启动
下一步。

## 4. 本地网页开发与体验

### 4.1 首次安装或依赖变化后

```bash
npm install
```

项目使用 npm，锁文件是 `package-lock.json`。不要同时引入 pnpm、yarn 或 bun
锁文件，否则统一验证会因无法确定包管理器而失败。

### 4.2 启动开发服务器

```bash
npm run dev -- --port 8000
```

终端会显示实际访问地址，通常是 `http://localhost:8000/`。如果 8000 已被占用，
Vite 可能自动选择下一个端口，以终端输出为准。服务器持续占用当前终端；
按 `Ctrl+C` 停止。

### 4.3 生产构建

```bash
npm run build
```

构建产物写入 `dist/`。这只构建本地文件，不会部署或推送。

### 4.4 本地预览生产构建

```bash
npm run preview
```

它用于查看 `dist/` 的生产构建结果，同样不会部署。

## 5. 启动一次完整双 Agent 循环

### 5.1 启动前必须满足

1. 正式目标已经写入 `PROJECT_SPEC.md`。
2. 当前执行切片已经写入 `.agent/next-task.md`。
3. `.agent/state.env` 中任务 ID、状态和轮数与当前目标一致。
4. 任务状态是 `READY` 或 `NEEDS_CHANGES`，不存在尚未解决的所有者决策。
5. Git 工作区完全干净。
6. Claude、Codex 均已登录，双方的 Playwright MCP 均已注册且健康。
7. 没有另一个 Agent 循环正在运行。

第 1～3 项属于“建立新阶段目标”的控制面工作，不应在循环运行中修改。新阶段
通常应先由项目所有者明确授权一次基础设施/任务配置工作，完成并提交后再启动
循环。不要只改目标正文而遗留旧任务 ID、旧轮次或 `COMPLETE` 状态。

### 5.2 推荐启动顺序

```bash
./scripts/agent-cycle.sh status
./scripts/agent-cycle.sh preflight
./scripts/agent-cycle.sh cycle
```

成功开始实现时会看到类似输出：

```text
=== Claude implementation round 2/3 ===
Starting Claude Code implementation...
```

父脚本在 Agent 长时间工作时按固定间隔打印心跳。没有持续输出不等于卡死，
先看心跳和日志字节数是否仍在变化。

### 5.3 `cycle` 实际执行的顺序

```text
严格预检
  → Claude Code 完成一轮实现
  → 机械检查 Claude 是否越权
  → 统一验证
  → 父脚本创建本地实现提交
  → Codex 在只读沙箱中审查该提交
  → 校验并归档审查报告
  → 父脚本创建本地审查提交
  → PASS 时结束；CHANGES_REQUIRED 时进入下一轮
```

默认最多三轮。发生权限、认证、额度、MCP、超时、工作区污染、越权、报告无效
或未知结论时立即停止，不会跳过失败继续运行。

自动流程只创建本地提交；不会执行 push、部署、reset、clean、rebase、切换分支
或无限重试。

## 6. 父脚本命令速查

统一入口：

```bash
./scripts/agent-cycle.sh <command>
```

| 命令 | 作用 | 会启动真实 Agent | 常规用途 |
| --- | --- | --- | --- |
| `preflight` | 检查仓库、权限、登录、MCP、依赖、Git 写入和任务状态 | 否 | 每次完整循环前运行 |
| `cycle` | 串行执行实现、验证、检查点和审查，直到 PASS 或停止条件 | 是 | 正常自动工作入口 |
| `status` | 打印 Git、任务、轮次、审查、验证及最近停止信息 | 否 | 开始前、异常后查看 |
| `summary` | 生成并打印当前任务各轮中文简报 | 否 | 数轮完成或中断后查看 |
| `validate` | 运行统一的已配置检查 | 否 | 手动检查构建状态 |
| `implement` | 只运行一轮 Claude，实现后验证并创建本地提交 | 仅 Claude | 流程诊断或人工分步 |
| `review [target base]` | 只运行一次 Codex 正式审查 | 仅 Codex | 流程诊断或人工分步 |
| `archive` | 在最新正式审查尚未归档时手动归档 | 否 | 少数手动审查场景 |

查看入口自带帮助：

```bash
./scripts/agent-cycle.sh --help
./scripts/agent-preflight.sh --help
./scripts/run-implementation.sh --help
./scripts/run-review.sh --help
```

### 6.1 分步命令的重要差异

- `implement` 会要求工作区干净，运行一轮 Claude，统一验证，然后由包装器自动
  创建本地实现提交。
- `review` 会要求工作区干净，并要求被审查目标就是当前 `HEAD`。它更新
  `.agent/latest-review.md`、`.agent/review-history/` 和 `.agent/state.env`，
  但独立运行时不会替你提交这些审查交接文件。
- `cycle` 会在 Codex 成功后额外检查审查写入范围并自动创建审查提交。因此日常
  自动化应优先使用 `cycle`，不要无故拆成 `implement` 和 `review`。

## 7. 验证命令与“通过”的含义

```bash
./scripts/run-validation.sh
```

当前统一验证会：

- 检查包管理器、锁文件、依赖完整性；
- 运行必需的 `npm run build`；
- 如果 `package.json` 配置了 test、lint、typecheck，则运行对应检查；
- 未配置的测试、lint、类型检查会如实写成 `NOT CONFIGURED`；
- 把摘要写入 `.agent/artifacts/validation/summary.md`。

网页外观和行为不会被这个 Bash 脚本自动判定为通过。涉及页面修改时，Claude
和 Codex 仍须通过 Playwright MCP 检查 `390 × 844`、`768 × 1024`、
`1440 × 900` 视口、主要交互与浏览器控制台。

运行控制层自身的烟雾测试：

```bash
./scripts/test-agent-runtime.sh
```

它只启动假的 shell 子进程来测试成功、权限失败、额度失败、超时和锁处理，不会
启动真实 Claude 或 Codex。

## 8. 模型、effort、超时和轮数

### 8.1 模型与运行时间

项目级策略位于 `.agent/runtime.env`：

```dotenv
CLAUDE_MODEL=sonnet
CLAUDE_EFFORT=high
CODEX_MODEL=gpt-5.6-sol
CODEX_REASONING_EFFORT=high
CLAUDE_TIMEOUT_SECONDS=7200
CODEX_TIMEOUT_SECONDS=3600
```

父脚本会显式把这些值传给 CLI，不再静默继承个人交互会话里的模型选择。effort
允许值为 `low`、`medium`、`high`、`xhigh`、`max`。

修改策略后先运行：

```bash
./scripts/agent-cycle.sh preflight
```

不要在 Agent 子进程已经运行时修改策略；正在运行的那一轮不会安全地切换模型。

### 8.2 最大轮数

当前任务的轮数位于 `.agent/state.env`：

```dotenv
CURRENT_ROUND=1
MAX_ROUNDS=3
```

`MAX_ROUNDS` 是当前任务的硬上限，不是模型 effort。达到上限后父脚本返回控制权，
应先阅读报告并作出产品或技术决策，不要把上限不断调大来掩盖重复失败。

## 9. 在哪里看结果

### 9.1 最快的总体状态

```bash
./scripts/agent-cycle.sh status
```

### 9.2 多轮中文简报

```bash
./scripts/agent-cycle.sh summary
```

最新简报：

```text
.agent/artifacts/cycle/latest-summary.md
```

历史简报：

```text
.agent/artifacts/cycle/history/
```

简报会按轮列出 Claude 的实现提交、主要改动、验证情况，以及 Codex 的结论、
问题等级和标题。它是快速入口，不代替原始报告。

### 9.3 Claude 的详细交接

最新实现报告：

```text
.agent/implementation-report.md
```

查看某个实现提交当时保存的报告：

```bash
git show <实现提交>:.agent/implementation-report.md
```

每轮原始日志：

```text
.agent/artifacts/implementation/claude-round-N.log
```

### 9.4 Codex 的详细审查

最新审查：

```text
.agent/latest-review.md
```

历史审查：

```text
.agent/review-history/
```

查看某个审查提交当时保存的报告：

```bash
git show <审查提交>:.agent/latest-review.md
```

每轮原始日志：

```text
.agent/artifacts/review/codex-round-N.log
```

### 9.5 Git 历史

```bash
git log --oneline --decorate -20
git show --stat <提交>
git show <提交>
```

自动提交标题通常是：

```text
agent: implementation round N
agent: codex review round N
```

## 10. 常见停止情况与处理

先运行：

```bash
./scripts/agent-cycle.sh status
```

最近停止原因还会保存在：

```text
.agent/artifacts/runtime/last-stop.env
```

| 现象或分类 | 含义 | 推荐处理 |
| --- | --- | --- |
| `Git working tree is not clean` | 启动前已有未提交内容 | 先辨认并安全提交；不要让包装器吸收来源不明的改动 |
| `USAGE_OR_BILLING_LIMIT` | 模型额度、余额或速率限制 | 等额度恢复或由所有者调整策略，再从干净状态重试 |
| `AUTHENTICATION` | CLI 登录或令牌失效 | 分别恢复 Claude/Codex 登录，再运行 preflight |
| `PERMISSION` | 所需能力未在无人值守策略中授权 | 判断是否确属任务所需；修改最小权限后重新预检 |
| `MCP_OR_BROWSER` | Playwright MCP 或浏览器不可用 | 修复注册/浏览器环境，再预检 |
| `TIMEOUT` | 单轮超过项目设置的硬时限 | 检查日志和残留改动，再决定拆小目标或合理增加时限 |
| 达到 `MAX_ROUNDS` | 自动纠错上限已到 | 阅读简报和最新审查，由所有者决策 |
| `POLICY_VIOLATION` | 实现者触碰受保护控制面 | 停止；检查所有残留文件，不要自动提交 |
| 无有效报告或无改动 | Agent 没有形成可验收交付物 | 查看该轮原始日志，修正任务或工具问题 |

退出码常见含义：

- `0`：当前命令成功；
- `2`：参数、脏工作区、活动锁或状态前置条件不满足；
- `3`：任务已完成、不可继续或达到轮次上限；
- `4`：控制面、报告、检查点或策略校验失败；
- `5`：没有形成有效实现交付；
- `6`：预检失败，未启动 Agent；
- `124`：子进程超时；
- `127`：所需 CLI 不在 `PATH`。

Claude/Codex 自己也可能返回其他非零退出码；以 `status` 显示的分类和对应日志为准。

## 11. 并发、锁与中断

- 不要在两个终端同时运行 `cycle`、`implement` 或 `review`。
- 活动流程使用 `.agent/.cycle.lock`。第二个流程会被拒绝。
- 不要手动删除一个活动锁。陈旧锁会由脚本根据 PID 和进程启动时间安全回收。
- 本地开发服务器可以和自动流程同时存在，但不要让两个服务器争用同一端口。
- 需要中止父循环时，在启动它的终端按一次 `Ctrl+C`，等待包装器结束子进程组并
  清理锁；不要直接关闭 WSL 或批量杀进程，除非正常终止已经失败。
- 异常中断后先查看 `git status`、`agent-cycle.sh status` 和原始日志。脚本不会
  擅自丢弃半成品。

不要用以下命令“修复”自动循环：

```text
git reset --hard
git clean -fd
git checkout -- .
```

它们可能删除所有者文件或尚未检查的 Agent 半成品。

## 12. 一次任务完成后的所有者检查清单

1. 运行 `./scripts/agent-cycle.sh summary`，先了解每轮发生了什么。
2. 确认最终 `VERDICT: PASS`；如果没有 PASS，阅读停止原因和 Major/Blocker。
3. 启动本地服务器，亲自体验观感、手感、声音、响应式和性能。
4. 对感兴趣的细节查看对应 Git 提交、实现报告或审查报告。
5. 决定接受结果、提出下一阶段目标，或授权一次新的任务控制面配置。
6. 需要同步远端或部署时，由项目所有者另行执行；自动 Agent 循环不会替你做。
