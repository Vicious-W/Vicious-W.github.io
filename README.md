# Vicious-W Personal Homepage

这是一个以视觉表现、实时图形和物理交互为重点的个人主页。项目是纯前端静态站，
使用 Vite、Three.js、GLSL 和 cannon-es，可部署到 GitHub Pages。

本文件是进入项目后的“地图”。正式目标、技术记忆、Agent 角色和日常命令分别由
不同文件负责，避免一份 README 同时承担所有职责。

## 从哪里开始

如果你是项目所有者：

1. 先读 `PROJECT.md`，了解项目是什么、现在做到哪里。
2. 读 `PROJECT_SPEC.md`，确认当前阶段的正式目标和验收标准。
3. 需要运行项目或 Agent 流程时，读
   `docs/guides/PROJECT_COMMAND_MANUAL.md`。

如果你是 Agent：

- Claude Code 先读 `CLAUDE.md`；
- Codex 先读 `AGENTS.md`；
- 两者都以 `PROJECT_SPEC.md` 为当前目标依据；
- 审查等级和报告格式由 `REVIEW_CONTRACT.md` 规定。

## 项目结构

```text
.
├── README.md                    # 人类进入项目后的第一张地图
├── PROJECT.md                   # 技术记忆、当前状态和决策历史
├── PROJECT_SPEC.md              # 当前正式目标、范围和验收标准
├── AGENTS.md                    # Codex 独立审查者规则
├── CLAUDE.md                    # Claude Code 实现者规则
├── REVIEW_CONTRACT.md           # 审查分级、证据和报告契约
├── index.html                   # Vite 的页面入口
├── package.json                 # npm 依赖和 dev/build/preview 命令
├── package-lock.json            # 可重复安装的依赖锁定
├── vite.config.js               # 静态构建配置
│
├── src/                         # 当前真正参与网站构建的业务源码
│   ├── main.js                  # 页面启动与各场景的延迟加载
│   ├── styles/                  # 全站样式
│   ├── scenes/                  # 按页面场景拆分的实时图形代码
│   │   ├── reactor/             # 第一屏反应堆、玻璃、物理与声音
│   │   └── pond/                # 第四屏实时水塘
│   └── assets/                  # 当前构建实际使用的图片/纹理
│       ├── pond/
│       └── textures/
│
├── scripts/                     # 中立控制面与统一验证脚本
│   └── lib/                     # 脚本共享的进程监督函数
├── .agent/                      # 双 Agent 的任务、状态、报告和本地证据
├── .claude/                     # Claude Code 项目级权限配置
├── .codex/                      # Codex 项目级配置
├── .vscode/                     # 共享的 VS Code 项目视图设置
│
├── docs/                        # 人类指南和可迁移方法论
│   ├── guides/
│   └── methodology/
├── references/                  # 设计参考；不进入网站生产构建
│   ├── hero/
│   └── pond/
└── archive/                     # 不再参与运行的旧站代码、资源和截图
```

## 业务源码

### `src/main.js`

全站 JavaScript 入口。它先启动第一屏轻量反应堆兜底，再延迟加载重型玻璃/物理
场景；接近第四屏时才加载水塘场景。页面滚动渐显也从这里启动。

### `src/scenes/reactor/`

- `reactorScene.js`：第一屏首帧快速显示和加载失败时的原生 WebGL 兜底。
- `reactorShader.js`：兜底反应堆使用的 GLSL 单一来源。
- `glassCubes.js`：Three.js 玻璃立方体、cannon-es 刚体和拖拽交互。
- `glassAudio.js`：由物理碰撞和持续接触驱动的 Web Audio 声音层。
- `reactorModel.js`：真三维反应堆的独立部件、状态与运行联动。

### `src/scenes/pond/`

- `pondScene.js`：第四屏水面反射、折射、涟漪、鱼和性能/降级管理。

### `src/styles/`

- `main.css`：四屏布局、响应式样式、场景画布和静态降级外观。

### `src/assets/`

这里的资源会被当前源码引用并进入 Vite 构建：

- `pond/`：水塘横竖底图、天空反射和透明鱼；
- `textures/`：第二、三屏当前使用的材质纹理。

## 协作控制面

### `.agent/`

- `next-task.md`：当前经所有者确认的执行任务；
- `state.env`：任务 ID、轮次、最近提交、结论和最大轮数；
- `runtime.env`：Claude/Codex 模型、effort、超时和心跳；
- `implementation-report.md`：Claude 最新实现交接；
- `latest-review.md`：Codex 最新正式审查；
- `review-history/`：只追加的历史审查；
- `artifacts/`：本地日志、截图、验证和循环简报，不纳入 Git。

### `scripts/`

- `agent-cycle.sh`：统一入口和最多三轮的串行状态机；
- `agent-preflight.sh`：不启动 Agent 的环境、权限和登录预检；
- `run-implementation.sh`：启动恰好一轮 Claude 并创建实现检查点；
- `run-review.sh`：启动恰好一轮只读 Codex 审查；
- `run-validation.sh`：依赖、构建及已配置测试的统一入口；
- `generate-cycle-summary.sh`：生成面向所有者的多轮中文简报；
- `test-agent-runtime.sh`：不调用真实 Agent 的进程监督烟雾测试；
- `lib/agent-runtime.sh`：锁、心跳、超时、信号和故障分类的共享实现。

## 文档、参考与归档的区别

- `docs/` 保存仍然有效、供人阅读和复用的指南或方法论。
- `references/` 保存设计输入，只用于校准方向，不应被当成网站生产资源。
- `archive/` 保存历史代码、旧站资源和旧截图。它们不进入当前运行链路，只在追溯
  项目演变时使用。

这三个目录不能互换。若一个参考素材最终成为生产资源，应复制或加工到
`src/assets/`，并由源码显式引用；不要让生产代码直接依赖 `references/` 或
`archive/`。

## 常用命令

```bash
npm install
npm run dev -- --port 8000
npm run build
./scripts/agent-cycle.sh status
./scripts/agent-cycle.sh preflight
./scripts/agent-cycle.sh cycle
./scripts/agent-cycle.sh summary
```

命令的前置条件、输出位置和错误恢复见
`docs/guides/PROJECT_COMMAND_MANUAL.md`。

## 本地生成但通常看不到的目录

VS Code 项目设置默认隐藏以下噪声目录，但没有删除它们：

- `node_modules/`：npm 安装的依赖；
- `dist/`：Vite 生产构建产物；
- `.npm-cache/`：本地 npm 缓存；
- `.playwright-mcp/`：浏览器截图、页面快照和 console 日志；
- `.agent/artifacts/`：自动验证与 Agent 运行证据。

需要排查时，可以在 VS Code 设置中临时关闭对应的 `files.exclude`。
