# AI Project Meta Method v7.0

版本：v7.0

日期：2026-07-31

## 1. 本版结论

一个正式目标仍由三种身份协作：

- `GENERAL`：所有者的通用协作者、控制面维护者和轮转监督者；
- `IMPLEMENTER`：在受限写权限下形成业务交付；
- `REVIEWER`：在只读权限下为下一轮实现准备独立证据。

角色不与 Claude、Codex 等执行器绑定。v7 在 v6 的统一 GENERAL 基础上增加一个
有界的 **IMPLEMENTER 后继链**：所有者可以预先指定“主实现者 + 一个不同执行器的
后继实现者”。主实现者只有在确认遇到真实额度上限后，才把同一轮回串行交给后继。

这不是并行多 Agent，也不是第二轮实现，而是同一交付在执行器不可用时的连续恢复。

## 2. 计量单位

一次轮回固定等于一份完成的 IMPLEMENTER 交付：

```text
正常轮回：IMPLEMENTER 段 1 → 完成

额度后继轮回：IMPLEMENTER 段 1（主）
             → recovery checkpoint
             → IMPLEMENTER 段 2（后继）
             → 完成
```

进程、模型工具轮次、自主切片、上下文 generation、恢复检查点和后继段都不是新的
轮回。只有正式交付完成后才增加 `CURRENT_ROUND`。

REVIEWER 仍只出现在相邻两次实现交付之间；最终一轮由所有者先查看。所有者满意时
无需机械补审查，追加轮回时再先审查待定实现。

## 3. 为什么需要后继实现者

长任务可能同时面对两种不同边界：

1. 单个会话上下文越来越昂贵，需要在安全检查点后压缩换代；
2. 某个执行器的订阅额度暂时耗尽，但另一个执行器仍可工作。

第一种边界应使用同一运行时的新 session generation；第二种边界才使用不同执行器
的后继。把两者混为一谈会导致错误换人、重复读取、额度浪费和并行分叉。

后继机制的目的，是减少纯等待时间，同时保留明确责任、完整审查范围和可追溯用量，
不是为了让多个模型同时修改同一个工作区。

## 4. 不可违反的触发条件

后继切换必须同时满足：

- 当前角色是 `IMPLEMENTER`；
- 当前运行时是尚未切换过的主实现者；
- 后继已由所有者或运行配置预先启用；
- 后继使用不同执行器；
- 运行时终态被结构化证据归类为 `USAGE_OR_BILLING_LIMIT`；
- 前一工作 Agent 和进程组已经完全退出；
- 工作区通过受保护路径、Git 与恢复检查点检查。

以下情况不得触发后继：

- `AUTONOMY_SLICE_LIMIT`；
- timeout；
- 登录、权限、MCP 或模型不可用；
- 验证失败、报告失败、策略越权或普通程序错误；
- REVIEWER 额度不足；
- GENERAL 主观认为“换一个模型可能更好”。

这些事件分别进入原有的上下文决策、修复、等待或所有者决策路径。

## 5. 严格串行交接

切换顺序必须是：

```text
确认额度终态
→ 等待主实现者进程完全退出
→ 记录该段运行清单与用量
→ 检查允许写入范围
→ 运行验证并创建 recovery checkpoint
→ 归档主实现者会话并标记 SUPERSEDED
→ 生成结构化后继交接
→ 启动后继的新 IMPLEMENTER 会话
```

在后继启动前，主实现者不再运行；GENERAL 只在安全边界写控制状态。后继一旦开始
写入，流程不得恢复主实现者，避免从共同祖先形成两条实现分支。

当前后继链最大长度为 2，最多切换一次。后继也遇到额度上限时，等待并恢复后继自身
会话，不回切主实现者，也不继续寻找第三个执行器。

## 6. 会话语义

正常额度恢复保持同一任务、同一角色、同一执行器、同一模型和 effort 的逻辑会话。
上下文超过阈值时创建新 generation，但它仍属于同一运行时逻辑会话。

执行器后继不同：

- 主实现者 role session 归档后标记 `SUPERSEDED`；
- 后继创建全新的 IMPLEMENTER role session；
- 后继不继承主实现者 transcript 或未记录推理；
- 连续性只来自 Git 恢复提交、正式任务、现行规格、实现报告和结构化交接；
- 后继与 REVIEWER 即使都由 Codex 承担，也必须使用不同会话、不同进程和不同权限。

因此“保持目标连续性”不等于“强行保持同一个聊天记录”。跨执行器时，仓库证据才是
权威记忆。

## 7. 审查范围

每轮实现开始前创建不可变的 `ACTIVE_IMPLEMENTATION_REVIEW_BASE_COMMIT`。主实现段、
recovery checkpoint 和后继实现段都沿用这一基线。

最终 REVIEWER 比较：

```text
原始轮回基线 .. 最终正式实现提交
```

不能把后继启动时的 recovery commit 当作新基线，否则主实现者完成的改动会从审查
范围中消失。一轮只产生一次正式实现完成状态和一次最终实现提交。

## 8. 结构化交接的最小内容

交接文件至少记录：

- 任务 ID 与逻辑轮回编号；
- 主实现者和后继的执行器、模型、effort；
- 真实停止原因；
- 原始轮回审查基线与 recovery commit；
- 主实现者日志、用量摘要和已归档会话证据；
- 从原始基线到恢复提交的改动路径与检查点；
- 不重复工作、不回切和先核对 Git 的明确约束。

交接文件放在被 Git 忽略的运行制品目录；正式业务事实仍须由最终实现报告和 Git
提交保存。

## 9. 用量效率

主实现者和后继分别记录用量，监督窗口账本累计但不混淆归属。判断效率时比较：

- agentic turns；
- input、cache creation、cache read 与 output；
- 最后一轮上下文大小；
- API 活跃时间与外部工具等待时间；
- 每段形成的可验证业务成果。

真实额度切换不消耗 `MAX_QUOTA_RESUMES`；它是一次预配置的执行器接班。后继额度等待
才增加额度恢复计数。自主切片也不能假装成额度事件来触发免费换人。

## 10. 配置与可关闭性

项目配置应把主实现者、后继和审查者分开：

```dotenv
IMPLEMENTER_AGENT=claude
IMPLEMENTER_MODEL=sonnet
IMPLEMENTER_EFFORT=high
IMPLEMENTER_SUCCESSOR_ENABLED=yes
IMPLEMENTER_SUCCESSOR_AGENT=codex
IMPLEMENTER_SUCCESSOR_MODEL=gpt-5.6-sol
IMPLEMENTER_SUCCESSOR_EFFORT=high
REVIEWER_AGENT=codex
REVIEWER_MODEL=gpt-5.6-sol
REVIEWER_EFFORT=high
```

每次运行可以覆盖或用 `--no-implementer-successor` 关闭。若主实现者本身是 Codex，
而默认后继也是 Codex，预检必须失败并要求显式关闭或选择不同执行器，不能执行无意义
的同额度账户切换。

## 11. 状态与审计

监督状态至少公开：

- `PRIMARY_IMPLEMENTER`；
- `ACTIVE_IMPLEMENTER`；
- `IMPLEMENTER_SUCCESSOR`；
- `IMPLEMENTER_SWITCHES`；
- `IMPLEMENTER_SEGMENT`；
- `IMPLEMENTER_HANDOFF`；
- `SUPERSEDED_SESSION_ARCHIVE`；
- 原有的当前阶段、额度恢复次数、停止原因和用量账本。

轮回简报必须显示实际运行时链，而不能只显示默认配置或最终后继。运行清单用
`IMPLEMENTER_SEGMENT` 和 `SUCCESSOR_HANDOFF_FILE` 把每段与同一轮回关联。

## 12. 验收条件

- 主实现者额度终态只触发一次 Claude → Codex 串行切换；
- 第二段启动参数确实使用 Codex，且有新的 IMPLEMENTER 会话；
- 前任会话已归档并标记 `SUPERSEDED`；
- 原始审查基线跨 recovery checkpoint 保持不变；
- `CURRENT_ROUND` 在后继正式完成前不增加；
- 后继额度耗尽时等待/恢复 Codex，不回到 Claude；
- REVIEWER 额度耗尽时不触发实现者后继；
- 自主切片、timeout 和普通失败不触发后继；
- 全程任意时刻最多一个工作 Agent；
- 状态、简报、运行清单和结构化交接能够还原整条责任链。
