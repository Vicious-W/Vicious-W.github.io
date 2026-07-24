# SOURCE

单页静态网站。当前唯一场景名为 SOURCE；页面无文字，以蓝色为主色，只呈现可交互
的三维物理系统。

## 当前内容

- 独立玻璃立方体；
- 开放式水池研究堆三维模型；
- 刚体碰撞、拖拽和堆叠；
- 由物理接触驱动的声音；
- 反应堆控制机构与可见状态联动。

## 结构

```text
src/
├── main.js
├── styles/main.css
└── scenes/reactor/
    ├── physicalScene.js
    ├── reactorModel.js
    └── glassAudio.js

scripts/                 双 Agent 控制与验证
.agent/                  当前任务、状态和报告
references/hero/         第一页玻璃与反应堆参考
docs/engineering/        物理模型工程设计基线
docs/guides/             项目指令手册
docs/methodology/        项目构建方法论
```

项目事实和目标：

- `PROJECT.md`：当前实现事实与技术结构；
- `PROJECT_SPEC.md`：当前目标、范围和验收标准。
- `docs/engineering/SOURCE_SCENE.md`：SOURCE 连续运行、轻水、玻璃和跨系统物理；
- `docs/engineering/REACTOR_POOL_SYSTEM.md`：完整反应堆池、环境设备和连续运行；
- `docs/engineering/REACTOR_MODEL.md`：反应堆资料、部件、状态和真实性边界。

Agent 协作：

- `AGENT_PROTOCOL.md`：角色、执行器、权限和身份分配总协议；
- `.agent/roles/`：`GENERAL`、`MONITOR`、`IMPLEMENTER`、`REVIEWER` 四种角色契约；
- `AGENTS.md`、`CLAUDE.md`：Codex 与 Claude Code 的薄入口，不再绑定角色；
- `REVIEW_CONTRACT.md`：适用于任意审查执行器的报告和通过规则。

## 命令

```bash
npm install
npm run dev -- --port 8000
npm run build
./scripts/agent-cycle.sh status
./scripts/agent-cycle.sh preflight
./scripts/agent-cycle.sh cycle
./scripts/agent-cycle.sh supervise
./scripts/agent-cycle.sh summary
```

默认循环仍采用 Claude Code 实现、Codex 审查，但可在启动时交换角色、改用同一种
执行器或显式指定各自模型与 effort。直接进入项目而未指定专用角色的 Agent 默认
为 `GENERAL`。预计会跨额度窗口时使用 `supervise`：外层 shell 会保存安全恢复
检查点并零 Token 等待，MONITOR 只处理未知异常。同一任务内实现与审查分别恢复
自己的专属会话；`--max-rounds N` 可只限制本次运行。

详细说明见 `docs/guides/PROJECT_COMMAND_MANUAL.md`。
