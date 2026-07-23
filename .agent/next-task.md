# Active Agent Task

TASK_ID: single-blue-physical-scene-2026-07-23
TASK_STATUS: NEEDS_OWNER
OWNER_APPROVED: PENDING_REACTOR_ARCHETYPE_DECISION

## Objective

完成 `PROJECT_SPEC.md` 定义的唯一无文字物理场景。

## Owner decision required

反应堆工程基线确认当前要求存在两个冲突：

1. 保留 TRIGA Mark II 时，池内介质必须按资料称为轻水；
2. 保留重水要求时，必须放弃 TRIGA 构型并重新选择真实重水反应堆。

如果保留 TRIGA，还需要确定以哪一座具体设施作为格位和控制棒构型的主要依据。
详见 `docs/engineering/REACTOR_MODEL.md` 的 D-001、D-002。所有者决定前不得启动实现循环。

## Required work

1. 让玻璃立方体具有稳定、有重量的刚体行为和可信透明材质。
2. 补全由碰撞冲量、速度、滑动和滚动状态驱动的物理声音。
3. 完成独立三维重水系统。
4. 继续完善研究堆主要部件和控制机构到功率、重水、辉光或仪器的状态联动。
5. 保持单页、无文字、蓝色、无图片式场景和无其他内容区。

## Verification

- 运行 `./scripts/run-validation.sh`；
- 使用 Playwright MCP 检查 `390 × 844`、`768 × 1024`、`1440 × 900`；
- 实际检查拖拽、释放、碰撞、堆叠、音频解锁和反应堆状态联动；
- 记录 console、未验证内容和剩余风险。
