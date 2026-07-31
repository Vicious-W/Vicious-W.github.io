# SOURCE / FLY

一个以蓝色为核心颜色、以真实三维物理建模为主要内容的单页静态网站。

网站入口将提供两个场景：

- `SOURCE`：已实现并验收的 Pavia TRIGA Mark II 核反应堆实验室；
- `FLY`：当前准备开发的无限天空、真实气象和多类飞行器场景。

当前代码仍直接加载 SOURCE；全站场景选择和 FLY 尚未实现。现阶段的正式开发目标是
“晴空 + 热气球”第一阶段纵向切片。

## 当前实现

- 独立玻璃立方体、建筑玻璃、刚体碰撞、抓取、损伤与破碎；
- Pavia TRIGA Mark II 反应堆池、完整实验大厅和地下设备；
- 独立轻水、水面动力学、热羽流与局部切伦科夫光学；
- AUTO 连续程序与 MANUAL 三维控制台，共享唯一反应堆状态；
- 由接触、机构、流体和损伤状态驱动的声音；
- 可进入水下、堆芯附近和地下设备层的观察相机。

## 计划中的 FLY

- 无文字三维场景入口；
- 飞行器与气象选择、型号专属操作指南和物理出发过程；
- 统一大气、风场、气象、空气动力、推进、结构、碰撞和音频仿真；
- 确定性无限区块、局部物理区域和浮动原点；
- 第一阶段使用 Cameron C-100 参考热气球与晴朗天气；
- 后续扩展飞机、旋翼飞行器、航天飞机、UFO、多云、雷暴和台风。

## 结构

```text
src/
├── main.js
├── styles/main.css
└── scenes/reactor/             已实现的 SOURCE

tests/run.mjs                   Node 逻辑测试
scripts/                        Agent 控制与统一验证
.agent/                         当前任务、角色、状态和报告
docs/engineering/               物理模型与场景工程规范
docs/guides/                    项目指令手册
docs/methodology/               项目构建方法论
```

实现 FLY 时应建立独立的场景目录和共享仿真基础层，不能把飞行代码塞进
`src/scenes/reactor/`。

## 先读什么

- `PROJECT.md`：当前事实、现行决定和立即目标；
- `PROJECT_SPEC.md`：当前正式目标与验收标准；
- `docs/engineering/FLY_PHYSICS.md`：FLY 统一物理引擎与热气球基线；
- `docs/engineering/FLY_SCENE_ARCHITECTURE.md`：场景选择、生命周期和体验状态；
- `docs/engineering/SOURCE_SCENE.md`：SOURCE 稳定工程基线；
- `AGENT_PROTOCOL.md`：Agent 身份、权限和轮转协议；
- `docs/guides/PROJECT_COMMAND_MANUAL.md`：命令速查。

## 常用命令

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

所有 Agent 默认身份为 GENERAL；IMPLEMENTER 与 REVIEWER 必须由所有者或父脚本明确
指定。流程只创建本地检查点，不自动 push 或部署。
