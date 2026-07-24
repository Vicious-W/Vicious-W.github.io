# 项目事实

## 项目定义

- 单页静态网站；
- 当前唯一场景名为 `SOURCE`；
- 页面无可见文字；
- 蓝色是核心颜色；
- 主要内容是可交互的真实三维物理模型；
- 当前只开发这一页，不考虑其他页面或内容区。

## 当前实现

- `src/scenes/reactor/physicalScene.js`：唯一页面场景，负责渲染、玻璃刚体、格栅物理、
  轻水/损伤耦合、控制台射线拾取、右键轨道相机和滚轮缩放；
- `src/scenes/reactor/sessionController.js`：人工操作反应堆模型，提供启动、SCRAM、
  模式、冷却泵、三根控制棒和脉冲命令，并积分点堆动力学、温度反馈与两节点热工状态；
- `src/scenes/reactor/controlConsole.js`：无文字三维操作台、可点击/按住控件和状态仪表；
- `src/scenes/reactor/labEnvironment.js`：反应堆实验大厅、起重机、管路/通风、仪表柜、
  冷却设备、安全设施，以及与可见地面/墙壁对应的物理边界；
- `src/scenes/reactor/reactorModel.js`：Pavia TRIGA 反应堆池三维部件（生物屏蔽、水箱、
  桥架/格栅、三根控制棒与驱动、堆芯格位、实验设施、仪器、三回路冷却、电气/气动连接）
  和状态到视觉的映射；
- `src/scenes/reactor/waterSystem.js`：独立轻水体积、高度场波动求解、光学、切伦科夫
  辉光和浮力/阻力耦合；
- `src/scenes/reactor/glassDamage.js`：玻璃耐久/裂纹/破碎状态机与碎片几何生成；
- `src/scenes/reactor/glassAudio.js`：由碰撞、持续接触和损伤阶段驱动的玻璃 Web Audio；
- `src/scenes/reactor/reactorAudio.js`：控制棒驱动、TRANS 气动、冷却泵和水体冲量的
  机械声音；
- `src/main.js`：加载唯一物理场景；
- `src/styles/main.css`：全屏画布和无文字页面样式。

当前反应堆参考 Pavia TRIGA Mark II 研究堆，堆芯采用中央 A 位辐照套管 + B–F 90 个
元件位置的构型，三根控制棒（SHIM/C 环、TRANS/D 环、REG/E 环）独立驱动。第一次有效
指针/触控/键盘交互只解锁音频和场景时钟；反应堆保持停堆，随后由用户在三维控制台上
启动、操作冷却泵、连续提插控制棒、切换运行/脉冲模式、触发脉冲或 SCRAM。棒位、
反应性、功率、燃料/池水温度、流量、轻水、厂房状态和玻璃共享同一组物理状态。

反应堆的资料依据、部件分解、当前近似和逐项验收定义在
`docs/engineering/REACTOR_MODEL.md`。原型确定为 Pavia TRIGA Mark II，池内介质
确定为轻水；几何和控制棒构型不得混用其他 TRIGA 设施。

轻水是独立高度场体积，由 TRANS 脉冲的水下冲量驱动波动并自然衰减；池水/燃料温度
代理驱动切伦科夫辉光和自然对流着色。玻璃立方体由弹簧+阻尼悬挂的安全格栅刚体真正
承托（不再是隐形地平面），可拖拽、碰撞、堆叠；耐久按接触能量代理经
`INTACT→MICRO_DAMAGED→CRACKED→FRACTURED` 演化，破碎后生成独立三维碎片刚体；刷新
或新会话恢复初始布局与耐久 `1.0`。声音只在用户手势后启用，并区分完整/受损/破碎/
碎片音色。

本轮实现的近似、简化和未关闭差距记录在 `.agent/implementation-report.md`；本文件
只保留当前事实，不追加开发日记。

## 技术结构

- Vite；
- Three.js；
- cannon-es；
- Web Audio API；
- 静态构建，可部署到 GitHub Pages；
- 无后端、数据库或运行时密钥。

## Agent 协作结构

- Agent 默认身份为 `GENERAL`，专用身份为 `MONITOR`、`IMPLEMENTER` 与
  `REVIEWER`；
- 角色不与 Claude Code 或 Codex 绑定，父脚本可为每个角色指定执行器、模型和
  effort；
- 当前默认配置仍是 Claude Code 实现、Codex 审查；
- 实现和审查使用全新进程严格串行，审查阶段只读；
- `agent-cycle.sh` 管理有界实现—审查轮次，`agent-supervisor.sh` 管理跨额度窗口
  的恢复、定时续跑和异常交接；
- 长时间等待由 shell 完成，不运行 AI；MONITOR 只在无法机械处理的事件边界以只读
  身份启动；
- 每次专用调用在 `.agent/artifacts/runs/` 留下实际运行配置。

## 建模规则

- 主要物体必须有真实三维几何结构，不能用平面图片或背景图代替；
- shader 可以表达真实模型的材质、光学和辉光，不能代替主要结构；
- 纹理只能提供表面细节，不能承担主要形状或完整场景；
- 物体运动和声音必须由可解释的状态或物理数据驱动；
- 不增加文字、导航、其他页面或与当前场景无关的功能。

## 当前目标

当前代码已经从自动连续程序改为用户通过三维控制台进行完整人工操作；但
`PROJECT_SPEC.md` 和两份工程基线仍要求第一次交互后自动执行完整连续程序。两者
构成尚未解决的正式目标冲突。在所有者明确“人工操作取代自动程序”还是“两种模式
并存”之前，不启动正式 IMPLEMENTER—REVIEWER 循环。

## 文档规则

本文件只记录当前事实、现行约束和立即下一步。Git 保存历史，不在这里追加开发日记。
