# CLAUDE.md

这个文件给接手开发的 Claude 看。开始任何工作前，先读 `PLAN.md`（项目的唯一依据，写给主人看）
和 `docs/HANDOVER.md`（当前状态、下一步、经验教训、参考资料）。

## 项目

一个作品型网站：你坐在一架视野极广的玻璃泡座舱飞机里飞行，天空、云、雷暴看起来、听起来都像
真的。线上网址就是进度预览：<https://vicious-w.github.io/>（白天）、`?night`（夜航雷暴）。

- 场景一《云中飞行》：白天在海面上空的云层间巡航。M1 已通过；**冻结**（主人 2026-11-21：只做夜航，
  夜航做好后再考虑其他）。改共用代码时白天不能变。
- 场景二《夜航雷暴》：夜里飞进雷暴，越飞越深，最终飞进异星云海（恐怖）。已是独立的部分，
  **主人全权交给你**（2026-11-21）：里程碑由你按 `PLAN.md` 的通过标准自己判断，做完就上线。
  N2 通过（第五版，2026-11-18）；N3 声音第三版（2026-11-21）；接着做 N4–N6。
- 主人的长期设想：做成一款充满未知、可以不断探索的恐怖航行游戏。

## 和主人合作的规则

- **用中文交流**。汇报简短，只讲结果：做了什么、主人需要做什么、还有什么没确认。代码注释和
  提交信息用英文。
- **全权负责**：主人把设计、实现、测试和决定权全部交给你，他只关心结果。不要拿可以自己决定
  的事去问他；只有必须由他做的事（比如他的电脑上的操作）才请他做。
- **他的反馈只是最明显的问题**：不是完整清单，没提到的不代表没问题。每一处细节都要自己判断、
  自己检查，不要等他指出。
- **里程碑**：每个里程碑完成后上线并汇报，附网址；主人在自己的电脑上直接运行试玩后给反馈
  （**不用录像**，他不看录像；截图只在需要说明时附）。他的反馈写进 `PLAN.md` 的进度部分。
- **原则**（详见 `PLAN.md` 第 1、10 节）：
  - 作品里不放任何个人信息；画面上除必要的字外不加任何字，仪表也只有图形；
  - "真实"指看起来、听起来真实，要经得起和真实视频对比；
  - 《皇牌空战》只作画面效果的参照，不复刻任何游戏；
  - 只做电脑端（主人的笔记本：RTX 3060 Laptop GPU，外接 2560×1440 显示器，Chrome），不考虑手机；
  - 效果优先：不为硬件预先让步，遇到具体的卡顿再优化。
- **开发方式**：网页技术，画面、声音、座舱全部由代码生成；在主人的电脑上开发，用他的显卡
  实时检查。**开发期间这台电脑完全归你用**（主人 2026-11-17）：按最有利于开发的方式用它，
  比如开着开发服务器和一个可见的 Chrome 窗口一边改一边看（`tools/lab.mjs`），不用顾虑主人
  要用电脑。

## 工作流程

1. 在 `main` 上工作（主人授权直接在线上分支开发）。推送到 `main` 会自动构建并部署到 GitHub
   Pages（`.github/workflows/pages.yml`，通常 1–3 分钟，GitHub 排队时可能更久）。
2. 每次推送前：`npm run build` 通过，`npm run check` 无报错，并且亲眼看过截图或录像。
3. 改动如果会影响白天场景，用 `tools/shot.mjs` 分别对改动前后的构建截图对比。
4. 不要建 PR，除非主人要求；不要用 force push 改写历史；提交小而清楚。
5. 完成后确认线上已经是新版本：线上 `index.html` 引用的 `assets/index-*.js` 文件名应与本地
   `dist/assets/` 一致（仓库统一 LF 换行，本地构建和 GitHub 的构建逐字节相同）。
6. 提交作者用仓库本地配置的 `Claude <noreply@anthropic.com>`，不要用主人的邮箱。

## 常用命令

```bash
npm ci                 # 安装依赖（第一次）
npm run dev            # 开发服务器：http://localhost:5173/?night，改代码自动刷新
npm run build          # 构建到 dist/（工具默认读取 dist/）
npm run check          # 运行几个场景，报告控制台错误和所用的显卡
```

检查和截图工具都在 `tools/`，用 `node` 直接运行（参数里的 `&` 一定要放在引号里）：

| 工具 | 用途 |
| --- | --- |
| `node tools/shot.mjs --sheet 名字 "参数" ...` | 收敛后的静帧截图，可拼成一张总览 |
| `node tools/series.mjs --query="night&t=384" --frames=120 --every=6 --sheet` | 逐帧推进的动态序列，看闪烁、拖影、颠簸 |
| `node tools/record.mjs --query="night&t=380" --seconds=15` | 按真实帧率录成 WebM 视频（可发给主人） |
| `node tools/bench.mjs --size=2560x1440 "night&t=267" ""` | 每帧耗时（等显卡完成）；`--live` 测实际帧率和帧节奏（95% 分位应接近平均帧时间） |
| `node tools/check.mjs "night" "night&t=400" ""` | 控制台检查 |
| `node tools/storm-view.mjs` | 不渲染，直接画出雷暴的平面图和剖面图，打印航线间距和座舱时间线 |
| `node tools/listen.mjs --query="night&t=225" --seconds=40` | "听"声音：抓原始声音，打印倍频程声级和每半秒的响度，存 WAV（`captures/audio/`）。远处的雷要几十秒才到，录得够长；还列出录音里到达的每一声雷（何时、多远、多强） |
| `node tools/spectro.mjs captures/audio/x.wav` | 把录下的声音画成频谱图（同名 PNG）：看气流的起伏、雷的起始、啸声、咔哒声 |
| `node tools/strikes.mjs --from=150 --to=470` | 不渲染，按航程算出每道闪电离飞机多远（雷是炸还是闷由它决定） |
| `node tools/lab.mjs` | 实验窗口：一个可见的最大化 Chrome（和主人的设置一样，2560×1308），开在开发服务器上，用 `curl localhost:9333/...` 控制：`goto`、`shot`、`burst`（实时连拍）、`perf`、`console`、`eval`。改代码后页面自动刷新 |

所有工具都会先打印 `GPU:`。在主人电脑上必须是 NVIDIA 显卡（无头模式就是，不需要 `--headed`；
屏幕锁定时 `--headed` 的窗口会被限到每秒 1 帧）。测性能按主人的屏幕 `--size=2560x1440`。
输出在 `captures/`（不提交）。`--url=http://localhost:5173` 可以直接测开发服务器，不必先构建。
用 `record.mjs` 或 `bench.mjs` 测量时，先让实验窗口离开夜航页面（`eval "location.href='about:blank'"`），
否则两个页面抢同一块显卡，帧率会掉到一半以下。

## 网址参数（调试和截图用）

| 参数 | 作用 |
| --- | --- |
| `night` | 场景二。没有它就是白天 |
| `t=秒` | 旅程时间（夜）/飞行时间（白天） |
| `yaw=`、`pitch=` | 转头方向（弧度） |
| `still`、`frames=24` | 静帧：累积若干帧后停下，设置 `window.__stillDone` |
| `still&motion` | 每帧飞 1/60 秒、使用实时的时间滤波（看动态效果） |
| `flash=ic\|near\|cg\|well\|none`、`ft=毫秒` | 静帧时定格一次闪电：远处云内、近处云内、云对海、竖井下方 |
| `flick=1` | 静帧时让远处的闪烁亮着 |
| `rain=`、`hail=`、`elmo=`、`turb=`、`cloud=`（0–1） | 固定座舱里的雨、冰雹、圣埃尔摩之火、颠簸、在云中的程度 |
| `cockpit=0` | 只渲染窗外（没有座舱和玻璃，也没有近处雾） |
| `near=0` | 关掉近处雾（飞机周围 240 m 改由远处的云着色器画），用来对比和测开销 |
| `show=mist|outside` | 只显示近处雾 / 只显示窗外（不含近处雾），找问题用 |
| `hold` | 飞机停在 `t` 的位置，时间照走（雾、气流、闪电照常），看雾自己怎么动 |
| `sound` | 不等点击就开始声音（只在允许自动播放的浏览器里有效，工具都允许） |
| `solo=cabin|weather|knocks|thunder` | 只听一层声音 |
| `free` | 夜里用白天那种自由飞行（没有座舱），配合 `alt`、`heading`、`x`、`z` |
| `scale=0.25–1` | 云的分辨率（默认 1 = 全分辨率） |
| `q=normal\|high`、`steps=N` | 光线步进的质量（默认 high）和最大步数 |

页面上的 `window.__sky = { flight, sky, renderer }` 供工具读取状态。

## 代码地图

- `src/main.js`：入口。创建渲染器、读网址参数、选场景、每帧的顺序、帧率保底（低于 30 帧才降云的分辨率）。
- `src/flight.js`：白天的自动驾驶。
- `src/sky/sky.js`：天空和云的全部渲染：一次性烘焙（噪声体、天气图、巨型积云形状、布云图、蓝噪声、
  大气 LUT），每帧：天空视图 LUT → 云（棋盘格半宽渲染，多目标：画面、深度、夜里的闪电光）→
  时间重建 → 合成（天空、太阳/月亮、星星、卷云、眩光；白天在这里调色，夜里有座舱时输出线性光）。
- `src/sky/cumulus.js`：巨型积云的气泡形状和摆放；`bluenoise.js`；`fullscreen.js`（全屏着色器）。
  `sky.js` 在夜里还画飞机周围 240 m 的近处雾（`mist.frag` + `misttemporal.frag`，半分辨率）。
- `src/shaders/`：`common.glsl`（大气、相函数、AgX 调色）、`transmittance/multiscatter/skyview`（Hillaire 2020）、
  `noise.frag`（烘焙用，含 2 m 精度的雾噪声）、`cloudmap/cloudslope`（布云）、`clouds.frag`（光线步进：密度、光照、雷暴和闪电）、
  `storm.glsl`（雷暴的云：形状、雾的边缘带、碎云和空腔、雷暴的光照；`clouds.frag` 和 `mist.frag` 共用）、
  `mist.frag`/`misttemporal.frag`（近处雾和它的时间混合）、
  `temporal.frag`、`composite.frag`、`glass.frag`（夜里的最后一道：玻璃、水、雨、灯光、调色）。
- `src/night/`：`storm.js`（烘焙的雷暴距离场：塔、云砧、低云层、竖井、云洞）、`journey.js`（航线、
  航线上的碎云和空腔 `SCUD`、座舱时间线、颠簸）、`lightning.js`（主闪电和远处闪烁的调度）、`bolts.js`（发光的线：闪电通道、电弧）。
- `src/cockpit/`：`cockpit.js`（座舱几何、照明、玻璃一道的参数）、`lamps.js`（机上的灯：座舱和近处雾共用）、`instruments.js`（仪表画面，
  无文字；雷达读取雷暴）、`streamers.js`（圣埃尔摩之火的电弧）。
- `src/audio/`：`audio.js`（声音的总装：座舱、颠簸、雷的安排，第一次点击后淡入）、`weather.worklet.js`
  （音频线程上的雨、冰雹、电弧声）、`thunder.js`（闪电通道的形状）、`thunder.worker.js`/`thundersynth.js`
  （后台线程合成雷声）。
- `tools/`：上表的检查工具（只用于开发，不会部署）。
- `docs/reference/past-vision.md`：旧项目构想的摘录，仅供参考。
