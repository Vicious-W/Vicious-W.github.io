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
  轻水/损伤耦合和指针/键盘交互；
- `src/scenes/reactor/sessionController.js`：会话与连续运行状态机（联锁复位→…→全功率
  平衡）、控制棒位、反应性/功率/温度/流量代理、脉冲解析曲线；
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

当前反应堆参考 Pavia TRIGA Mark II 研究堆，堆芯改为中央 A 位辐照套管 + B–F 90 个
元件位置的构型，三根控制棒（SHIM/C 环、TRANS/D 环、REG/E 环）独立驱动。第一次有效
指针/触控/键盘交互解锁音频并释放场景时钟，反应堆池随后经历联锁复位→辅助设备就绪→
低功率临界→脉冲就绪→历史脉冲→脉冲后传热→稳态功率提升→全功率平衡的连续程序，棒位、
功率、燃料/池水温度代理、冷却流量代理、轻水和玻璃共享同一组状态。

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

- Agent 默认身份为 `GENERAL`，专用身份为 `IMPLEMENTER` 与 `REVIEWER`；
- 角色不与 Claude Code 或 Codex 绑定，父脚本可为每个角色指定执行器、模型和
  effort；
- 当前默认配置仍是 Claude Code 实现、Codex 审查；
- 实现和审查使用全新进程严格串行，审查阶段只读；
- 每次专用调用在 `.agent/artifacts/runs/` 留下实际运行配置。

## 建模规则

- 主要物体必须有真实三维几何结构，不能用平面图片或背景图代替；
- shader 可以表达真实模型的材质、光学和辉光，不能代替主要结构；
- 纹理只能提供表面细节，不能承担主要形状或完整场景；
- 物体运动和声音必须由可解释的状态或物理数据驱动；
- 不增加文字、导航、其他页面或与当前场景无关的功能。

## 当前目标

按照 `PROJECT_SPEC.md` 完成 SOURCE 的完整 Pavia TRIGA 反应堆池、第一次交互后的
连续真实运行、轻水动力学，以及格栅上玻璃的物理声音、耐久和破碎。

## 文档规则

本文件只记录当前事实、现行约束和立即下一步。Git 保存历史，不在这里追加开发日记。
