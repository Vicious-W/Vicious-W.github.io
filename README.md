# SOURCE

单页静态网站。当前唯一场景名为 SOURCE；页面无文字，以蓝色为主色，只呈现可交互
的三维物理系统。

## 当前内容

- 独立玻璃立方体；
- Pavia TRIGA Mark II 反应堆池三维模型与实验大厅；
- 刚体碰撞、拖拽、堆叠、损伤与破碎；
- 独立轻水体积、水面动力学与切伦科夫光学；
- 由物理接触和机构状态驱动的声音；
- `AUTO` 连续运行程序与三维控制台上的 `MANUAL` 人工操作，共用同一套反应堆状态。

## 结构

```text
src/
├── main.js
├── styles/main.css
└── scenes/reactor/
    ├── physicalScene.js      场景、刚体、拾取、相机、控制权分流
    ├── sessionController.js  反应堆状态、指令、联锁与控制权
    ├── autoProgram.js        AUTO 连续运行调度器
    ├── controlConsole.js     无文字三维操作台
    ├── reactorModel.js       反应堆池部件（RP-*）
    ├── labEnvironment.js     实验大厅与厂房设备
    ├── waterSystem.js        独立轻水体积
    ├── glassDamage.js        耐久、裂纹与碎片几何
    ├── glassAudio.js         玻璃碰撞/损伤声音
    └── reactorAudio.js       机构、气动与泵的声音

tests/run.mjs            node 逻辑测试（npm test）
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
- `docs/engineering/SOURCE_LAB_OPTICS.md`：当前实验室、地下设备、自由相机、
  水体光学、辉光粒子、玻璃建筑和双控制台目标。

Agent 协作：

- `AGENT_PROTOCOL.md`：角色、执行器、权限和身份分配总协议；
- `.agent/roles/`：`GENERAL`、`IMPLEMENTER`、`REVIEWER` 三种角色契约；GENERAL
  同时负责通用协作和轮转监督；
- `AGENTS.md`、`CLAUDE.md`：Codex 与 Claude Code 的薄入口，不再绑定角色；
- `REVIEW_CONTRACT.md`：适用于任意审查执行器的报告和通过规则。

## 命令

```bash
npm install
npm run dev -- --port 8000
npm run build
npm test
./scripts/agent-cycle.sh status
./scripts/agent-cycle.sh preflight
./scripts/agent-cycle.sh cycle
./scripts/agent-cycle.sh supervise
./scripts/agent-cycle.sh summary
```

默认循环仍采用 Claude Code 实现、Codex 审查，但可在启动时交换角色、改用同一种
执行器或显式指定各自模型与 effort。直接进入项目而未指定专用角色的 Agent 默认
为 `GENERAL`。预计会跨额度窗口时使用 `supervise`：外层 shell 会保存安全恢复
检查点并零 Token 等待，GENERAL 只在事件边界处理决策和未知异常。同一任务内实现与审查分别恢复
自己的专属会话；`--rounds N` 指定本次追加的实现次数。

详细说明见 `docs/guides/PROJECT_COMMAND_MANUAL.md`。
