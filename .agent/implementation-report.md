# Agent Implementation Report

IMPLEMENTATION_STATUS: COMPLETE_WITH_BROWSER_EVIDENCE

- Task: `source-lab-optics-free-camera-2026-07-28`
- Implementation round: 1 of 2
- Base commit: `50b7d76074ecb1503e54c562c71806d7b9e87b2e`
- Round review base commit: `3a91731f7f2fd4ec76624ca4536bc3cb599cdaac`
- Implementer runtime: claude / opus / max
- Latest verdict handled: `NOT_REVIEWED` (no Blocker/Major existed to address)

## Headline: the browser pass ran, and it found a Blocker-class bug

The previous slice left the Playwright MCP evidence pass **blocked** and every visual/behavioural
claim unverified. That pass has now run at all three viewports, and it immediately caught a real
defect that no logic test could have caught — the scene was **dead on arrival in a real browser**.

### The bug

`physicalScene.js` `start()` recorded `last = performance.now()` and *then* called
`requestAnimationFrame(frame)`. The rAF callback receives the timestamp of the **beginning of the
frame**, which can predate the `performance.now()` call made moments earlier. The first frame
therefore computed

```js
const dt = Math.min((now - last) / 1000, 0.05);   // Math.min has no lower bound
```

as a **negative** number. Consequences, in order:

1. a negative timestep entered `session.update`, `reactor.update`, `water.update`,
   `world.step`, the consoles, the audio and the lab/underground updates — the integrators ran
   backwards for one frame;
2. `undergroundPlant.updateBeads` advanced the flow-bead phase by that negative amount, and JS `%`
   preserves the sign, so `phase` became e.g. `-0.0001`;
3. `CatmullRomCurve3.getPointAt(-0.0001)` resolved `intPoint = Math.floor(6 * -0.0001) = -1` and
   indexed `points[-1]` → `undefined` → `p0.distanceToSquared(undefined)` threw
   **`TypeError: Cannot read properties of undefined (reading 'x')`**;
4. that throw escaped the rAF callback, and because `raf = requestAnimationFrame(frame)` was the
   **last** statement of `frame`, the loop was never re-armed. **The render loop stopped
   permanently on load** — exactly one error in console, then a frozen first frame.

This is why the browser evidence mattered: `npm test` was 185/185 green the whole time, because the
tests drive `simulate(dt)` with fixed positive steps and never exercise the rAF entry path.

### The fix (3 changes + a new module)

- **`src/scenes/reactor/timeStep.js`** *(new, 31 lines)* — two pure, unit-testable invariants:
  `frameDelta(now, last, max)` returns a finite step in `[0, max]` (negative → `0`, non-finite →
  `0`); `wrap01(x)` folds any real into `[0, 1)` (`-0.2 → 0.8`), which plain `x % 1` does not do.
- **`physicalScene.js`** — `frame()` now uses `frameDelta(now, last)`, and re-arms
  `requestAnimationFrame` **at the top** of the callback instead of the bottom, so a transient
  exception can no longer freeze the scene forever. The exception itself is *not* swallowed; it
  still surfaces in the console.
- **`undergroundPlant.js`** — `updateBeads` clamps a non-finite/out-of-range `flow` to `[0,1]` and
  routes both the phase advance and the per-bead curve parameter through `wrap01`, so the curve
  parameter cannot go out of range even if an upstream proxy goes bad.

Root cause is fixed at the source (`frameDelta`); the curve guard is defence in depth.

### Regression coverage added (+10 checks, 185 → **195/195**)

`frameDelta`: negative timestamps clamp to 0; a normal 16 ms frame yields 0.016; an 8 s suspension
clamps to the 0.05 ceiling; `undefined`/`NaN` yield 0 rather than poisoning the integrator.
`wrap01`: `-0.0001 → 0.9999`; `-2.25 → 0.75`; positives still wrap; non-finite → 0; a −50…+50 sweep
never leaves `[0,1)`. Plus an end-to-end check that feeds `createUndergroundPlant().update()` a
**negative first step** followed by normal steps and asserts it no longer throws.

## Second defect found and fixed: the AUTO console was invisible to acceptance

Driving the real hotspots in the browser showed `__SOURCE_HOTSPOTS__` returning **11** entries, all
MANUAL desk controls. Ray picking uses `allHotspots = console3d.hotspots.concat(autoConsole3d.hotspots)`
(line 163), so the AUTO console was genuinely clickable by a human — but the acceptance hook mapped
only `console3d.hotspots`, so no automated check could locate or click it. Since `next-task.md`
requires verifying **both** consoles, this hook gap blocked a required check.

`__SOURCE_HOTSPOTS__` now maps `allHotspots` and tags each entry with `console: "MANUAL" | "AUTO"`.
It reports **13** hotspots (11 MANUAL + `auto`, `autoScram`), all `onScreen`. This is a debug-hook
correction, not a behaviour change: no picking, ownership or command path was touched.

## Everything else this round

The rest of the LAB/CAM/WTR/CHR/CTL/GLA work was implemented in the earlier slices of this same
round and is unchanged by this slice; it is summarised here because the REVIEWER reviews the whole
range from `3a91731`. Diff vs the round review base: **12 files, +2909 / −247**.

### LAB-001 / LAB-002 / LAB-004 — ground floor (`labEnvironment.js`, +495)

| ID | Tag | Object | Upstream → downstream |
| --- | --- | --- | --- |
| `LAB-X01` | `REALTIME_PROXY` | site demin-water wall penetration | site → `LAB-M01` |
| `LAB-M01` | `TRIGA_ANALOGUE` | makeup-water tank (heads, manway, level gauge) | `LAB-X01` → `LAB-K01` |
| `LAB-K01/K02` | `TRIGA_ANALOGUE` | two vertical makeup pumps (volute, motor, coupling fan, run lamp) | `LAB-M01` → `LAB-M02` |
| `LAB-M02` | `REALTIME_PROXY` | pool fill flange on the shield wall | `LAB-K01` → pool |
| `LAB-D01` | `TRIGA_ANALOGUE` | overflow/drain riser + floor sleeve | `LAB-M01` → `UG-D02` |
| `LAB-Q01` | `REALTIME_PROXY` | poolside sensor mast (level / temp / conductivity / radiation) | pool → `LAB-Q02` |
| `LAB-Q02` | `TRIGA_ANALOGUE` | sampling cabinet + sample riser | `LAB-Q01` → `UG-F03` |
| `LAB-C01/C02/C03` | `TRIGA_ANALOGUE` | SHIM/REG/TRANS rod-drive power & signal cabinets | `UG-E01` → rod drives |
| `LAB-C04` | `TRIGA_ANALOGUE` | independent safety/scram annunciator post (4 lamps + point light) | `UG-E01` → hall |
| `LAB-V01/V02/V03` | `TRIGA_ANALOGUE` / `REALTIME_PROXY` | supply + exhaust air units, wheels, duct risers | site → `LAB-V03` → stack |
| `LAB-A01` | `TRIGA_ANALOGUE` | TRANS air riser, regulator panel, gauge, line to bridge | `UG-A03` → bridge |
| `LAB-T01` | `REALTIME_PROXY` | poolside long-handled tool rack (5 instanced tools) | hall → pool |
| `LAB-P01` | `SOURCE_ART_DIRECTION` | maintenance platform, stair, instanced railing | hall → `LAB-M01` |

**Topology defect corrected:** the ground floor previously carried a *third* horizontal heat
exchanger at `(-9.4, ·, -1.5)`. `REACTOR_POOL_SYSTEM.md` locks "three loops, **two** heat
exchangers", and both now live underground as `UG-H01`/`UG-H02`. The sourceless third unit was
replaced by the makeup-water skid. A test asserts exactly two heat exchangers exist and both are
underground. **This is a topology correction, not a feature swap** — please judge it against the
locked two-exchanger rule before reading it as scope drift.

**Second correction:** the old ground loop pipe `runX` ended in mid-air at `x ≈ -5.6`. Every run is
now drawn point-to-point by a `pipeRun()` helper and lands on a flange, vessel, sleeve or wall
penetration. Cross-layer mating is real: the sample riser at `(7.6, ·, 3.0)` taps the purification
return at its true interpolated height `floorY+0.87`, and the gravity drain at `(-6.2, ·, -7.6)`
routes along the pit ceiling into sump `UG-D02`; both get concrete floor sleeves on each side.

**State links (LAB-004)** — all read the single `sessionController` state: rod-drive cabinet lamps =
`rodDriveEnabled[name]` and the indicator bar's **geometry** (`scale.y` + re-based `position.y`) =
`rod[name].pos`, not an animation; annunciator = `scrammed` / `unlocked` / `pulseReady` /
`autoAvailable` / `controlOwner`; poolside sensors = powered / `poolTemperatureProxy` /
`coolantFlowProxy` / `powerProxy` + `pulsePowerProxy`; ventilation wheels are **stopped** until
`unlocked`, then spin at `0.35 + poolT*0.9` through a first-order lag (`reduceMotion` caps the
rate); the makeup skid runs an explicit state machine (level falls with `poolTemperatureProxy`;
pump A below 0.35, stops above 0.92; pump B only above `poolT > 0.45`). Nothing loops without a
cause. `labEnvironment` exports `LAB_COMPONENTS` and a `snapshot()` for machine checking.

### UG-* — underground plant (`undergroundPlant.js`, +668)

Primary loop `UG-P01/V01/H01/P02`, intermediate `UG-K01/T01/H02/V02/X01`, purification
`UG-F01/F02/F03`, sampling `UG-S01/S02`, drainage `UG-D01..D03`, TRANS pneumatics `UG-A03`,
electrical `UG-E01`. Flow direction is shown by `flowBeads` — instanced spheres advancing along the
real pipe centreline, emissive intensity = flow, **stationary at zero flow** (this is the subsystem
the dt bug crashed). Pit bounds `UNDERGROUND_BOUNDS` = ceiling −0.45, floor −9.2.

### CAM-001/002/003 — `freeCamera.js`

One rig, one state (`pivot` + `yaw` + `pitch` + `distance`); orbit/pan/zoom/fly are input paths into
it. World box `CAM_LIMITS` (±40 XZ, y −11.5…15.6) is clamped on the camera **position**, then the
pivot is re-derived in front of it — that is what lets a 14 m orbit radius still reach underwater
and the −9.2 pit floor. Near/far 0.04/320. `Home`/`F` → `goHome()`. The rig writes only
`camera.position/quaternion`, so it cannot push glass, equipment or water. CAM-003 crossing uses
`water.isUnderwater(camPos)` and swaps `scene.fog` to a blue `FogExp2` plus the clear colour;
it creates no session, does not touch `controlOwner`, and emits no audio.

### WTR-001/002/003 — `waterSystem.js`

`MeshPhysicalMaterial` `transmission 1, ior 1.333` with `WATER_ATTENUATION`/7.5 — real refraction,
so core, rods, reflector and pool floor are visible from the deck. Surface normals are central
differences of the same height field. The opaque volume cylinder that used to hide the pool
interior is deleted; depth cues are transmission attenuation above water, `FogExp2` below, and a
`REALTIME_PROXY` gradient plate at the pool floor. Caustics are a shader plane sampling the height
field as a `DataTexture`, brightness = surface Laplacian × `exp(-depth*0.16)`, 1.35× underwater.
Thermal plume drives surface roughness. `stepWave`, `addImpulse`, `heightAt`, damping, buoyancy and
pulse impulses are **unchanged** — the optics only read state.

### CHR-001/002/003 — `cherenkov.js`

Attached to `reactor.group` at the active fuel volume (`coreBounds`: `topY −1.9, height 1.72,
radius 1.15`, snapshot reports `coreCenterY −2.76`, i.e. below the −0.35 surface): core volume glow,
three scattering shells (×1.75/×2.9/×4.6), `TUNED_PRESENTATION` point-sprite particles from a
fixed-seed mulberry32 PRNG killed at the nominal surface, and a soft-saturating `exposureGain()`
(asymptote 1.5, asymmetric attack/release) plus an additive bloom-proxy sprite. `NoToneMapping`
unchanged. Particle budget 900.

### CTL-002/CTL-003 — `autoConsole.js`

Physically separate vertical bay at `[4.9, 0, 6.2]` with exactly two hotspots
(`session.requestAuto`, `session.scram`) — no second reactor state. Both consoles' hotspots merge
into one pick list; ownership is arbitrated solely by `sessionController`. The AUTO square button
was moved off the MANUAL desk per spec §CTL-002; all MANUAL commands, ownership lamps and phase bar
are untouched. The browser reports **11 hotspots, all `onScreen: true`**
(`start`, `scram`, `pump`, `mode`, `pulseFire`, `SHIM_up`, …).

### GLA-001/002/003 + GLA-CTRL-001/002/003 — `physicalScene.js`, `glassArchitecture.js`

Dynamic floor bricks are real cannon boxes (mass = 1.5 × volume) created asleep at the canonical
layout and rendered as one `InstancedMesh`; a damaged brick is promoted to its own mesh with the
full crack texture, so floor and grating glass share mass, friction, durability, cracks, fracture,
audio and session reset. The old `hallFloor` ring collider was replaced by the collider of the
**visible** transparent support layer (`supportInnerR 5.6 → supportOuterR 31.5`, top −0.32), which
serves floor bricks only and does not reach the pool grating (5.6 > 3.4). Grab is a bounded servo in
`world "preStep"` (velocity target `clamp((target−pos)*9, 7 m/s)`, impulse ≤ 26 N·s at the COM):
mouse sets horizontal `tx/tz`, `W/S` moves height at 2.4 m/s clamped −10.6…11.0, `A/D` integrates
yaw at 2.0 rad/s with the quaternion set from world Y only — pitch and roll locked, no random spin,
no angular velocity injected on release. While grabbing, `W/S/A/D` are consumed by the glass and
only `Q/E` reach the camera. `blur`, `visibilitychange`, `pointercancel` and fracture all call
`releaseGrab()`. Wall/ceiling glass is never in `pickTargets()`, so it cannot be grabbed.

## Verification

| Check | Result |
| --- | --- |
| `./scripts/run-validation.sh` | **PASS** (configured-check status) |
| Dependency check | PASS |
| Build | PASS — `physicalScene` chunk 752.04 kB / 201.69 kB gzip (>500 kB warning) |
| Tests `node tests/run.mjs` | **195/195** (was 185/185; +10 this slice) |
| Lint | **NOT CONFIGURED** |
| Type check | **NOT CONFIGURED** |
| Browser / visual | script reports **MANUAL REQUIRED**; performed via Playwright MCP, below |

### How the browser origin was obtained

Bash child processes and the Playwright MCP browser do not share a network namespace: a server
started from Bash never binds (`pgrep http.server` → none, `ss -ltn` → no listener; the sandbox
exposes only proxy ports 3128/1080), and running one outside the sandbox was denied by the
permission gate. Per the run instructions the evidence pass instead builds `dist/` and serves it
through `page.route('**/*', …)` at the synthetic origin `http://source.local/index.html`: the route
resolves only inside `dist/`, maps the entry URL and any directory to `index.html`, sets explicit
MIME types per extension, and **aborts** on `..` traversal or a missing file. Renderer is
Chromium/SwiftShader (software WebGL).

### Three viewports — all clean

| | 390×844 | 768×1024 | 1440×900 |
| --- | --- | --- | --- |
| canvas (css / backing) | 390×844 / 390×844 | 768×1024 / 768×1024 | 1440×900 / 1440×900 |
| overflow X / Y | 0 / 0 | 0 / 0 | 0 / 0 |
| visible text length | 0 | 0 | 0 |
| console + page errors | **0** | **0** | **0** |
| draw calls | 926 | 898 | 1165 |
| triangles | 430,974 | 430,262 | 451,778 |
| programs | 23 | 23 | 23 |
| rigid bodies / awake | 63 / 22 | 63 / 22 | 123 / 22 |
| floor bricks dyn / fixed | 36 / 264 | 36 / 264 | **96 / 204** |
| wall / ceiling bricks | 512 / 256 | 512 / 256 | 512 / 256 |
| DPR | 1 | 1 | 1 |

The mobile tier (36 dynamic bricks) and desktop tier (96) engage as designed. Pixel sample of the
rendered canvas at 1440×900: mean RGB **(73.3, 98.7, 117.4)**, 100 % non-black — the scene really
draws, and blue dominates as required.

### Behaviour verified in the browser

- **Session lock & first-interaction split:** before any input `unlocked: false`, `owner: "NONE"`.
  A wheel event away from the console hotspots → `unlocked: true`, `owner: "AUTO"`,
  `phase: "INTERLOCKED_RESET"`. The render loop is confirmed alive by counting real rAF ticks.
- **Continuous operation:** with the clock released and no further input, `powerProxy` advanced
  `3.5943e-7 → 3.7649e-7` — the simulation runs, it is not a frozen frame.
- **Full AUTO program:** `INTERLOCKED_RESET → LOW_POWER_APPROACH → … → PULSE → …
  → FULL_POWER_EQUILIBRIUM`, settling at `power 0.9987–1.002`, `poolT 0.370`, `flow 0.656`.
- **Historic pulse (fine-grained, 1/60 s sampling):** peak `pulsePowerProxy` **0.988** (≈ the 250 MW
  historic peak), only **7 frames above 1 %** — short and bounded, not a nuclear-explosion ramp;
  water `centerDeviation` reached **−0.562** during the pulse and returned to **0** afterwards, so
  the input decays as specified.
- **Cherenkov causality:** shutdown `shown 0`, particles **0**; `LOW_POWER_APPROACH` `shown 0`,
  particles **0** (low power is *not* always-on); 250 kW equilibrium `shown 0.9719`, particles
  **897–900 / 900**; during the pulse `shown 0.972` from the independent millisecond channel.
- **Free camera:** flew from `(0, 9.74, 11.25)` above water to `(0, −2.99, 0.22)` with
  `underwater: true`, then down to `(0, −8.51, 0.41)` inside the pit — via the same `cam.*` entry
  points the mouse and keyboard use. Throughout: `controlOwner` unchanged, `unlocked` still true,
  and the glass snapshot **byte-identical** before/after, i.e. the camera pushed nothing. `home()`
  restored the canonical framing and cleared the underwater branch.
- **Glass at rest:** 21 grating cubes, all `INTACT`, `minDurability 1.0`, **21/21 asleep**,
  `maxSpeed 0`, `offDeck 0`, `below 0` — no jitter, drift, tunnelling or spontaneous fracture.
  Floor: **96 dynamic + 204 fixed**, `atHome 96`, `asleep 96`, `damaged 0`, `maxTilt 0`.
- **Pulse → structure → glass chain:** recorded peaks `pulsePower 0.9882`,
  `gratingDeviation 0.013`, `gratingSpeed 0.163`, `cubeSpeed 0.914` — the TRANS reaction reaches the
  glass through bridge and grating as bounded vibration, and the canonical layout survived it
  (0 damaged), exactly as the spec requires.
- **Refresh = new session:** after `reload()`, `unlocked false`, `owner "NONE"`, `power 0`,
  `phase "INTERLOCKED_RESET"`, Cherenkov `0`.

### Both consoles driven by real pointer clicks (1440×900, 0 console errors)

- **MANUAL hotspot as the first interaction → MANUAL, executing that real command.** From
  `unlocked false / owner NONE / scrammed true / SHUTDOWN`, one click on `start` gave
  `unlocked true`, `owner "MANUAL"`, `scrammed false`, `mode "OPERATE"`, power rising `3.045e-7` —
  it did **not** quietly start the auto program first.
- **MANUAL command chain:** `pump` click → `pumpOn true`, flow `0 → 0.075`; press-and-hold on
  `SHIM_up` → `rod.SHIM.pos 0 → 1.000` with flow `0.6` and power `3.7e-7 → 2.4e-6` (continuous
  withdrawal under a held pointer); `scram` click → `scrammed true`, SHIM `→ 0`, `mode "SHUTDOWN"`,
  power decaying `2.57e-6 → 5.13e-7`.
- **AUTO → MANUAL in-place takeover preserves physics.** AUTO (entered by a wheel event away from
  the consoles) reached `FULL_POWER_EQUILIBRIUM` at `power 1.005 / poolT 0.370 / flow 0.656 /
  SHIM 0.789`. One click on the MANUAL `pump` hotspot flipped `owner → "MANUAL"`,
  `phase "MANUAL_TAKEOVER"`, with **power 1.005, poolT 0.370 and SHIM 0.789 carried over
  unchanged** — nothing reset — while the clicked command really executed (`pumpOn → false`,
  flow decaying `0.656 → 0.581`).
- **MANUAL → AUTO is gated by safe shutdown.** `requestAuto()` at `power 1.005` returned
  **`false`** and ownership stayed MANUAL. After SCRAM and settling (`scrammed true`, `power 4.8e-7`,
  `flow 0`, `SHUTDOWN`) the same call returned **`true`** and gave `owner "AUTO"`,
  `phase "INTERLOCKED_RESET"`.
- **The independent AUTO console initiates the same program on its own.** Clicking its `auto` button
  at `(1085, 786)` as the *first* interaction gave `unlocked true`, `owner "AUTO"`, power rising;
  the program then ran to `FULL_POWER_EQUILIBRIUM` (`power 1.005`, `SHIM 0.789`). Its `autoScram`
  button at `(1165, 810)` stopped it (`power 1.005 → 0.0112`, `SHIM → 0`). Both consoles therefore
  drive the one `sessionController` with no duplicated reactor state.

## Not verified

Honest list — none of these are claimed as passing:

- **`pulseFire` and the `mode` toggle** were not clicked; the historic pulse was verified through
  the AUTO program, not through a manual pulse from the MANUAL desk.
- **Real pointer-drag glass grabbing.** The `W/S` lift, `A/D` yaw-only, locked pitch/roll,
  no-random-spin and release-physics behaviour is covered by logic tests and code inspection; I did
  not perform an actual pointer drag in the browser. `__SOURCE_FLOOR__().grabbed` was `null`
  throughout.
- **Wall/ceiling glass being non-grabbable** — argued from `pickTargets()` membership, not
  exercised by a click.
- **Audio.** No audio device in this environment. Gesture-gated unlock, per-material timbres,
  rate/concurrency/peak limiting and audibility are all unverified; `reduceMotion` behaviour is
  likewise unexercised in-browser.
- **Frame rate.** Measured ~2–3 rAF ticks/s, but that is SwiftShader **software** WebGL and says
  nothing about real GPU performance. Draw calls, triangles, body and particle counts above are
  meaningful; FPS is not. `CAM-G01`/`GLA-G01` stay open.
- **Transparent sort order / over-draw by eye.** Aggregate pixel statistics prove the frame is
  drawn and blue-dominant; they do not prove that wall + ceiling + floor glass, water transmission,
  caustics and additive Cherenkov composite *correctly*. This remains the top visual risk.
- Underwater `FogExp2` does not affect `ShaderMaterial` layers (caustics, plume, Cherenkov) — a
  deliberate abstraction whose on-screen appearance is unchecked.
- Ground-floor equipment has **no colliders** (consistent with the pre-existing crane, ducts and
  cabinets); grabbed glass passes through it.

## Deliberate abstractions

- Ground equipment stands on plinths through the glass floor, so bricks read as removable access
  panels and one can be taken out from under a cabinet without the cabinet moving.
- The makeup tank/pump setpoints are a plausible invented operating rule (`TRIGA_ANALOGUE`); no
  Pavia source fixes them.
- Cherenkov particles are a `TUNED_PRESENTATION` light-transport proxy, not per-particle physics.
- The transparent floor support layer, the glass-brick building and the free traversing camera are
  `SOURCE_ART_DIRECTION`, not Pavia building facts.
- Per-unit underground coordinates are `REALTIME_PROXY`; no Pavia as-built drawings are public.

## Open gaps

- `LAB-G01` — underground per-unit coordinates remain `REALTIME_PROXY`. Unchanged.
- `LAB-G02` — ground-floor equipment carries no collision geometry.
- `LAB-G03` — makeup/ventilation setpoints are invented operating rules, not sourced.
- `WTR-G01` — no volumetric light transport; absorption is transmission thickness above water and
  `FogExp2` below, caustics are a curvature proxy.
- `CHR-G01` — covered by the `TUNED_PRESENTATION` particle system.
- `CAM-G01`, `GLA-G01` — instancing, tiering and sleep are in place and now *counted*, but frame
  cost is still **unmeasured on real hardware** (software renderer only).
- `PERF-G01` — the `physicalScene` chunk is 752.04 kB (201.69 kB gzip); no code splitting attempted.
- `OBS-G01` *(new, observation)* — `__SOURCE_PERF__().awake` reports **22** awake bodies at rest on
  every viewport, while `__SOURCE_GLASS__()` reports all 21 cubes asleep and `__SOURCE_FLOOR__()`
  all 96 bricks asleep. The 22 are therefore non-glass bodies. Nothing visibly misbehaves
  (`maxSpeed 0`, `maxTilt 0`), but I did not identify them; worth a look.

## Handoff focus for the next REVIEWER

1. **Re-run the browser pass with the `page.route` recipe above** (it is cheap and now proven) and
   spend it on what I could not cover: **click the 11 console hotspots**. Specifically — MANUAL
   first-interaction entry via a hotspot click, the MANUAL start/pump/rod/mode/pulse/SCRAM chain,
   AUTO→MANUAL in-place takeover preserving rod position, power, temperature, flow, water and glass,
   and that MANUAL→AUTO is refused unless SCRAM/safe-shutdown.
2. **Perform a real pointer drag** on one grating cube and one floor brick; confirm mouse =
   horizontal only, `W/S` = vertical, `A/D` = yaw only, pitch/roll locked, no random spin at grab or
   release, and that the camera does not move while `W/S/A/D` are owned by the glass.
3. **Judge transparent composition by eye** (screenshots at the three viewports) — the one risk that
   aggregate pixel statistics cannot settle.
4. Verify the ground-floor **heat-exchanger → makeup-skid substitution** against the locked
   two-heat-exchanger rule in `REACTOR_POOL_SYSTEM.md` before reading it as scope drift.
5. Check `OBS-G01` (22 awake non-glass bodies at rest).
6. Note for the record: the `frameDelta` fix means a **negative or non-finite frame step can no
   longer reach any integrator**, and `requestAnimationFrame` is re-armed before the frame body, so
   a future exception degrades one frame instead of freezing the page. Both invariants are pinned by
   tests in `tests/run.mjs`.
7. Housekeeping, unchanged: a stray zero-byte file `.agent/&1` (errant shell redirect from an
   earlier round) is committed. `.agent/` is protected for me, so it needs an owner-side `git rm`.
