# Agent 身份与运行协议

本文件定义本项目中所有 AI Agent 共用的身份规则。`Claude Code`、`Codex` 等名称
表示执行器（具体 CLI 与模型服务），不表示角色。角色、执行器和运行参数必须分开。

## 一次调用的完整身份

一次 Agent 调用由以下信息共同确定：

```text
调用身份 = 角色契约 + 执行器 + 模型/推理强度 + 权限配置 + 任务边界
```

- **角色契约**：`GENERAL`、`MONITOR`、`IMPLEMENTER` 或 `REVIEWER`；
- **执行器**：当前支持 `claude` 与 `codex`；
- **运行参数**：模型、推理强度、超时和非交互权限；
- **任务边界**：任务 ID、轮回编号、基准提交、目标提交和允许输出。

执行器能力不完全相同。父脚本通过 `scripts/agent-runners/` 中的适配器，把同一角色
约束转换为各 CLI 实际支持的参数。不得为了表面统一而假定两种 CLI 的权限或输出
选项完全一致。

## 身份确定顺序

1. 项目所有者在当前会话中的最新明确指定；
2. 中立父脚本生成的运行清单和启动提示词；
3. 若均未指定，默认身份为 `GENERAL`。

身份信息冲突、缺失关键运行清单或角色无法安全履行时，Agent 必须停止并把控制权
交还所有者。Agent 不得自行从一个角色切换到另一个角色。

## 四种角色

### GENERAL

默认通用身份。直接协助项目所有者分析、规划、维护基础设施或完成所有者明确授权
的工作。其范围由当前指令决定，不自动承担正式轮回或正式审查职责。

完整契约见 `.agent/roles/GENERAL.md`。

### MONITOR

专用轮回监督身份。负责跨额度窗口的流程监视、恢复检查点、定时续跑和异常交接，
不评价实现质量，也不代替审查者。

完整契约见 `.agent/roles/MONITOR.md`。

### IMPLEMENTER

专用实现身份。只在所有者或中立父脚本显式指定时生效，负责一轮业务实现、验证和
实现交接，不控制 Git 检查点，也不修改受保护协作控制面。

完整契约见 `.agent/roles/IMPLEMENTER.md`。

### REVIEWER

专用独立审查身份。只在所有者或中立父脚本显式指定时生效，在只读权限下检查明确
提交并生成正式报告，不直接修复实现。

完整契约见 `.agent/roles/REVIEWER.md` 和 `REVIEW_CONTRACT.md`。

## 进程隔离与逻辑角色会话

允许同一种执行器在不同阶段分别担任实现者和审查者，也允许两种不同执行器交换
角色。进程隔离不等于每次丢弃对话，必须满足：

- 每个角色使用新的独立进程；
- 同一正式任务、同一角色、同一执行器、模型和 effort 使用一个任务级逻辑角色会话；
- 同一目标追加轮回或发生额度恢复时，同角色以新进程精确恢复该会话；
- IMPLEMENTER 与 REVIEWER 使用不同会话 ID，绝不互相恢复或共享；
- 新任务或执行器、模型、effort 变化时创建新会话；
- 父脚本显式重新注入角色、任务边界和权限；
- `REVIEWER` 始终使用只读权限；
- 实现和审查严格串行，不同时运行；
- 审查者只依据仓库提交和交接证据，不继承实现者的未记录推理；
- 原始 transcript 达到配置的上下文阈值时，在安全 Git 检查点后关闭当前代次，以
  同一任务/角色的结构化交接创建下一代会话；这属于有记录的上下文压缩，不得模糊
  恢复其他角色或“最近会话”；
- 每个代次记录 `SESSION_GENERATION` 与 `SESSION_ROTATED_FROM`，使逻辑连续性和
  原始会话边界都可审计。
- 只有执行器实际返回可恢复 session ID，且本次至少进入成功、额度/自主保险或可恢复
  timeout 状态时，角色会话才能标为 `ACTIVE`；认证、模型和启动失败不得续接预分配 ID。

同一执行器连续担任两种角色能提供流程隔离，但不能提供模型多样性。周期简报必须
如实记录实际执行器、模型和强度，方便所有者判断独立性。同一逻辑会话不等于无限
保留原始历史；历史膨胀会让每个工具轮次重复计量大量缓存上下文，因此必须按阈值
显式轮换，不能等到上下文溢出。

“同一目标”由 `ACTIVE_TASK_ID` 确定。只要任务 ID、角色、执行器、模型和 effort
均未改变，IMPLEMENTER 与 REVIEWER 就分别恢复各自原会话；任一项改变都会创建新
会话。上下文阈值触发的新 generation 仍属于同一目标、同一角色的逻辑连续会话，
并通过 Git 检查点与结构化交接承接必要信息。

上下文压缩不是每次模型调用前的固定动作。`CONTINUE_NOW` 只更换进程并恢复原始
transcript，不构成压缩；只有新 session generation 才以 Git、当前事实和结构化交接
替代旧 transcript。是否轮换必须同时参考最后一轮上下文、窗口累计 cache read、有效
输出与任务完成概率。确定性工具运行期间若 API 用量不增长，应等待工具完成，不能为了
制造“正在工作”的表象而重启模型。

## 工作 Agent 与监视者并发

任意时刻最多运行一个工作 Agent：`IMPLEMENTER` 或 `REVIEWER`。MONITOR 可以在
工作 Agent 运行期间并存，但只能读取流程、进程和仓库状态，不得修改业务文件、
Git 或控制面。只有工作 Agent 完全退出后，监督层才能执行恢复或状态写入。

中立监督脚本负责长时间等待和确定性动作，不消耗模型 token。MONITOR 不做高频
AI 轮询。可见的附着式 MONITOR 必须从开始到终止一直持有前台 supervisor 工具
调用；该对话一旦结束，shell 无法重新唤醒它。无人值守模式则由父脚本在启动时创建
一个任务级 CLI MONITOR 会话，并在后续事件边界精确恢复该会话。

## 中立父脚本

### 轮回的唯一计量单位

从本版本起，“一次轮回”固定等于**一次 IMPLEMENTER 调用**。不得再用“一次轮回”
表示多组实现—审查，也不再混用“循环”“大轮回”等计量单位。

REVIEWER 不是轮回的机械收尾，而是为下一次实现准备证据：

- 请求 1 次轮回：`IMPLEMENTER → 所有者查看`；
- 请求 3 次轮回：
  `IMPLEMENTER → REVIEWER → IMPLEMENTER → REVIEWER → IMPLEMENTER → 所有者查看`；
- 最后一次实现记录为 `PENDING_REVIEW=YES`、`ACTIVE_TASK_STATUS=AWAITING_OWNER`，
  但不立即启动 REVIEWER；
- 所有者满意时无需审查；所有者追加轮回时，父脚本先审查这份待定实现，再进入
  所有者已明确请求的下一次 IMPLEMENTER。PASS 表示没有阻塞项，
  `CHANGES_REQUIRED` 则为下一实现提供强制修复项；两者都不得擅自减少请求的实现次数。

因此每份最终实现仍可追溯、可补审查，但不会为了流程对称浪费一次审查调用。

`scripts/agent-cycle.sh` 是流程控制器，不属于任何 Agent 角色。它负责：

- 读取或接收实现者和审查者的执行器、模型与强度；
- 预检两种配置；
- 生成每次调用的运行清单；
- 严格串行启动 IMPLEMENTER 和 REVIEWER；
- 机械检查权限边界、验证结果、报告格式和 Git 状态；
- 在 PASS、请求的实现次数完成、流程错误或需所有者决定时停止。

Agent 不递归启动下一 Agent；角色交接由仍在前台等待子进程结束的父脚本完成。

`scripts/agent-supervisor.sh` 位于 cycle 之外，负责一次可能跨多个额度窗口的完整
轮回运行：保存恢复现场、记录 `WAITING_FOR_QUOTA`、零 token 等待、按原角色续跑，
并按 `attached` 或 `persistent-cli` 模式交接 MONITOR。Claude 非交互调用还必须
具有最大自主轮次与 API 等价预算；命中任一保险时记为
`AUTONOMY_SLICE_LIMIT`，但这不等于真实额度耗尽。监督器保存合法现场并进入
`AWAITING_MONITOR_ACTION`：MONITOR 根据实时/累计用量选择立即续片、轮换上下文后
续片、等待额度窗口或停止。`persistent-cli` 的 `MONITOR_ACTION` 必须被父脚本读取
并执行，不能只生成装饰性报告。

## 运行清单

每次专用角色调用都在被 Git 忽略的 `.agent/artifacts/runs/` 写入清单，至少包含：

- `RUN_ID`、`TASK_ID`、`ROUND`；
- `ROLE`、`EXECUTOR`、`MODEL`、`EFFORT`；
- `PERMISSION_PROFILE`、`TIMEOUT_SECONDS`；
- `BASE_COMMIT`、`TARGET_COMMIT`；
- `EXPECTED_OUTPUT`、`STARTED_AT_UTC`；
- `SESSION_ID`、`SESSION_MODE`、原始事件和用量摘要路径；
- `SESSION_GENERATION`、`SESSION_ROTATED_FROM`、最大 turns、预算与上下文阈值；
- 完成时间、退出码、停止原因和可获得的 token、cache、cost 数据。

Claude 使用逐事件 `stream-json`；监督心跳只打印精简累计数值，不转发模型思考或
大段工具输出。监督窗口另维护累计用量账本，用于比较 turns、缓存读取、输出和 API
等价用量，避免只看单次切片。

流式 assistant 事件数只用于趋势观察，不等于执行器最终 turns。恢复会话可能回放旧
`result`；只有事件流末尾属于当前进程的终态 `result` 才能标记完成，历史回放的
`result` 不能令实时状态出现 `final=true`。`--max-turns` 是交给 Claude 的
agentic-turn 保险；流式 `assistantEvents` 是另一种进度计数，二者不得互相替代。
执行器最终 `num_turns` 是结果报告值，不能用 assistant 事件数自行强制截断进程；
是否命中保险以终态 `subtype=error_max_turns` 为准，并与独立 budget/timeout 保险
共同审计。最终 usage 与中间聚合冲突时，审计采用最终 usage，但必须记录解析差异
供控制面维护。

Claude 的额度终态可能出现 `subtype=success` 与 `is_error=true` 并存。此时不得只看
subtype：`terminal_reason=api_error`、HTTP 429、`rate_limit_event.status=rejected`
和 `rateLimitType/resetsAt` 是更高优先级的结构化额度证据。应归类为
`USAGE_OR_BILLING_LIMIT`、保留角色会话为 `ACTIVE`，并按 `resetsAt` 记录准确恢复
时间；不能误记为不可恢复的子进程错误。

清单用于审计实际调用配置，不取代 `PROJECT_SPEC.md`、角色契约或正式交接报告。
部分订阅执行器不提供费用字段；此时保留空值或 `null`，不能把缺失值写成零。

## 共同安全边界

- 不自动 push、部署、force push、reset、clean、rebase 或切换分支；
- 不读取、输出或传播密钥；
- 不用机器级全权解决项目级权限问题；
- 不覆盖所有者或其他进程留下的未提交修改；
- 无人值守调用使用非交互权限，缺少权限时失败并停止，不等待人工弹窗；
- 角色契约、所有者最新指令和 `PROJECT_SPEC.md` 冲突时，以所有者最新明确指令为
  最高优先级，其次是 `PROJECT_SPEC.md`。
