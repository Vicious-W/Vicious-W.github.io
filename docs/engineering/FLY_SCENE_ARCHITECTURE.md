# 多场景与 FLY 体验架构

DESIGN_STATUS: ACTIVE

本文件定义网站从单一 SOURCE 转为 `场景选择 + SOURCE + FLY` 后的场景宿主、状态机、
输入、文字边界、资源生命周期和第一阶段体验。物理公式和飞行器模型见
`FLY_PHYSICS.md`；产品验收优先以 `PROJECT_SPEC.md` 为准。

## 1. 设计目标

- 用户始终知道自己是在选择、准备、飞行还是恢复，而不依赖普通导航文字；
- SOURCE 保持已验收行为，不因多场景改造而在后台运行或被重复初始化；
- FLY 选择空间、指南、旅程和恢复属于同一个明确会话；
- 每次场景切换都有完整的创建、启动、暂停、恢复和销毁边界；
- 后续增加飞行器和天气只注册定义，不复制整个场景主循环；
- 全站只有一个 canvas 宿主、一个活动业务场景和一个音频控制边界。

## 2. 全站状态机

```text
BOOT
  ↓
SITE_SELECT
  ├─ choose SOURCE → SOURCE_SESSION ─┐
  │                                  │
  └─ choose FLY → FLY_CONFIG         │
                        ↓             │
                    FLY_GUIDE         │
                        ↓             │
                  FLY_DEPARTURE       │
                        ↓             │
                    FLY_FLIGHT        │
                        ↓             │
                   FLY_RECOVERED      │
                                      │
  ←──────────── return / Escape ──────┘
```

状态变化必须是显式事件，不允许通过 DOM 是否存在、音频是否正在播放或某个模型透明度
反推当前阶段。

## 3. 场景宿主

建议结构：

```text
src/
├── main.js
├── core/
│   ├── sceneHost.js
│   ├── sceneContract.js
│   ├── simulationClock.js
│   ├── inputRouter.js
│   ├── audioGate.js
│   └── resourceScope.js
└── scenes/
    ├── selector/
    ├── reactor/          SOURCE，现有代码
    └── fly/
        ├── physicalScene.js
        ├── flySession.js
        ├── atmosphere/
        ├── world/
        ├── vehicles/
        ├── weather/
        ├── cameras/
        └── audio/
```

目录名可以调整，但职责不能重新混入一个文件。`core/` 只放跨场景基础设施，不依赖
反应堆或热气球业务。

### 3.1 场景契约

每个场景至少提供等价语义：

```js
createScene(context) => {
  mount(container),
  start(sessionOptions),
  pause(reason),
  resume(reason),
  resize(viewport),
  dispose(),
  getDebugSnapshot()
}
```

- `mount` 只建立资源，不偷跑业务时钟；
- `start` 创建新会话并在所需用户手势后解锁；
- `pause/resume` 处理标签页与指南，不创建第二会话；
- `dispose` 幂等，多次调用也不会报错或残留资源；
- `getDebugSnapshot` 只供自动验证，不在普通页面显示文字。

### 3.2 ResourceScope

所有场景分配都登记在本场景 scope：

- RAF/timeout/interval；
- DOM 和全局事件监听器；
- pointer capture 与按键状态；
- AudioContext、AudioNode、buffer 和持续 voice；
- Web Worker、异步区块任务和 abort signal；
- cannon-es world、body、constraint 和 contact material；
- Three.js geometry、material、texture、render target 和 renderer side resource；
- 临时 DOM（指南、测试标记、触控控件）；
- 全局测试钩子。

切换时先停止输入与时钟，再取消异步任务，最后释放物理、音频、GPU 和 DOM。任何延迟
完成的旧任务必须通过 generation/session token 被丢弃，不能写入新场景。

## 4. 全站场景选择

### 4.1 无文字选择空间

场景选择不是传统菜单。它包含两个可拾取的实时三维缩影：

- SOURCE：蓝色水池、局部堆芯辉光、玻璃结构和低强度机构/水声；
- FLY：天空窗口、云体、地平线和热气球剪影/缩影，伴随轻微风声。

缩影是简化三维模型，不加载两个完整业务物理世界。它们可以有有限状态驱动的运动，
但不得在后台运行完整反应堆或热气球仿真。

选择反馈：

- hover/focus：蓝色空间光、轻微尺度或视差响应；
- activate：相机进入对应缩影并过渡到场景；
- 键盘：Tab/方向键可以在两个入口间移动，Enter/Space 选择；
- 触控：一次点击聚焦/反馈，再次点击或明确出发手势进入；
- 选择过程无文字、无传统链接列表、无滚动内容。

### 4.2 直接测试入口

允许开发/测试使用 URL 参数直接装载 `SOURCE` 或 `FLY`，但必须满足：

- 参数不被普通 UI 暴露为文字导航；
- 直接入口仍走同一生命周期和 dispose；
- 自动化可以稳定跳过选择动画；
- 无效参数返回 SITE_SELECT，不静默加载任意场景。

## 5. SOURCE 适配

SOURCE 已验收，适配只允许：

- 把现有创建函数包进场景契约；
- 接收宿主提供的容器、viewport、音频门和资源 scope；
- 暴露明确 dispose；
- 响应全站返回动作；
- 保持现有测试钩子或以兼容层重导出。

不得在本任务中借机重写反应堆、实验室、轻水、玻璃、控制权或相机。SOURCE 会话仍在
第一次场景内有效交互后选择 AUTO/MANUAL；进入全站选择空间不能提前启动它。

## 6. FLY 配置空间

### 6.1 注册数据

天气和飞行器由注册表提供，而不是在主场景中写 switch 链：

```js
vehicleRegistry = {
  hotAirBalloonC100: {
    id,
    previewFactory,
    vehicleFactory,
    controlSchema,
    guideDefinition,
    compatibleWeather,
    recoveryStrategy,
    sourceManifest
  }
}

weatherRegistry = {
  clear: {
    id,
    previewFactory,
    weatherFactory,
    compatibility,
    sourceManifest
  }
}
```

第一阶段注册表只有 `clear` 和 `hotAirBalloonC100`。UI 不能显示虚假的不可用选项；
后续增加项目时，选择器根据注册项自动扩展。

### 6.2 选择表现

- 中央或近场展示选中飞行器的真实低负载三维预览；
- 包络分片、篮筐、框架和燃烧器可以被环绕观察；
- 天气选择直接改变出发空间之外的天空、风、云量和环境声音预览；
- 第一阶段虽然只有一个选项，仍须经过注册表、选中状态和确认事件，不能把 C-100
  永久写死在 FLY 主循环；
- 无文字图形/物理控制分别表示飞行器、天气、指南、出发和返回；
- 出发前不运行正式旅程物理，不消耗燃料或累计天气时间。

## 7. 操作指南

操作指南是 FLY 唯一允许的说明性文字层。规则：

- 内容来自当前 vehicle 的 `guideDefinition`，不能写成全飞行器通用说明；
- 第一阶段明确显示 C-100 参考热气球、`Space` 主燃烧器、`V` 顶部 vent、`R` 自动
  安全降落、相机控制和“水平方向来自不同高度风层”；
- 同时配合按键图、物理控制部件高亮和简短动画，文字只承担必要辨识；
- 指南可用键盘、指针和触控操作，焦点不会逃到背后 canvas；
- 指南打开时选择空间保持展示但不启动旅程；
- 飞行中重新打开指南时，第一阶段统一暂停权威时钟并清零持续控制输入；关闭后从同一
  状态恢复，不补算暂停时间；
- 屏幕阅读器可以读取指南和控制名称；无文字规则不用于破坏可访问性；
- 指南不得加入欢迎语、故事、营销或项目说明。

## 8. 出发与旅程

### 8.1 会话建立

确认出发后：

1. 锁定当前 weather/vehicle/seed 选择；
2. 销毁仅用于预览的模型和声音；
3. 创建 FLY session、固定时钟、大气、世界区块和权威飞行器；
4. 将已充盈 C-100 放置在可起飞田野，篮筐与地面接触，燃烧器关闭；
5. 用户手势解锁旅程音频；
6. 控制所有者设为 MANUAL；
7. 用户通过真实加热建立净浮力并离地。

不使用加载完成后自动上升的开场动画。出发空间可以用短暂相机过渡，但物理状态从第
一个权威步开始连续。

### 8.2 旅程阶段

```text
READY_ON_FIELD
  → HEATING
  → LIFTOFF
  → FREE_FLIGHT
  → AUTO_RECOVERY（可选）
  → LANDING
  → RECOVERED
```

阶段只是可测试标签，不直接写速度或位置。进入条件由接触、温度、净浮力、控制权和
着陆状态决定。

### 8.3 返回

- 旅程中返回 SITE_SELECT 属于放弃本次会话；必须经过一个无文字但明确的二次确认，
  防止误触；
- RECOVERED 后返回不需要再次确认；
- 返回会 dispose FLY，并清除燃料、世界区块、天气、音频和控制输入；
- 再次进入 FLY 使用新 session 和规范起点，不恢复上次位置或燃料。

## 9. 输入所有权

输入按动作分层：

- `SITE_SELECT`：只允许选择、聚焦、进入；
- `FLY_CONFIG`：只允许旋转预览、选择、指南、出发和返回；
- `FLY_GUIDE`：焦点和关闭/确认归指南，飞行持续输入清零；
- `MANUAL FLIGHT`：燃烧器、vent、相机、指南和自动恢复请求；
- `AUTO_RECOVERY`：自动系统拥有燃烧器/vent，用户保留相机、指南、取消和紧急返回；
- `SOURCE_SESSION`：沿用 SOURCE 原有输入所有权。

同一个按键不能在同一状态同时驱动相机和飞行器。失焦、页面隐藏、pointercancel 和
设备旋转后，所有持续动作必须安全释放。

触控不能被当作桌面附属功能。燃烧器、vent、指南、自动恢复和返回都要有可点击、
可保持、可取消的触控对象，并处理多指取消和 pointer capture。

## 10. 相机

FLY 至少提供：

- `PILOT`：篮筐内驾驶员位置，自由环视；
- `CHASE`：飞行器外部跟随，保持地平线与相对风感；
- `ORBIT`：外部近距离观察模型，不改变飞行器控制。

相机状态不是飞行器物理状态。切换视角不能改变质量、重心、风或自动规划。PILOT
视角随篮筐真实摆动，但可以加入有界的视觉舒适阻尼；阻尼只作用相机，不能把篮筐
角运动删掉。

移动端的相机手势与持续燃烧器触控必须可同时区分，不能因为观察而误关/误开阀门。

## 11. 音频门和空间声音

- SITE_SELECT 只在第一次用户手势后允许简短环境预览；
- 进入 SOURCE 或 FLY 时，宿主把唯一活动音频 scope 交给该场景；
- FLY_CONFIG 的预览声必须在正式出发时销毁，不能与真实燃烧器叠加；
- 飞行指南暂停时，持续飞行声按暂停策略冻结/平滑静音，关闭后恢复同一状态；
- 场景 dispose 后所有 voice 必须停止并断开；
- AudioContext 可以由宿主复用，但场景 AudioNode、监听器与业务状态不能共享；
- 浏览器未解锁音频时，物理仍可初始化但不能偷偷补播错过的事件。

## 12. 错误与恢复

- 场景模块加载失败：返回 SITE_SELECT，并用非文字错误状态标记对应入口不可进入；
- WebGL context lost：暂停权威时钟和输入，恢复资源后从同一 session state 继续；
- 物理出现 NaN/越界：立即停止推进，保存调试快照，不能重置位置假装恢复；
- 区块生成超时：降低前进预取或使用同种子的低细节代理，不能生成无碰撞黑洞；
- AudioContext 失败：场景仍可运行，记录音频不可用，不循环申请权限；
- 内存压力：先降低远景 LOD、云采样和缓存，不降低飞行物理正确性。

## 13. 测试接口

生产页面保持无调试文字，但自动化可读取结构化快照：

```js
window.__SITE__ = {
  state,
  activeScene,
  sceneGeneration,
  resourceCounts,
  chooseScene(id),
  returnToSelector()
}

window.__FLY__ = {
  session,
  stage,
  controlOwner,
  atmosphere,
  vehicle,
  world,
  originShiftCount,
  activeChunkCount,
  audio,
  cameras
}
```

实际名称可以调整，但必须可检查：

- 当前只有一个活动场景；
- create/dispose 次数配对；
- RAF、监听器、音频和物理对象数量不会随往返增长；
- FLY 物理状态和控制权；
- SOURCE 原有测试接口仍可访问；
- 普通页面看不到这些字段。

## 14. 响应式和可访问性

- 页面固定一个视口，无横向或纵向滚动；
- 选择缩影、指南和触控控制适配 `390×844`、`768×1024`、`1440×900`；
- 刘海、安全区和横竖屏变化不遮挡必要控制；
- 操作指南文字满足可读对比度，不以微小蓝字叠在云层上；
- 无文字入口仍拥有可访问名称、键盘焦点和 reduced-motion 替代反馈；这些语义不会
  作为普通可见文案；
- `prefers-reduced-motion` 减少选择空间相机飞入、预览旋转和非必要云动效，不更改
  物理旅程结果。

## 15. 首阶段明确非目标

- 不在选择器展示尚未实现的飞机、UFO、航天飞机或危险天气；
- 不把“未来可扩展”实现为大量空类、空按钮或假数据；
- 不在 SOURCE 内放置通往 FLY 的业务物体；场景入口由全站宿主拥有；
- 不共享 SOURCE 的反应堆时钟、相机、物理世界或音频节点；
- 不用传统文字卡片代替三维选择空间；
- 不在首阶段加入账号、保存、联网天气、地图下载或多页面路由。

## 16. 验收序列

浏览器必须完整执行：

```text
刷新
→ SITE_SELECT（无业务场景运行）
→ SOURCE（原有行为正常）
→ SITE_SELECT（SOURCE 已 dispose）
→ FLY_CONFIG（晴空/C-100 已选）
→ FLY_GUIDE（文字只在指南内）
→ FLY_DEPARTURE
→ 手动加热并离地
→ FREE_FLIGHT / 跨风层 / 原点迁移
→ AUTO_RECOVERY
→ LANDING / RECOVERED
→ SITE_SELECT（FLY 已 dispose）
→ SOURCE（第二次进入仍是新而正确的 SOURCE 会话）
```

每个边界记录活动场景、时钟、RAF、监听器、刚体、音频 voice、区块和 GPU 资源计数。
任何计数持续增长、上一场景继续发声或状态继续前进，都属于阻塞问题。
