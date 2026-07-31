# SOURCE / FLY

一个以蓝色为核心颜色、以真实三维物理建模为主要内容的单页静态网站。

网站入口提供两个场景：

- `SOURCE`：已实现并验收的 Pavia TRIGA Mark II 核反应堆实验室；
- `FLY`：正在建立的无限天空、真实气象和多类飞行器场景；第一阶段晴空热气球切片
  正在等待正式审查。

当前代码打开后先进入无文字三维场景选择。SOURCE 保持已验收业务行为；FLY 已可完成
C-100 指南、物理加热离地、分层风漂移、放气和自动安全回收的第一阶段旅程。

## 当前实现

- 单 canvas SceneHost 与 SITE_SELECT / SOURCE / FLY 独立生命周期；
- 无文字 SOURCE / FLY 三维缩影入口，以及 FLY 唯一允许说明文字的型号操作指南；
- FLY `1/120 s` 固定步长、标准大气、确定性晴空风场、程序化区块和浮动原点；
- Cameron C-100 参考热气球的 16 gore 包络、下部结构、热力/浮力、双体悬挂、燃料、
  手动控制、相机、状态音频和不写位姿的自动回收；
- 独立玻璃立方体、建筑玻璃、刚体碰撞、抓取、损伤与破碎；
- Pavia TRIGA Mark II 反应堆池、完整实验大厅和地下设备；
- 独立轻水、水面动力学、热羽流与局部切伦科夫光学；
- AUTO 连续程序与 MANUAL 三维控制台，共享唯一反应堆状态；
- 由接触、机构、流体和损伤状态驱动的声音；
- 可进入水下、堆芯附近和地下设备层的观察相机。

## FLY 后续范围

- 后续扩展飞机、旋翼飞行器、航天飞机、UFO、多云、雷暴和台风。

## 结构

```text
src/
├── main.js
├── core/                       多场景宿主、资源和固定时钟
├── styles/main.css
└── scenes/
    ├── selector/               无文字三维场景入口
    ├── reactor/                已实现的 SOURCE
    └── fly/                    晴空、程序化世界与 C-100 纵向切片

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
