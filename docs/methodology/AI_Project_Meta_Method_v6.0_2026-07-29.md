# AI Project Meta Method v6.0

版本：v6.0
日期：2026-07-29

## 1. 本版结论

项目只定义三种 Agent 身份：

- `GENERAL`：默认通用身份，同时负责项目协作、控制面维护和轮转监督；
- `IMPLEMENTER`：受限的正式实现身份；
- `REVIEWER`：只读的正式审查身份。

v5 中独立的 `MONITOR` 身份并入 `GENERAL`。从此不再为了修复监督脚本、处理额度
事件或继续普通协作而切换 GENERAL/MONITOR。

## 2. 为什么合并

GENERAL 与旧 MONITOR 的差别主要来自运行时权限和当前动作，而不是能力或责任主体：

- 普通 GENERAL 根据所有者要求维护项目；
- 旧 MONITOR 在工作 Agent 存活时只读观察；
- 工作 Agent 退出后，旧 MONITOR 发现控制面缺陷仍必须请求重新任命 GENERAL；
- 这产生没有实际隔离价值的身份切换，并可能让无人值守流程停在安全边界。

真正需要隔离的是 IMPLEMENTER 与 REVIEWER。监督和控制面维护则需要同一个持续主体
在不同安全状态下使用不同权限，因此应统一为 GENERAL。

## 3. 统一 GENERAL 的两种运行上下文

### 3.1 交互式 GENERAL

由所有者直接打开或默认进入，能够：

- 分析、解释、规划和执行所有者授权的普通任务；
- 启动并附着监督流程；
- 在工作 Agent 存活时只读观察；
- 在工作 Agent 退出后的安全边界创建恢复检查点；
- 停止父脚本并修复控制面；
- 修复后继续同一监督目标，无需重新任命。

### 3.2 自动控制事件 GENERAL

`persistent-cli` 模式在事件边界创建或恢复一个任务级 GENERAL 会话。它使用只读、
非交互权限，只读取控制证据并输出一个动作：

```text
MONITOR_ACTION: CONTINUE_NOW
MONITOR_ACTION: ROTATE_AND_CONTINUE
MONITOR_ACTION: WAIT_FOR_QUOTA
MONITOR_ACTION: STOP_OWNER
MONITOR_ACTION: CONTROL_REPAIR_REQUIRED
```

`MONITOR_ACTION` 是兼容 v5 脚本的消息字段名，不是角色名。运行清单中的 `ROLE`
必须是 `GENERAL`。

## 4. 权限由状态决定

角色统一不代表权限无限：

| 当前状态 | GENERAL 权限 |
| --- | --- |
| IMPLEMENTER/REVIEWER 存活 | 只读流程、进程、Git 和遥测 |
| 工作 Agent 已退出，状态安全 | 恢复、状态、检查点和所有者授权的控制面维护 |
| 自动控制事件调用 | 始终只读，只写忽略目录中的事件报告 |
| 普通所有者任务 | 以所有者授权和仓库安全边界为准 |

任意时刻最多只有一个工作 Agent：IMPLEMENTER 或 REVIEWER。GENERAL 的存在不算第二个
工作 Agent，但并存期间不得修改仓库。

## 5. 身份与会话

```text
GENERAL 逻辑会话
├── 当前可见交互会话
└── persistent-cli 任务级控制事件会话

IMPLEMENTER 逻辑会话
└── 可按上下文阈值产生多个 generation

REVIEWER 逻辑会话
└── 可按上下文阈值产生多个 generation
```

IMPLEMENTER、REVIEWER 与自动 GENERAL 控制会话互不恢复。执行器、模型、effort、
任务或角色变化时创建新会话；上下文超过阈值时，在安全检查点创建新 generation。

## 6. 监督流程

```text
GENERAL 启动 supervisor
→ IMPLEMENTER
→ 自主保险/额度事件
→ shell 保存现场并停止工作 Agent
→ GENERAL 读取最终 usage
→ 继续 / 轮换 / 等待 / 停止
→ IMPLEMENTER 正式完成
→ REVIEWER
→ 下一轮 IMPLEMENTER
→ 最终实现交给所有者
```

长时间等待完全由 shell 完成，不运行模型。`attached` 模式要求当前 GENERAL 对话在
决策点仍可用；完全无人值守时使用 `persistent-cli`，由父脚本恢复只读 GENERAL
控制会话。

等待到点的依据依次为所有者显式指定的首次恢复时间、执行器结构化遥测返回的真实
额度 reset 时间、固定窗口锚点。不得在已经取得真实 reset 时间时继续凭固定五小时
间隔猜测。

## 7. 控制事件预检

自动 GENERAL 控制事件不是 IMPLEMENTER，也不是 REVIEWER，因此其预检必须：

- 检查选定执行器、模型、effort、认证、MCP 和只读适配器；
- 检查仓库与控制脚本完整性；
- 不要求任务正处于“可实现”或“待审查”阶段；
- 不探测 Git 写权限；
- 不启动工作 Agent。

项目使用 `agent-preflight.sh --control-only` 表达这个语义。把控制事件错误地映射成
`--review-only` 会让恢复中的实现任务被错误拒绝，是必须回归测试的控制面故障。

## 8. 控制面修复规则

GENERAL 在监督中发现脚本缺陷时：

1. 确认 IMPLEMENTER/REVIEWER 及其进程组已经退出；
2. 停止或暂停父脚本，保留恢复检查点和原始审查基线；
3. 修复控制面，不修改无关业务；
4. 运行静态检查、运行时测试、监督器测试和项目验证；
5. 创建 GENERAL 控制面提交；
6. 以同一 GENERAL 身份恢复原目标。

这个过程不再需要角色切换，但每一步仍受并发和权限边界约束。

## 9. 兼容与迁移

为避免破坏现有命令，以下名称暂时保留：

- `run-monitor.sh`；
- `--monitor`、`--monitor-model`、`--monitor-effort`、`--monitor-mode`；
- `.agent/runtime.env` 中的 `MONITOR_*`；
- supervisor 状态中的 `MONITOR`、`MONITOR_MODE` 与 `LAST_MONITOR_ACTION`
  （新读取方优先使用对应的 `GENERAL_SUPERVISOR`、`SUPERVISION_MODE` 与
  `LAST_SUPERVISION_ACTION`）；
- `AWAITING_MONITOR_ACTION` 与 `MONITOR_ACTION`。

它们只表示监督功能或兼容协议。新的运行清单、提示词和角色会话一律记录
`ROLE=GENERAL`，项目入口不再接受 MONITOR 身份。

## 10. 验收

- 角色目录只有 GENERAL、IMPLEMENTER、REVIEWER 三份契约；
- Codex/Claude 适配器接受 GENERAL、IMPLEMENTER、REVIEWER；
- persistent-cli 控制事件清单记录 `ROLE=GENERAL`；
- `--control-only` 在实现恢复阶段可以通过；
- 工作 Agent 存活时 GENERAL 不修改仓库；
- 安全边界的控制面故障可由同一 GENERAL 直接修复并恢复；
- attached 与 persistent-cli 监督测试均通过；
- 文档不再要求 GENERAL 与 MONITOR 互相切换。
