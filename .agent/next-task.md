# Active Agent Task

TASK_ID: single-blue-physical-scene-2026-07-23
TASK_STATUS: READY
OWNER_APPROVED: 2026-07-23

## Objective

完成 `PROJECT_SPEC.md` 定义的唯一无文字物理场景。

## Locked reactor decisions

- 原型：Pavia TRIGA Mark II；
- 池内介质：轻水；
- Pavia 资料决定堆芯尺寸、五个燃料环和三根控制棒构型；
- General Atomics 和其他设施资料只能补充不冲突的通用机构或物理现象；
- 不得恢复重水名称，不得混用其他设施的格位或控制棒数量。

## Required work

1. 让玻璃立方体具有稳定、有重量的刚体行为和可信透明材质。
2. 补全由碰撞冲量、速度、滑动和滚动状态驱动的物理声音。
3. 完成独立三维轻水系统。
4. 按 Pavia 构型重建研究堆主要部件，并完成控制机构到功率、轻水、辉光或仪器的
   状态联动。
5. 保持单页、无文字、蓝色、无图片式场景和无其他内容区。

## Verification

- 运行 `./scripts/run-validation.sh`；
- 使用 Playwright MCP 检查 `390 × 844`、`768 × 1024`、`1440 × 900`；
- 实际检查拖拽、释放、碰撞、堆叠、音频解锁和反应堆状态联动；
- 记录 console、未验证内容和剩余风险。
