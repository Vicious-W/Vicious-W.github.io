# AI Project Meta Method v4.0

## 面向跨额度窗口的人—多 Agent 角色化协作元方法

- 版本：v4.0
- 日期：2026-07-23
- 状态：正式版本
- 适用范围：由项目所有者与一个或多个 AI Agent 长期共同维护的软件、研究、内容
  或混合型项目
- 核心变化：在 v3.0 的 GENERAL、IMPLEMENTER、REVIEWER 之外增加 MONITOR；把
  “有限轮次”与“跨额度窗口运行”拆成两层状态机；使用零 Token 的中立脚本等待，
  仅在事件边界唤醒监视 Agent

---

## 1. v4.0 解决的问题

v3.0 已解决角色与 Agent 品牌绑定、普通 Agent 被误判为专用身份、不同 CLI 权限
机制被混为一谈等问题。但真实的长任务还会遇到一个跨轮次之外的问题：

- 一个 IMPLEMENTER 或 REVIEWER 可能在完成阶段前耗尽额度；
- 额度按固定或近似固定窗口恢复；
- 一次三轮闭环可能跨越数小时甚至多个恢复窗口；
- 项目所有者无法一直看终端；
- 单一父脚本知道子进程何时退出，却不一定负责数小时后的续跑；
- 让一个 AI Agent 每分钟轮询终端会反复消耗上下文和 token；
- 如果中断时不保存合法半成品，恢复后容易重复劳动；
- 如果粗暴保存所有现场，又可能提交越权修改或不安全 Git 状态。

因此需要把三件不同的工作分开：

```text
业务实现/质量审查：由工作 Agent 完成
确定性等待/恢复编排：由中立 shell 完成
未知异常判断/流程看护：由只读 MONITOR Agent 完成
```

MONITOR 不是新的业务决策者，也不是始终运行的 AI 守护进程。它是一个事件驱动的
专用身份；日常心跳、定时、重试计数和状态落盘应由普通程序完成。

---

## 2. 核心原则

### 2.1 人保留目标权与启动权

项目所有者负责：

- 定义项目目标、范围和验收标准；
- 决定何时启动一次轮转任务；
- 选择每种角色使用的执行器、模型和 effort；
- 设定最大审查轮数、额度恢复次数和等待策略；
- 决定凭据、费用、部署、外部授权和不可逆操作；
- 在自动化停止后作出产品与风险决策。

自动化可以续跑同一个已授权任务，不能借“恢复”改变任务。

### 2.2 角色、执行器和运行参数分离

一次调用的完整身份是：

```text
角色契约 + 执行器 + 模型/推理强度 + 权限配置 + 任务边界
```

例如：

```text
IMPLEMENTER = claude / sonnet / high
REVIEWER    = claude / sonnet / max
MONITOR     = codex  / gpt-5.6-terra / medium
```

这只是本次任务配置，不是永久绑定。下一次可以交换执行器，也可以让同一执行器在
不同的新进程中承担不同角色。

### 2.3 默认身份仍是 GENERAL

Agent 进入仓库但没有显式角色时，身份是 GENERAL。GENERAL 可以按所有者授权讨论、
诊断、维护基础设施或完成一次性工作，但不自动推进正式轮次。

### 2.4 任意时刻最多一个工作 Agent

工作 Agent 指 IMPLEMENTER 或 REVIEWER。两者必须严格串行。

MONITOR 可以在工作 Agent 存活时读取进程和状态，但不得写业务文件、Git、索引、
历史或控制面。涉及恢复提交和状态修复的动作只能在工作 Agent 完全退出后进行。

### 2.5 等待不应使用模型

等待额度恢复属于计时问题，不是推理问题。应由 shell、服务管理器或任务调度器完成：

```text
sleep / timer / persisted deadline → 近似零模型 token
AI Agent 周期性读取相同状态     → 每次都消耗模型 token
```

所以监视应是事件驱动，而不是固定分钟级 AI 轮询。

### 2.6 恢复不等于通过

recovery checkpoint 只保存合法现场：

- 不表示统一验证通过；
- 不表示实现完成；
- 不推进正式审查轮次；
- 不产生审查结论；
- 恢复后的 IMPLEMENTER 仍需完成报告和验证。

### 2.7 自动化必须双重有界

必须分别限制：

- `MAX_ROUNDS`：正式实现—审查轮数；
- `MAX_QUOTA_RESUMES`：跨额度窗口恢复次数。

任一上限到达都停止并交还所有者。不能用额度恢复机制绕开审查轮数，也不能因审查
轮数未满而无限等待额度。

---

## 3. 四种 Agent 角色

## 3.1 GENERAL：默认通用身份

职责：

- 直接协助所有者；
- 分析、解释、规划和诊断；
- 在明确授权时维护项目或协作基础设施；
- 说明判断、验证、风险和未完成事项。

边界：

- 不自动加入轮转；
- 不冒充正式实现交接或正式审查；
- 不自行切换角色；
- 不自行启动其他 Agent，除非所有者明确要求。

## 3.2 IMPLEMENTER：专用实现身份

职责：

- 实现当前正式规格和执行切片；
- 处理上一轮必须修复的问题；
- 更新必要测试、工程事实和实现报告；
- 运行统一验证和相关浏览器检查；
- 完成一轮后退出。

边界：

- 不控制 Git stage、commit、push、部署或历史；
- 不修改角色、权限、审查和轮次控制面；
- 不改变目标或降低验收条件；
- 不启动 REVIEWER。

## 3.3 REVIEWER：专用独立审查身份

职责：

- 审查明确的目标提交与基准提交；
- 根据规格、测试、浏览器和可复现证据验收；
- 输出固定格式的 PASS 或 CHANGES_REQUIRED；
- 区分 Blocker、Major、Minor 和 Suggestion。

边界：

- 全程只读；
- 新进程、无实现会话继承；
- 不直接修复；
- 不增加规格外要求；
- 不以主观偏好阻断通过。

## 3.4 MONITOR：专用流程监督身份

职责：

- 核对本次角色、执行器、模型、effort、权限和任务注入；
- 检查父脚本、进程退出、锁、Git、运行清单和停止原因；
- 判断未知异常是否可以安全机械恢复；
- 生成简短事件报告与单一下一动作；
- 在最终终止时核对状态和简报是否完整。

不负责：

- 不评价业务实现质量；
- 不替 IMPLEMENTER 写代码；
- 不替 REVIEWER 作正式验收；
- 不干预正常工作的 Agent；
- 不用个人偏好改变循环。

MONITOR 的常规权限应等同只读 REVIEWER。若监督基础设施本身需要修改，必须停止
活动轮转，由所有者另行授权 GENERAL 维护。

---

## 4. 两层中立控制器

## 4.1 内层 cycle：有限质量闭环

内层控制器负责一个有界的实现—审查循环：

```text
READY
  ↓
IMPLEMENTER
  ↓
机械边界检查 + 统一验证 + 本地实现检查点
  ↓
REVIEWER（只读）
  ├─ PASS → COMPLETE
  └─ CHANGES_REQUIRED → 下一轮 IMPLEMENTER
```

它负责：

- 预检实现者和审查者；
- 严格串行启动新进程；
- 检查越权、Git 和报告格式；
- 创建本地实现/审查检查点；
- 执行 MAX_ROUNDS；
- 生成循环简报；
- 对退出原因进行结构化分类。

它不负责等待数小时，也不在失败后无限重试。

## 4.2 外层 supervisor：跨窗口运行

外层控制器把整个有界 cycle 当作一次可恢复尝试：

```text
SCHEDULED（可选）
  ↓
RUNNING cycle
  ├─ 成功 → COMPLETE
  ├─ 额度事件 → RECOVERY_CHECK → WAITING_FOR_QUOTA → RUNNING
  └─ 未知/不安全事件 → MONITOR EVENT → STOPPED
```

它负责：

- 可选的首次绝对启动时间；
- 调用内层 cycle；
- 读取当前尝试产生的结构化停止文件；
- 清除陈旧停止事件，避免误分类；
- 安全保存实现半成品；
- 记录当前阶段、尝试次数、恢复次数和绝对恢复时间；
- 在等待期间不运行 Agent；
- 从 IMPLEMENTER 或 REVIEWER 的中断阶段续跑；
- 对未知异常只唤醒一次 MONITOR；
- 执行 MAX_QUOTA_RESUMES。

它不评价代码，也不改变审查结论。

---

## 5. 额度中断恢复协议

只有明确分类为 `USAGE_OR_BILLING_LIMIT` 的事件可以自动进入额度恢复。

## 5.1 通用前置检查

1. 确认工作 Agent 及其进程组已退出；
2. 确认没有 IMPLEMENTER 与 REVIEWER 并存；
3. 检查 HEAD、refs、索引和工作区；
4. 检查受保护控制面是否被修改；
5. 记录中断阶段、退出码、日志和时间。

## 5.2 IMPLEMENTER 中断

若工作区干净，不需要恢复提交，等待后重新启动新 IMPLEMENTER 进程。

若存在修改，只有满足以下条件才可保存：

- 没有 staged 修改；
- 没有角色契约、父脚本、权限、审查历史等受保护路径变化；
- diff 通过基本机械检查；
- 运行统一验证并如实记录 PASS 或 FAIL；
- 本地提交标题明确包含 `recovery checkpoint`。

验证 FAIL 不必自动丢弃现场；它说明半成品尚未完成。只要边界安全，可以提交以便
恢复，且不得把它计作正式实现检查点。

## 5.3 REVIEWER 中断

REVIEWER 是只读角色，因此额度中断后工作区必须干净。若出现 tracked 或 untracked
业务修改，恢复不安全，应停止。

若现有实现检查点有效，恢复时直接启动新的 REVIEWER 进程，不应重复运行
IMPLEMENTER。

REVIEWER 的恢复现场必须同时保存目标提交和比较基准。不能一律假定基准是 `HEAD^`：
所有者在正式循环外形成的检查点、恢复检查点或随后追加的元数据提交，都可能让完整
实现跨越多个提交。恢复进程必须继续使用中断审查所记录的同一基准。

## 5.4 恢复时间

优先使用服务明确提供的绝对恢复时间。若只有窗口规律，则使用：

```text
resume_at = first quota boundary strictly later than stop_time
```

固定窗口应记录一个 reset anchor 和周期长度；后续恢复对齐
`anchor + N × window`，不能简单地从中断时刻再等待完整窗口，否则会无意义地错过
已经恢复的额度。状态文件应记录 UTC 绝对时间，用户界面可以另行显示本地时区。

到点后先重新预检。认证、权限或 MCP 失败不应伪装成额度问题。

---

## 6. 事件驱动监视

## 6.1 不需要 MONITOR Agent 的事件

以下情况由脚本直接处理：

- 子进程仍在正常运行；
- 心跳输出；
- 等待倒计时；
- 已知额度中断且现场安全；
- 到点后的同阶段续跑；
- 正常 PASS；
- 明确达到轮数或额度恢复上限。

## 6.2 需要唤醒 MONITOR 的事件

- 停止原因无法分类；
- 停止文件与实际退出阶段冲突；
- 工作 Agent 退出后仍有可疑子进程；
- REVIEWER 之后工作区变脏；
- Git HEAD、refs、索引或锁状态异常；
- 恢复检查点触及受保护路径；
- 脚本状态无法判断应从哪个角色恢复；
- 简报、运行清单或状态彼此矛盾。

MONITOR 事件报告应只有一个机械动作，例如：

```text
WAIT_FOR_QUOTA
RETRY_PREFLIGHT
STOP_OWNER
CONTROL_REPAIR_REQUIRED
```

报告必须说明证据、工作 Agent 是否仍存活、Git/控制面是否安全，以及下一步。

## 6.3 AI Token 成本判断

shell 进程持续等待主要占用少量内存和一个进程槽，不消耗模型 token。只有执行器
真正发起模型调用时才使用 Agent 配额。

因此：

- 允许 supervisor 数小时存在；
- 心跳由 shell 输出；
- 不要求一个 GENERAL 或 MONITOR 会话不断“看着”；
- 不为确认“仍在等待”而反复调用模型；
- 只在异常需要判断时支付推理成本。

单次 Agent timeout 也应按监督器实际活跃的轮询时间累计，而不是直接使用墙上时间
之差。笔记本睡眠或 WSL 暂停期间 Agent 不会工作；若把这段时间计入 timeout，
机器恢复时会错误终止本应继续的进程。

---

## 7. 权限模型

### IMPLEMENTER

- 工作区可写；
- 非交互；
- 禁止 Git stage/commit/push/reset/clean/rebase/switch；
- 禁止修改控制面；
- 禁止启动子 Agent；
- 只允许任务所需公开网络、构建和浏览器能力。

### REVIEWER 与 MONITOR

- 仓库只读；
- 非交互；
- 无 Write/Edit；
- 不控制 Git；
- 候选报告只写入被忽略的 artifacts；
- 由中立包装器安装正式审查报告。

### supervisor

supervisor 不是 Agent。它只拥有预先编码的有限动作：

- 写忽略目录中的状态、日志和锁；
- 在安全检查通过后创建本地 recovery checkpoint；
- 启动指定角色的新进程；
- 不 push、不部署、不修改目标。

---

## 8. 状态、证据与目录建议

```text
PROJECT.md                         当前事实
PROJECT_SPEC.md                    正式目标与验收
AGENT_PROTOCOL.md                  四角色共同协议
.agent/roles/*.md                  角色契约
.agent/runtime.env                 默认调用与恢复配置
.agent/state.env                   正式任务与审查轮次
.agent/artifacts/runs/             每次 Agent 调用清单
.agent/artifacts/runtime/          最近停止分类
.agent/artifacts/supervisor/       外层状态、事件、恢复日志
.agent/implementation-report.md    最近正式实现交接
.agent/latest-review.md            最近正式审查
.agent/review-history/             只追加审查历史
```

supervisor 状态至少包含：

```dotenv
SUPERVISOR_STATUS=WAITING_FOR_QUOTA
TASK_ID=...
CURRENT_STAGE=IMPLEMENTER
CURRENT_ATTEMPT=2
QUOTA_RESUMES=1
RESUME_AT=2026-07-23T17:42:15Z
LAST_EXIT_CODE=...
LAST_STOP_REASON=USAGE_OR_BILLING_LIMIT
IMPLEMENTER=claude/sonnet/high
REVIEWER=claude/sonnet/max
MONITOR=codex/gpt-5.6-terra/medium
UPDATED_AT_UTC=...
```

状态文件是恢复依据，不应包含密钥，也不应使用不可信内容作为 shell 代码执行。

---

## 9. 终止条件

自动轮转在以下任一条件成立时终止：

- REVIEWER 给出 PASS；
- 达到 MAX_ROUNDS；
- 达到 MAX_QUOTA_RESUMES；
- 认证、权限、付款或外部授权需要所有者；
- Git 或控制面状态不安全；
- 同一关键问题反复出现；
- 需要改变目标或产品决策；
- 验证环境不可靠；
- 未知事件经 MONITOR 判断应 STOP_OWNER；
- supervisor 自身控制逻辑需要修复。

终止后应保留：

- 最后安全提交；
- supervisor 终态；
- 最近停止分类；
- 各次调用清单和日志；
- 当前循环简报；
- 所有者下一步所需的最短说明。

终态写入必须先于最终简报生成。否则内层 cycle 在退出时生成的简报可能仍看到
supervisor 的旧 `RUNNING` 状态；外层控制器应在写入 `COMPLETE`、`STOPPED` 或
`WAITING_FOR_QUOTA` 后刷新最新简报。

---

## 10. 推荐操作流程

### 10.1 所有者

1. 明确目标与验收标准；
2. 更新当前执行切片；
3. 选择 IMPLEMENTER、REVIEWER、MONITOR 配置；
4. 设定 MAX_ROUNDS、MAX_QUOTA_RESUMES 和恢复时间；
5. 确认 Git 干净并运行预检；
6. 启动 supervisor；
7. 在终态阅读简报并进行主观验收。

### 10.2 supervisor

1. 取得全局监督锁；
2. 按可选首次时间零 Token 等待；
3. 启动有界 cycle；
4. 正常完成则写 COMPLETE；
5. 额度中断则检查并保存现场；
6. 写 WAITING_FOR_QUOTA 和绝对时间；
7. 到点从原阶段启动新进程；
8. 未知异常则调用一次 MONITOR 并停止；
9. 始终释放锁并保存终态。

### 10.3 所有者回来后

先看短信息：

```bash
supervisor status
cycle summary
git log --oneline
```

对某一轮感兴趣时，再查看对应实现报告、审查报告、调用清单和日志。

---

## 11. 必须测试的控制面行为

基础设施至少需要以下无真实 Agent 的模拟测试：

- IMPLEMENTER 正常退出后进入 REVIEWER；
- REVIEWER PASS 后完成；
- CHANGES_REQUIRED 后进入下一轮 IMPLEMENTER；
- IMPLEMENTER 额度中断后从 IMPLEMENTER 恢复；
- REVIEWER 额度中断后从 REVIEWER 恢复；
- 陈旧停止文件不会误分类新失败；
- 等待测试可跳过但保留目标时间状态；
- 最大恢复次数会停止；
- 非额度异常不会自动重试；
- 恢复现场触及受保护路径会拒绝；
- 两个 supervisor 不能同时取得锁；
- 运行配置和恢复状态可被简报追溯。

测试脚本不得启动真实 Agent、消耗真实额度或修改业务代码。

---

## 12. 反模式

### 反模式一：让工作 Agent 启动下一位 Agent

会产生重叠、孤儿进程和责任不清。交接应由等待子进程退出的中立控制器完成。

### 反模式二：让 MONITOR 持续调用模型轮询

等待本身不需要推理。频繁轮询只会增加 token、上下文和失败面。

### 反模式三：额度中断就从整轮开头重跑

会浪费已经形成的合法工作，并可能在已有实现检查点后重复实现。

### 反模式四：把 recovery checkpoint 当成实现完成

它可能验证失败、报告不完整，只是可追溯的现场保存。

### 反模式五：任何错误都按额度等待

认证、权限、MCP、Git、报告格式和代码失败具有不同处理方式。只允许结构化额度分类
进入自动等待。

### 反模式六：给 MONITOR 可写业务权限

MONITOR 一旦能直接修复，就同时成为监督者和实现者，失去边界。

### 反模式七：只有最大审查轮数，没有最大恢复次数

即使正式轮次不增加，也可能永久跨窗口重试。两类上限必须独立存在。

---

## 13. 从 v3.0 迁移到 v4.0

1. 保留 GENERAL、IMPLEMENTER、REVIEWER 契约；
2. 新增 `.agent/roles/MONITOR.md`；
3. 把协议中的“三种角色”改为“四种角色”；
4. 保留原有有界 cycle，不把它重写成无限守护进程；
5. 在其外新增 supervisor；
6. 为 cycle 增加从 IMPLEMENTER 或 REVIEWER 阶段恢复的明确入口；
7. 增加结构化停止原因与陈旧事件清理；
8. 增加额度等待、最大恢复次数和绝对恢复时间配置；
9. 增加安全 recovery checkpoint；
10. 增加事件驱动 MONITOR 报告；
11. 把 supervisor 状态加入 status 和简报；
12. 用假的 cycle 命令测试恢复路由；
13. 保留 v3.0 作为历史，不在原文件上覆盖改写。

---

## 14. 最小参考命令

普通、单窗口循环：

```bash
agent-cycle preflight
agent-cycle cycle
```

跨窗口监督循环：

```bash
agent-supervisor supervise \
  --implementer <executor> \
  --implementer-model <model> \
  --implementer-effort <effort> \
  --reviewer <executor> \
  --reviewer-model <model> \
  --reviewer-effort <effort> \
  --monitor <executor> \
  --monitor-model <model> \
  --monitor-effort <effort> \
  --max-quota-resumes <N>
```

定时首次启动：

```bash
agent-supervisor supervise --start-at "<absolute date/time>" ...
```

状态查看：

```bash
agent-supervisor status
agent-cycle status
agent-cycle summary
```

---

## 15. 最终原则

多 Agent 协作的价值不来自“同时开更多模型”，而来自明确分工、证据隔离和可靠
交接。长时间自动化的价值也不来自“让一个 AI 一直醒着”，而来自把推理与计时分开：

```text
人决定目标；
IMPLEMENTER 构建；
REVIEWER 验收；
MONITOR 处理未知流程事件；
中立脚本串行、等待、记录、恢复和终止。
```

只有需要判断时才调用模型；能由状态机完成的事交给状态机。这是 v4.0 相对于 v3.0
最重要的工程改进。
