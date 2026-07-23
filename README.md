# Blue Physical Scene

单页静态网站。页面无文字，以蓝色为主色，只呈现可交互的三维物理场景。

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
- `docs/engineering/REACTOR_MODEL.md`：反应堆资料、部件、状态和真实性边界。

Agent 规则：

- `CLAUDE.md`：实现者；
- `AGENTS.md`：审查者；
- `REVIEW_CONTRACT.md`：审查格式和通过规则。

## 命令

```bash
npm install
npm run dev -- --port 8000
npm run build
./scripts/agent-cycle.sh status
./scripts/agent-cycle.sh preflight
./scripts/agent-cycle.sh cycle
./scripts/agent-cycle.sh summary
```

详细说明见 `docs/guides/PROJECT_COMMAND_MANUAL.md`。
