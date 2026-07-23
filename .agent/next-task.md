# Active Agent Task

TASK_ID: source-lifecycle-physics-2026-07-23
TASK_STATUS: NEEDS_OWNER
OWNER_APPROVED: PENDING_SOURCE_DECISIONS

## Objective

完成 `PROJECT_SPEC.md` 定义的 SOURCE 场景：统一建模反应堆、轻水和玻璃的
启动—稳态生命周期、物理耦合、声音、损伤与会话重置。

## Owner decisions required

启动实现循环前，所有者需要回答 `docs/engineering/SOURCE_SCENE.md` 的：

- S-001：只做正常启动，还是正常启动后自动执行一次历史脉冲；
- S-002：页面立即启动但可能错过声音，还是首次用户手势同步启动音画；
- S-003：实心玻璃由真实平台支承、改为空心浮体，还是允许入水下沉。

三个决定未完成前不得启动实现循环。

## Locked reactor decisions

- 原型：Pavia TRIGA Mark II；
- 池内介质：轻水；
- Pavia 资料决定中央 A 套管、B–F 的 90 个元件位置、装载和三根控制棒构型；
- General Atomics 和其他设施资料只能补充不冲突的通用机构或物理现象；
- 不得恢复重水名称，不得混用其他设施的格位或控制棒数量。

## Required work

1. 建立 SOURCE 的确定性会话重置和唯一生命周期状态机。
2. 按 Pavia 构型重建反应堆主要部件、启动过程和稳态运行。
3. 完成独立三维轻水体积、水面动力学、浮力/阻力、光学和物理声音。
4. 优化玻璃刚体、材质和碰撞/滑动/滚动声音。
5. 增加由碰撞能量驱动的耐久、裂纹、独立碎片和刷新复位。
6. 让反应堆、轻水和玻璃共享同一事件链，不使用无因动画、声音或隐形支承。
7. 保持单页、无文字、蓝色、无图片式场景和无其他场景。

## Verification

- 运行 `./scripts/run-validation.sh`；
- 使用 Playwright MCP 检查 `390 × 844`、`768 × 1024`、`1440 × 900`；
- 实际检查会话重置、启动、稳态、水体响应、玻璃损伤/破碎、音频解锁和状态联动；
- 记录 console、未验证内容和剩余风险。
