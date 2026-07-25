# AI Project Meta Method v5.0

## 面向可恢复会话与用量预算的人—多 Agent 角色化协作元方法

- 版本：v5.0
- 日期：2026-07-24
- 实证修订：2026-07-25
- 状态：正式版本（已加入一次真实 Opus 高强度轮转的用量校准）
- 适用范围：由项目所有者、一个或多个 AI 执行器和中立脚本长期共同维护的项目
- 核心变化：在 v4.0 的跨额度窗口监督之上，补齐会话所有权、可见 Monitor 附着、
  后台 Monitor 持久化、无人值守用量预算、实时遥测、可执行决策握手和上下文代次轮换

---

## 1. v5.0 解决的问题

v4.0 已经明确：

- GENERAL、MONITOR、IMPLEMENTER、REVIEWER 是角色，不是 Agent 品牌；
- IMPLEMENTER 与 REVIEWER 严格串行；
- 中立 cycle 控制有限质量闭环；
- supervisor 负责跨额度窗口等待和恢复；
- 已知事件由脚本处理，未知事件交给只读 MONITOR。

实践又暴露出两个缺口。

### 1.1 “恢复会话”不是一个统一能力

父脚本创建的 CLI 会话可以保存明确的 session ID，并由执行器的 `resume` 接口恢复。
但所有者在 IDE、网页或宿主应用中打开的可见对话，不一定向本地 shell 提供“注入
消息并唤醒旧回合”的能力。

因此不能只写“恢复 Codex”或“恢复 Claude”，必须问：

1. 该会话由谁创建？
2. session ID 由谁保存？
3. 执行器是否提供明确的 resume 接口？
4. 恢复后输出到 CLI，还是能回到原 UI？
5. 当前可见 Monitor 回合是否仍然保持活动？

### 1.2 一个 Agent 进程不等于一次模型调用

无人值守编码进程通常是：

```text
模型推理
→ 工具调用
→ 工具结果进入对话
→ 再次模型推理
→ 下一工具调用
→ …
```

一次连续运行可以包含数十或上百个模型轮次。每轮不仅生成新 token，还会携带此前
对话、工具结果、读过的文件和系统工具定义。即使输入命中缓存，缓存读取仍被计量。

模型的生成 speed 主要影响输出延迟和服务档位，不等于限制缓存上下文的重复处理
速度。一个处于 standard speed 的会话，仍可能因高频工具循环和巨大历史在几分钟内
消耗大量额度。

---

## 2. 基本对象

一次正式 Agent 调用由六部分组成：

```text
调用 = 角色 + 执行器 + 模型/effort + 权限 + 任务边界 + 自主预算
```

- 角色：GENERAL、MONITOR、IMPLEMENTER、REVIEWER；
- 执行器：Claude Code、Codex 或其他具备适配器的 CLI；
- 模型/effort：本次实际模型和推理强度；
- 权限：只读、工作区写入、允许工具和禁止动作；
- 任务边界：任务 ID、轮次、基准提交、目标提交和交接文件；
- 自主预算：最大模型轮次、API 等价预算、timeout 和上下文代次阈值。

角色与执行器不得绑定。自主预算也不能隐藏在执行器默认值中，必须进入调用清单。

---

## 3. 四种角色

### 3.1 GENERAL

所有者直接协作的默认身份，可在明确授权下维护业务、控制面、文档或方法论。
GENERAL 不自动加入正式循环，也不能把普通检查冒充 REVIEWER 结论。

### 3.2 IMPLEMENTER

在可写工作区中完成一个有边界的实现切片，运行验证并生成结构化实现交接。
IMPLEMENTER 不控制 Git 历史，不启动下一 Agent，不修改受保护控制面。

### 3.3 REVIEWER

在只读权限下审查明确的 base/target，输出固定格式的 PASS 或
CHANGES_REQUIRED。REVIEWER 不直接修复，不继承 IMPLEMENTER 的未记录推理。

### 3.4 MONITOR

监督进程、锁、Git、停止原因、额度窗口、恢复检查点和运行清单。MONITOR 不评价
业务质量，不代替 IMPLEMENTER 或 REVIEWER。

MONITOR 有两种运行形态：

- `attached`：所有者明确任命一个当前可见对话为 MONITOR；它从开始到终止持有
  supervisor 的前台工具调用；
- `persistent-cli`：父脚本创建一个任务级 CLI MONITOR，在每个事件边界用明确
  session ID 恢复。

两者职责相同，但可见性和唤醒机制不同。

---

## 4. 会话所有权与恢复

### 4.1 父脚本创建的 CLI 会话

父脚本必须：

1. 在第一次调用前分配或接收 session ID；
2. 把 ID、角色、任务、执行器、模型和 effort 写入会话状态；
3. 后续只按明确 ID 恢复；
4. 禁止使用“最近会话”；
5. 每次启动仍重新注入角色、权限和任务边界；
6. 在运行清单中记录 `new` 或 `resume`。

只要执行器提供 resume 接口，父脚本可以用新进程恢复旧 CLI 对话。进程连续性不是
会话连续性的必要条件。

### 4.2 宿主 UI 中的可见会话

本地 shell 通常不能保证唤醒已结束的 IDE/网页对话。即使底层执行器也支持
`resume`，shell 启动的仍是新的 CLI 进程，其输出不会自动出现在原 UI。

因此：

- 可见 MONITOR 必须从开始就保持自己的当前回合；
- supervisor 作为该回合的前台子进程存在；
- 等待由 shell 完成，不请求模型；
- supervisor 返回事件后，同一可见 MONITOR 才继续推理；
- 一旦该回合结束，只能由所有者再次发消息，不能假定父脚本会唤醒它。

这是一条产品边界，不应通过伪造“后台仍在推理”的表述掩盖。

---

## 5. 逻辑角色会话与上下文代次

### 5.1 默认连续性

同一正式任务、角色、执行器、模型和 effort，默认使用一个任务级逻辑角色会话。
额度恢复和下一正式轮次启动新进程，但恢复该角色自己的明确 session ID。

IMPLEMENTER、REVIEWER 和 CLI MONITOR 各自隔离，绝不跨角色共享。

### 5.2 为什么不能无限恢复原始 transcript

每次工具调用之后，历史会再次成为下一轮输入。上下文从 5 万增长到 30 万 token
时，即使输出速度相同，每轮输入成本也可能增长数倍。等到上下文窗口溢出才处理，
通常已经先耗尽额度。

因此：

```text
同一逻辑会话 ≠ 永久保留同一个原始 transcript
```

### 5.3 代次轮换

当最后一个模型轮次的缓存上下文达到配置阈值：

1. 当前 Agent 进程完全退出；
2. supervisor 检查权限、Git、索引和受保护路径；
3. 合法实现半成品形成 recovery checkpoint；
4. 当前 session 状态标为 `ROTATE_REQUIRED`；
5. 下一次为同一任务/角色创建新 session ID；
6. 写入 `SESSION_GENERATION=N+1`；
7. 写入 `SESSION_ROTATED_FROM=<old-id>`；
8. 新代次只读取当前事实、任务、正式报告、Git 差异和直接相关代码。

这是一种有证据的上下文压缩。旧 transcript 保留用于审计，但不再参与每轮推理。

### 5.4 压缩不是逐调用动作

上下文压缩不应在每次模型调用前机械执行。一个 Agent 进程内部通常包含多个模型—
工具轮次；正常轮次需要保留刚建立的代码理解、工具结果和局部计划。逐轮压缩会丢失
工作状态，迫使模型重新读取项目，可能比继续使用缓存更昂贵。

如果初始上下文为 `C`，每轮增加 `d₁、d₂……`，则后续输入近似为：

```text
C
C + d₁
C + d₁ + d₂
C + d₁ + d₂ + d₃
...
```

因此危险不是“初次读取很大”本身，而是早期内容在大量后续轮次中反复成为
cache read。切片停止也不自动等于压缩：`CONTINUE_NOW` 会以新进程恢复原始
transcript；只有 `ROTATE_AND_CONTINUE` 或阈值触发的新 session generation 才会
丢弃原始历史，以 Git 和结构化交接恢复。

正确策略是动态选择：

- 上下文仍小、产出有效、任务接近完成：恢复原会话；
- cache read 相对输出快速增长、最后上下文接近阈值：轮换后继续；
- 工具仍在确定性运行且模型用量不增长：等待工具，不为追求“活跃”而重启模型；
- 没有有效产出、额度接近边界或状态不安全：等待或停止。

---

## 6. 无人值守自主预算

### 6.1 三种不同上限

- `timeout`：限制进程实际被监督运行的时间；
- `max turns`：限制一次非交互调用内的模型—工具循环次数；
- `max budget`：限制一次调用的 API 等价 token 成本。

三者不能互相替代。timeout 无法防止模型在十分钟内完成五十次高上下文调用；
max turns 也无法防止少数超大轮次消耗预算。

### 6.2 推荐默认策略

对 Claude `--print` 或等价 SDK 调用：

- IMPLEMENTER：中等 turns 上限 + 明确预算；
- REVIEWER：更少 turns + 较小预算；
- MONITOR：少量 turns + 很小预算；
- 所有角色记录最后一轮缓存上下文；
- 保险任一先到即停止，不允许 Agent 自行绕过。

具体金额必须由项目按模型、计划和历史遥测调整，不应复制为跨项目常数。

### 6.3 停止分类

主动预算或 turns 保险统一分类为：

```text
AUTONOMY_SLICE_LIMIT
```

它不是失败的正式审查轮次，也不代表额度已经耗尽。安全保存顺序与额度中断相同，
后续路由不同：

```text
工作 Agent 退出
→ 检查边界
→ 保存合法现场
→ AWAITING_MONITOR_ACTION
  ├─ CONTINUE_NOW → 新进程恢复原角色
  ├─ ROTATE_AND_CONTINUE → 新上下文代次恢复原角色
  ├─ WAIT_FOR_QUOTA → WAITING_FOR_BUDGET_WINDOW
  └─ STOP_OWNER → STOPPED
```

`USAGE_OR_BILLING_LIMIT` 才能自动证明应等待额度窗口。自主保险后的立即续片必须
经过 Monitor 决策，并受每窗口最大切片数约束，不能无限自动重启。

### 6.4 实时遥测与窗口账本

非交互执行器应使用逐事件输出；监督心跳只读取并打印数值摘要：

- 当前模型 turns；
- input、cache read、cache creation 与 output tokens；
- 最后一轮缓存上下文；
- 结束后的 API 等价用量和停止 subtype。

监督器还应维护本次窗口的累计账本。单次切片看似便宜，不代表连续恢复后的总量仍
安全；Monitor 的决定必须同时参考当前切片与窗口累计值。模型思考、大段工具输出和
源文件内容不得作为“实时监控”反复打印。

### 6.5 用量诊断：创建、读取、输出与时间

诊断异常额度时至少分开比较：

- `cache creation`：本轮首次建立的新上下文；
- `cache read`：已建立上下文在后续模型调用中的重复读取；
- `output`：模型实际生成；
- `duration`：进程墙上时间；
- `API duration`：模型服务实际活跃时间。

一次真实项目的对照如下。两次任务不完全相同，数字不能当通用定额，但能定位数量级：

| 运行 | turns | cache creation | cache read | output | API 等价量 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 未受控的长 IMPLEMENTER | 100 | 332,340 | 26,864,092 | 76,839 | `$18.68` |
| 有界 IMPLEMENTER + REVIEWER 完整轮转 | 61 | 355,644 | 3,874,855 | 69,383 | `$7.23` |

两者的 cache creation 和 output 接近，但 cache read 相差约 6.9 倍。这说明主要差异
不是父脚本重复注入几 KB 启动提示，也不是模型少输出了一个数量级，而是长 transcript
在后续轮次中被反复读取。应优先比较 `cache read / turn`、最后一轮上下文和有效产出，
而不是只看输出速度或进程已运行多久。

墙上时间也不能直接代表额度速度。浏览器、构建和测试可能运行数分钟而 API 用量保持
不变；此时等待确定性工具通常比中断后让模型重新读取项目更节省。反过来，一个几乎
全程处于 API 活跃状态的高频工具循环，即使墙上时间不长，也可能快速耗尽窗口。

API 等价量只用于项目内部控制和相对比较，不等于订阅页面的精确扣减。

### 6.6 流式遥测的判读边界

实时事件是监督证据，不一定等同于执行器的最终计费口径：

- `assistant` 事件数可能包含内容块或工具相关消息，不能直接冒充正式 `num_turns`；
- `resume` 事件流可能先回放旧会话的历史 `result`，本次调用结束必须以最后一个属于
  当前调用的终态结果和进程退出为准；
- 执行器最终报告的 turns 可能超过命令行保险的名义值，因此 max turns 不能替代
  max budget、timeout 和窗口累计账本；
- 中间流式聚合适合观察趋势，最终审计必须使用执行器终态 usage。

适配器应为每次调用建立明确的事件边界；在无法可靠区分回放与新事件时，实时界面必须
标记为估算，不能提前触发正式成功、失败或额度决策。

---

## 7. 两层控制器

### 7.1 cycle

```text
IMPLEMENTER
→ 机械边界检查
→ 统一验证
→ 本地实现检查点
→ REVIEWER
→ PASS 或下一正式轮次
```

cycle 只管理有限轮次，不等待数小时。

### 7.2 supervisor

```text
SCHEDULED
→ RUNNING
  ├─ SUCCESS → COMPLETE
  ├─ USAGE_OR_BILLING_LIMIT → recovery → WAITING_FOR_QUOTA
  ├─ AUTONOMY_SLICE_LIMIT → recovery → AWAITING_MONITOR_ACTION
  └─ 不安全/未知 → MONITOR → STOPPED
```

supervisor 负责：

- 固定额度窗口锚点；
- 最大恢复次数；
- recovery checkpoint；
- 原阶段恢复；
- Monitor 模式；
- Monitor 动作握手与执行；
- 实时用量和监督窗口累计账本；
- 状态、事件和简报。

它不判断业务质量，不改变正式审查结论。

---

## 8. Monitor 的两种标准流程

### 8.1 attached

```text
所有者任命当前对话为 MONITOR
→ MONITOR 前台启动 supervisor
→ shell 启动工作 Agent
→ shell 等待/心跳
→ 安全边界进入 AWAITING_MONITOR_ACTION
→ 同一 MONITOR 对话读取用量并提交带事件 ID 的动作
→ supervisor 校验并继续、轮换、等待或终止
```

等待期间可以有一个 shell 进程和一个仍打开的 Agent 工具调用，但没有持续模型
推理。不要用每分钟一次的 AI 轮询模拟“在线”。

### 8.2 persistent-cli

```text
supervisor 启动事件
→ 创建 CLI MONITOR session
→ 工作 Agent 串行运行
→ 事件边界恢复同一 MONITOR session
→ 输出只读事件报告和唯一 MONITOR_ACTION
→ supervisor 解析并执行动作
```

该模式可以无人值守，但报告位于终端或 artifacts，不会唤醒所有者原来的 UI 对话。
只生成报告却忽略 `MONITOR_ACTION` 不构成自动监督。

---

## 9. 权限

### IMPLEMENTER

- 工作区写入；
- 非交互；
- 禁止 Git 历史控制、push、deploy、reset、clean、rebase；
- 禁止控制面和其他角色报告；
- 禁止启动子 Agent；
- 工具白名单与任务相匹配。

### REVIEWER 与 MONITOR

- 仓库只读；
- 非交互；
- 无 Write/Edit；
- 报告只写忽略 artifacts；
- 正式报告由中立包装器安装。

### supervisor

- 只执行预先编码的有限动作；
- 仅在机械安全检查后创建本地 recovery checkpoint；
- 不执行产品判断；
- 不使用机器级全权。

---

## 10. 最小运行清单

每次专用调用至少记录：

```dotenv
TASK_ID=...
ROLE=IMPLEMENTER
EXECUTOR=claude
MODEL=...
EFFORT=...
SESSION_ID=...
SESSION_MODE=resume
SESSION_GENERATION=2
SESSION_ROTATED_FROM=...
MAX_TURNS=...
MAX_BUDGET_USD=...
CONTEXT_ROTATE_TOKENS=...
BASE_COMMIT=...
TARGET_COMMIT=...
STOP_REASON=...
USAGE_FILE=...
```

标准化用量摘要应尽可能记录：

- turns；
- input tokens；
- cached input tokens；
- cache creation tokens；
- output tokens；
- 最后一轮缓存上下文；
- API 等价费用；
- speed / fast mode 状态。

缺失字段写 `null`，不能伪造为零。

---

## 11. 必须测试的控制面行为

测试不得启动真实 Agent，至少覆盖：

- 同角色从 `new` 变成明确 `resume`；
- 不同角色 session ID 隔离；
- Monitor 后台事件复用同一任务级会话；
- 上下文阈值触发新 session generation；
- `max-turns` 和 `max-budget` 正确传给执行器；
- 逐事件输出能在进程结束前给出精简 turns/cache/token；
- resume 流中的历史 `result` 不会被当成本次调用完成；
- 实时 assistant 事件数与最终 turns 不一致时，以终态 usage 为审计值；
- 结构化 `error_max_turns` / `error_max_budget_usd` 即使 CLI 返回零也不能被当成成功；
- 认证或模型启动失败不会激活预分配 session ID；
- 预算错误分类为 `AUTONOMY_SLICE_LIMIT`；
- 该分类能形成 recovery checkpoint，并进入可执行的 Monitor 决策点；
- quota 与预算等待状态可区分；
- attached 模式不擅自启动另一个 MONITOR；
- persistent-cli 模式不使用 ephemeral；
- attached 动作必须匹配当前事件 ID，persistent-cli 动作必须被 supervisor 执行；
- 受保护路径、staged 修改或脏 REVIEWER 会阻止恢复；
- 最终状态先写入，简报后生成。

---

## 12. 反模式

### 反模式一：宣称关闭的 UI Monitor 会被 shell 自动唤醒

除非宿主产品提供明确回调接口，否则这是错误承诺。

### 反模式二：把“一个 Agent”理解为“一次模型调用”

一个进程可能包含上百次推理轮次。

### 反模式三：只限制 timeout

高频缓存读取可以在 timeout 前消耗完整窗口。

### 反模式四：为了会话连续而永不压缩

连续性应由任务、角色、Git 和结构化交接保证，不应依赖无限膨胀的 transcript。

### 反模式五：命中主动预算后无决策地立即无限重启

这只是把一个大调用拆成连续小调用，不能保护总额度。允许 Monitor 基于当前切片和
窗口累计用量进行有限次立即续片；达到切片上限后必须等待窗口或交还所有者。

### 反模式六：把 API 等价费用当成订阅实际账单

它是控制和比较指标；实际扣费与订阅额度以服务账户页面为准。

### 反模式七：每次模型调用前都压缩

这会破坏短期工作记忆并诱发重复读取。压缩应发生在安全边界，并由上下文规模、重复
cache read、有效产出和任务完成概率共同决定。

### 反模式八：用墙上时间推断额度消耗

工具等待可能长时间零模型用量；高频 API 循环也可能在很短墙上时间内完成大量高上下文
调用。必须同时观察墙上时间与 API 活跃时间。

---

## 13. 从 v4.0 迁移到 v5.0

1. 保留 v4.0 文件作为历史；
2. 为 MONITOR 增加 `attached` 与 `persistent-cli`；
3. 将后台 MONITOR 从 ephemeral 改为任务级会话；
4. 在 supervisor 启动事件初始化后台 MONITOR；
5. 为非交互执行器增加 turns 与预算上限；
6. 增加 `AUTONOMY_SLICE_LIMIT`；
7. 增加 `AWAITING_MONITOR_ACTION`；只有 Monitor 选择等待时才进入
   `WAITING_FOR_BUDGET_WINDOW`；
8. 使用逐事件遥测，记录最后一轮缓存上下文与窗口累计账本；
9. 增加 session generation 和显式旧 ID，并禁止失败启动激活预分配 ID；
10. 为 attached 增加事件 ID 动作提交，为 persistent-cli 解析并执行动作；
11. 更新运行清单、状态、简报和指令手册；
12. 用假的执行器验证参数、结构化 guard、会话失败和决策状态路由；
13. 用一次受控真实循环校准预算，而不是直接假定默认值完美。

---

## 14. 最终原则

```text
人决定目标与风险；
IMPLEMENTER 在预算内构建；
REVIEWER 独立验收；
MONITOR 以可解释方式保持在线；
cycle 管理有限质量闭环；
supervisor 管理时间、恢复和终止；
Git 与结构化证据保证连续性。
```

可靠自动化不是让模型无限运行，而是让每一次运行都具有明确身份、可恢复现场、
可审计用量和硬性终止条件。
