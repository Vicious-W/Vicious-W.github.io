# Agent Implementation Report

IMPLEMENTATION_STATUS: COMPLETE_WITH_BROWSER_EVIDENCE

- Task: `source-lab-optics-free-camera-2026-07-28`
- Implementation round: 1 of 2
- Base commit: `d57a45b1648bc204fe255128ad7194b1766d0087`
- Round review base commit: `3a91731f7f2fd4ec76624ca4536bc3cb599cdaac`
- Implementer runtime: claude / opus / max
- Latest verdict handled: `NOT_REVIEWED` (no Blocker/Major existed to address)

## Headline: the browser pass found a Blocker-class physics hole, and it is fixed

The previous slices of this round left three required verifications unperformed: a **real pointer
drag** of grating and floor glass, **wall/ceiling glass being non-grabbable**, and the identity of
the 22 awake rigid bodies (`OBS-G01`). Performing the first of those in a real browser exposed a
defect that no logic test and no numeric snapshot had caught.

### The defect: glass fell through visible concrete, forever

A real pointer drag of grating cube 0 shoved a neighbouring cube over the 0.58 m railing. The cube
then reported `below: 1`, `offDeck: 1` and **never came to rest**. Tracing the geometry:

| radius | what is *visible* there | what the physics world had |
| --- | --- | --- |
| 3.40 → 4.05 | RP-001 walkway ring | `deckSupport` ✔ |
| 4.05 → 4.90 | **`shieldTopCap`, the octagonal bio-shield lid at y = 1.30** | **nothing** ✘ |
| 4.90 → 5.60 | open light well down to the plant (intentional) | nothing (correct) |
| 5.60 → 31.5 | transparent floor support layer | `hallFloor` ✔ |
| pit floor −9.2 | **visible concrete pit slab** | **nothing** ✘ |

So glass lifted over the railing passed straight through a piece of concrete you can see, dropped
into the light well, and fell for ever — no floor existed anywhere below it. The in-code comment at
`physicalScene.js:256` already stated the requirement it was violating: glass thrown outside the
railing "must land on the **visible** concrete operating layer and stop".

### The fix — two colliders, both aligned to geometry that is already drawn

- `reactorModel.js` now exports `shield: { innerRadius: WALK_R, outerRadius: SHIELD_R, topY: SHIELD_TOP }`
  so the collider cannot drift from the mesh.
- `physicalScene.js` `shieldCap`: 16 trapezoidal segments, `deck.outerRadius → shield.outerRadius`,
  top face at `shield.topY`. Same construction as the existing `deckSupport`/`hallFloor` rings.
- `physicalScene.js` `pitFloor`: one box at `UNDERGROUND_BOUNDS.floorY`, spanning the pit's
  ±19.5 m retaining walls — the visible slab the whole plant stands on.

Neither is an invisible collision plane: `PROJECT_SPEC.md` forbids those, and both of these back a
mesh that is rendered. The 4.90 → 5.60 light well is deliberately left open — that is how you see
the underground plant from the operating floor.

**Verified in the browser after the fix** (same drag, replayed): the escaped cube now settles at
**y = −8.70** — exactly the pit slab (−9.2) plus the cube half-height — with `maxSpeed 0`,
**21/21 cubes asleep**, `awakeKinds {}`, `fragments 0`, stage `INTACT`, durability 0.852 (it took
honest fall damage). Tracked for 12 s of simulated time after landing: y never moved again.

### Regression coverage (+4 checks, 195 → **199/199**)

`tests/run.mjs` now pins the drop path as an invariant, not an anecdote: the shield lid's inner
radius must equal the walkway's outer radius (no seam between landing surfaces); the lid must be a
solid ring above the walkway; the lid's outer radius must stay inside `supportInnerR` (the light
well is intentional); and the pit slab must sit below the pool floor and extend past
`supportInnerR` so nothing can fall past it.

## OBS-G01 closed: nothing leaks, the previous measurement was taken too early

`__SOURCE_PERF__` now reports `awakeKinds`, a per-category breakdown of awake bodies. It resolved
the open observation immediately:

- **6 s after load:** `awake 22 = { grating: 1, cube: 21 }`, `cubesAsleep 0`.
- **After `__SOURCE_ADVANCE__(4)`:** `awake 0`, `awakeKinds {}`, `cubesAsleep 21`, grating speed 0.

The cause is measurement timing, not a sleep leak. Chromium/SwiftShader runs this scene at
**0.76 rAF ticks/s**, and `frameDelta` caps a frame at 0.05 s, so six seconds of wall clock advances
the world by only ≈0.2 s — the initial layout had not finished settling. On the real simulation
timeline everything sleeps, including the spring-suspended grating. `OBS-G01` → **CLOSED**.

## New acceptance hooks (read-only, deleted on dispose, no behaviour change)

- `__SOURCE_PICK__()` — `cube(i)` / `brick(i)` / `nearestBrick(x,z)` return a body's screen
  projection **and** `pos`, `tilt`, `yaw`, `spin`, `speed`, `asleep`. `tilt` is the angle between the
  body's local +Y and world +Y, which is exactly GLA-CTRL-002's "pitch and roll locked" expressed as
  a number. `at(x,y)` casts `onPointerDown`'s own ray and reports the first scene hit separately from
  whether that point is in `pickTargets()` — so "wall glass is not grabbable" can be distinguished
  from "the click missed".
- `glassArchitecture.js` names the fixed instanced meshes `GLA-WALL-0..3`, `GLA-CEILING`,
  `GLA-FLOOR-FIXED`, `GLA-FLOOR-SUPPORT` so `at()` can say what was hit.
- `__SOURCE_PERF__().awakeKinds` as above.

Housekeeping: the stray zero-byte `&1` file (an errant shell redirect committed in an earlier round)
is deleted.

## Requirement coverage

The LAB/CAM/WTR/CHR/CTL/GLA work below was built in the earlier slices of **this same round** and is
unchanged except where noted; it is summarised because the REVIEWER reviews the whole range from
`3a91731`. Diff vs the round review base: **14 files, ≈ +3050 / −250**.

### LAB-001 / LAB-002 / LAB-004 — ground floor (`labEnvironment.js`)

| ID | Tag | Object | Upstream → downstream |
| --- | --- | --- | --- |
| `LAB-X01` | `REALTIME_PROXY` | site demin-water wall penetration | site → `LAB-M01` |
| `LAB-M01` | `TRIGA_ANALOGUE` | makeup-water tank (heads, manway, level gauge) | `LAB-X01` → `LAB-K01` |
| `LAB-K01/K02` | `TRIGA_ANALOGUE` | two vertical makeup pumps | `LAB-M01` → `LAB-M02` |
| `LAB-M02` | `REALTIME_PROXY` | pool fill flange on the shield wall | `LAB-K01` → pool |
| `LAB-D01` | `TRIGA_ANALOGUE` | overflow/drain riser + floor sleeve | `LAB-M01` → `UG-D02` |
| `LAB-Q01` | `REALTIME_PROXY` | poolside sensor mast (level/temp/conductivity/radiation) | pool → `LAB-Q02` |
| `LAB-Q02` | `TRIGA_ANALOGUE` | sampling cabinet + sample riser | `LAB-Q01` → `UG-F03` |
| `LAB-C01/C02/C03` | `TRIGA_ANALOGUE` | SHIM/REG/TRANS rod-drive power & signal cabinets | `UG-E01` → rod drives |
| `LAB-C04` | `TRIGA_ANALOGUE` | independent scram annunciator post | `UG-E01` → hall |
| `LAB-V01/V02/V03` | `TRIGA_ANALOGUE` / `REALTIME_PROXY` | supply + exhaust air units, wheels, duct risers | site → `LAB-V03` → stack |
| `LAB-A01` | `TRIGA_ANALOGUE` | TRANS air riser, regulator panel, gauge | `UG-A03` → bridge |
| `LAB-T01` | `REALTIME_PROXY` | poolside tool rack (5 instanced tools) | hall → pool |
| `LAB-P01` | `SOURCE_ART_DIRECTION` | maintenance platform, stair, instanced railing | hall → `LAB-M01` |

**Topology correction:** the ground floor previously carried a *third* horizontal heat exchanger at
`(-9.4, ·, -1.5)`. `REACTOR_POOL_SYSTEM.md` locks "three loops, **two** heat exchangers"; both now
live underground as `UG-H01`/`UG-H02` and the sourceless third unit was replaced by the makeup
skid. A test asserts exactly two exist and both are underground. Judge this against the locked
two-exchanger rule before reading it as scope drift.

**Second correction:** the old ground loop pipe ended in mid-air at `x ≈ −5.6`. Every run is now
drawn point-to-point by `pipeRun()` and lands on a flange, vessel, sleeve or wall penetration.
Cross-layer mating is real: the sample riser at `(7.6, ·, 3.0)` taps the purification return at its
true interpolated height `floorY+0.87`; the gravity drain at `(-6.2, ·, -7.6)` routes along the pit
ceiling into sump `UG-D02`; both get concrete floor sleeves on each side.

**LAB-004 state links** — all read the single `sessionController`: rod-drive cabinet lamps =
`rodDriveEnabled[name]`, and the indicator bar's **geometry** (`scale.y` + re-based `position.y`) =
`rod[name].pos`, not an animation; annunciator = `scrammed`/`unlocked`/`pulseReady`/`autoAvailable`/
`controlOwner`; poolside sensors = powered/`poolTemperatureProxy`/`coolantFlowProxy`/`powerProxy`;
ventilation wheels are **stopped** until `unlocked`, then spin at `0.35 + poolT*0.9` through a
first-order lag (`reduceMotion` caps the rate); the makeup skid runs an explicit state machine
(level falls with `poolTemperatureProxy`; pump A below 0.35, stops above 0.92; pump B only above
`poolT > 0.45`). Nothing loops without a cause. `LAB_COMPONENTS` + `snapshot()` are exported for
machine checking.

### LAB-003 — underground plant (`undergroundPlant.js`)

Every bullet of the spec's minimum set has a named object with upstream, downstream and a source
tag: primary `UG-P01/V01/H01/P02`; intermediate `UG-K01/K02/T01/H02/V02/X01`; tertiary interface
`UG-V02/X01` plus flow and temperature gauges whose **needle geometry** is state-driven;
purification `UG-F01/F02/F03`; sampling `UG-S01/S02`; drainage `UG-D01/D02/D03`; TRANS pneumatics
`UG-A01/A02/A03`; electrical `UG-E01/E02`; Pavia rabbit transfer `UG-R01/R02`. Flow direction is
shown by `flowBeads` — instanced spheres advancing along the real pipe centreline, emissive
intensity = flow, **stationary at zero flow**. Pit bounds `UNDERGROUND_BOUNDS`: ceiling −0.45,
floor −9.2, retaining wall ±19.5, shield clearance 5.35.

### CAM-001/002/003 — `freeCamera.js`

One rig, one state (`pivot` + `yaw` + `pitch` + `distance`); orbit, pan, zoom and fly are input paths
into it. World box `CAM_LIMITS` (±40 XZ, y −11.5…15.6) is clamped on the camera **position**, then
the pivot is re-derived in front of it — that is what lets a 14 m orbit radius still reach underwater
and the −9.2 pit floor. Near/far 0.04/320. `Home`/`F` → `goHome()`. The rig writes only
`camera.position/quaternion`, so it cannot push glass, equipment or water. CAM-003 crossing uses
`water.isUnderwater(camPos)` and swaps `scene.fog` to a blue `FogExp2` plus the clear colour; it
creates no session, does not touch `controlOwner`, and emits no audio.

### WTR-001/002/003 — `waterSystem.js`

`MeshPhysicalMaterial` `transmission 1, ior 1.333` with `WATER_ATTENUATION`/7.5 — real refraction, so
core, rods, reflector and pool floor are visible from the deck. Surface normals are central
differences of the same height field. The opaque volume cylinder that used to hide the pool interior
is deleted; depth cues are transmission attenuation above water, `FogExp2` below, and a
`REALTIME_PROXY` gradient plate at the pool floor. Caustics are a shader plane sampling the height
field as a `DataTexture`, brightness = surface Laplacian × `exp(-depth*0.16)`, 1.35× underwater.
Thermal plume drives surface roughness. `stepWave`, `addImpulse`, `heightAt`, damping, buoyancy and
pulse impulses are **unchanged** — the optics only read state.

### CHR-001/002/003 — `cherenkov.js`

Attached to `reactor.group` at the active fuel volume (`coreBounds`: `topY −1.9`, height 1.72, radius
1.15; snapshot reports `coreCenterY −2.76`, below the −0.35 surface): core volume glow, three
scattering shells (×1.75/×2.9/×4.6), `TUNED_PRESENTATION` point-sprite particles from a fixed-seed
mulberry32 PRNG killed at the nominal surface, and a soft-saturating `exposureGain()` (asymptote 1.5,
asymmetric attack/release) plus an additive bloom-proxy sprite. `NoToneMapping` unchanged. Particle
budget 900 desktop / 360 small viewport.

### CTL-001/002/003 — `controlConsole.js` + `autoConsole.js`

MANUAL desk unchanged; a physically separate AUTO bay at `[4.9, 0, 6.2]` carries exactly two
hotspots (`session.requestAuto`, `session.scram`) and no second reactor state. Both consoles' hotspots
merge into one pick list (`allHotspots`); ownership is arbitrated solely by `sessionController`. The
AUTO square button was moved off the MANUAL desk per spec §CTL-002. The browser reports **13
hotspots, all `onScreen`** — 11 MANUAL (`start`, `scram`, `pump`, `mode`, `pulseFire`,
`SHIM_up/dn`, `REG_up/dn`, `TRANS_up/dn`) + `auto`, `autoScram` tagged `console: "AUTO"`.

### GLA-001/002/003 + GLA-CTRL-001/002/003 — `physicalScene.js`, `glassArchitecture.js`

Dynamic floor bricks are real cannon boxes (mass = 1.5 × volume) created asleep at the canonical
layout and rendered as one `InstancedMesh`; a damaged brick is promoted to its own mesh with the full
crack texture, so floor and grating glass share mass, friction, durability, cracks, fracture, audio
and session reset. The floor collider is the collider of the **visible** transparent support layer
(5.6 → 31.5, top −0.32), which serves floor bricks only and does not reach the pool grating
(5.6 > 3.4). Grab is a bounded servo in `world "preStep"` (velocity target `clamp((target−pos)*9,
7 m/s)`, impulse ≤ 26 N·s at the COM): mouse sets horizontal `tx/tz`, `W/S` moves height at 2.4 m/s
clamped −10.6…11.0, `A/D` integrates yaw at 2.0 rad/s with the quaternion set from world Y only.
While grabbing, `W/S/A/D` are consumed by the glass and only `Q/E` reach the camera. `blur`,
`visibilitychange`, `pointercancel` and fracture all call `releaseGrab()`. Wall/ceiling glass is
never in `pickTargets()`.

## Verification

| Check | Result |
| --- | --- |
| `./scripts/run-validation.sh` | **PASS** (configured-check status) |
| Dependency check | PASS |
| Build | PASS — `physicalScene` chunk 753.29 kB / 202.10 kB gzip (>500 kB warning) |
| Tests `node tests/run.mjs` | **199/199** (was 195; +4 this slice) |
| Lint | **NOT CONFIGURED** |
| Type check | **NOT CONFIGURED** |
| Browser / visual | script reports **MANUAL REQUIRED**; performed via Playwright MCP, below |

### Browser origin

Bash child processes and the Playwright MCP browser do not share a network namespace, so `dist/` is
served through `page.route('**/*', …)` at the synthetic origin `http://source.local/index.html`. The
route rejects any host but `source.local`, maps the entry URL and directory URLs to `index.html`,
**aborts** on `..` or `%` in the path and on a missing file, and sets an explicit MIME type per
extension. Only four files were ever served (`/index.html`, the two JS chunks, the CSS) and
**zero requests were aborted**. Note: the MCP code sandbox exposes neither `require` nor dynamic
`import` nor `URL`, so the route uses `route.fulfill({ path })` and a regex URL parse.

### Three viewports — all clean, 0 console errors

| | 390×844 | 768×1024 | 1440×900 |
| --- | --- | --- | --- |
| canvas css / backing | 390×844 / 390×844 | 768×1024 / 768×1024 | 1440×900 / 1440×900 |
| overflow X / Y | 0 / 0 | 0 / 0 | 0 / 0 |
| visible text length | 0 | 0 | 0 |
| console + page errors | **0** | **0** | **0** |
| draw calls | 926 | 898 | 1165 |
| triangles | 430,974 | 430,262 | 451,778 |
| rigid bodies | 65 | 65 | 125 |
| awake at rest / kinds | **0 / {}** | **0 / {}** | **0 / {}** |
| floor bricks dyn / fixed | 36 / 264 | 36 / 264 | **96 / 204** |
| wall / ceiling bricks | 512 / 256 | 512 / 256 | 512 / 256 |
| glass asleep / stages | 21 / all INTACT | 21 / all INTACT | 21 / all INTACT |
| DPR | 1 | 1 | 1 |

Body count rose 63 → 65 (mobile) and 123 → 125 (desktop): the two new static colliders.

### Behaviour verified in the browser this slice

- **Session reset.** Every reload: `unlocked false`, `owner "NONE"`, `power 0`,
  `phase "INTERLOCKED_RESET"`, Cherenkov `shown 0`, particles `0`, floor `atHome 36/36` or `96/96`.
- **Real pointer drag of grating glass (GLA-CTRL-001/002/003).** `mousedown` on cube 0's projected
  centre → `grabbed: "cube"`, target `[-1.06, 0.569, -2.119]` = the cube's own position (no jump on
  grab), and `spin` cleared. Moving the mouse +220 px moved the **horizontal** target to
  `[3.224, ·, -3.491]` with the height component **unchanged at 0.569**; the body followed to
  `z −2.12 → −3.21` and stopped against the pool rim with `tilt 0.001 rad` and `spin 0.0003`.
  Holding `W` for 9 s raised the target `0.569 → 0.929` while the camera stayed **byte-identical**
  (`pos [0, 10.95, 12.69]`, `yaw 0`, `pitch −0.6981`, `dist 16.563`) — the glass really owns `W`.
  Holding `A` for 7 s moved `grabYaw 0 → 0.3` and **nothing else**: `tilt` stayed 0.000997 and
  `spin` stayed 0. On `mouseup`: `grabbed null`, `spin 0`, no angular velocity injected.
  Throughout, `tilt` never exceeded 0.031 rad (a transient at the instant of grab) — **pitch and
  roll are locked**.
- **Glass that leaves the deck now stops** — the fix above, y = −8.70, 12 s of simulated time with
  no further movement, `awakeKinds {}`.
- **Damage without spurious fracture.** The fall drove durability to 0.852 with stage still
  `INTACT` and `fragments 0`, i.e. the damage ladder is engaged but not over-triggered.
- **MANUAL first-interaction and the two controls the previous slice never clicked.** From a fresh
  session, a real click on `start` gave `owner "MANUAL"`, `mode "OPERATE"`, `scrammed false`,
  power rising `4.51e-7`. A real click on `mode` gave `mode "PULSE"` with `pulseReady true`. A real
  click on `pulseFire` produced no error and no state violation.
- **`awakeKinds` sleep audit** as described under OBS-G01.

Carried forward from the earlier slices of this round (unchanged code, still valid): continuous
operation (`powerProxy` advancing with no input), the full AUTO program to
`FULL_POWER_EQUILIBRIUM` (`power 0.9987–1.002`, `poolT 0.370`, `flow 0.656`), the historic pulse
(peak `pulsePowerProxy` **0.988**, only **7 frames above 1 %**, water `centerDeviation` −0.562
returning to 0), Cherenkov causality (shutdown 0 / low-power 0 / 250 kW `shown 0.9719` with 897–900
particles), free-camera traversal from `(0, 9.74, 11.25)` to underwater `(0, −2.99, 0.22)` to the pit
at `(0, −8.51, 0.41)` with the glass snapshot byte-identical, AUTO→MANUAL in-place takeover
preserving power/temperature/flow/rod position, MANUAL→AUTO refused at power and granted after
SCRAM, and the AUTO console driving the same single controller.

## Not verified

- **Wall/ceiling glass non-grabbability was not proven by a click.** It is guaranteed by
  construction — `pickTargets()` returns only the grating cube meshes plus the dynamic floor
  `InstancedMesh`, and the wall/ceiling instanced meshes live in `arch.group` and are never in that
  list — and the meshes are now named so a probe can identify them. But my attempt to aim the centre
  ray at a wall by orbiting only ever landed on floor glass, so I did not land the click. Recipe for
  the REVIEWER below.
- **Floor-brick drag and "underground visible through the hole".** The floor-brick path shares the
  identical servo, entry resolution and release code as the grating cube (`resolveEntry` maps the
  `InstancedMesh` `instanceId` to the same `entry` shape), and `__SOURCE_PICK__().brick(i)` /
  `nearestBrick(x,z)` now expose the coordinates needed, but I ran out of slice before performing it.
- **`pulseFire` peak from the MANUAL desk.** The click was sampled 2 s later, by which time a pulse
  has long decayed, so I cannot distinguish "fired and decayed" from "declined"; `pulseReady`
  remained `true`. The historic pulse itself is verified through the AUTO program.
- **Transparent composition by eye.** No screenshot was taken this slice. Aggregate statistics from
  the earlier slice (mean RGB (73.3, 98.7, 117.4), 100 % non-black at 1440×900) show the frame draws
  and is blue-dominant; they do not prove wall + ceiling + floor glass, water transmission, caustics
  and additive Cherenkov composite correctly. **This is the top remaining visual risk.**
- **Audio.** No audio device in this environment. Gesture-gated unlock, per-material timbres,
  rate/concurrency/peak limiting and audibility are unverified; `reduceMotion` is likewise unexercised
  in-browser.
- **Frame rate.** Measured **0.76 rAF ticks/s**, but that is SwiftShader **software** WebGL and says
  nothing about GPU performance. Draw calls, triangles, body and particle counts are meaningful; FPS
  is not.
- Underwater `FogExp2` does not affect `ShaderMaterial` layers (caustics, plume, Cherenkov) — a
  deliberate abstraction whose on-screen appearance is unchecked.
- Ground-floor equipment has **no colliders** (consistent with the pre-existing crane, ducts and
  cabinets); grabbed glass passes through it.

## Deliberate abstractions

- Buoyancy and drag apply to **fragments only**, as in the accepted baseline. Intact glass cannot
  reach the water anyway: the grating collider is a full disc of the pool radius (3.4), so the pool
  mouth is covered. Left unchanged deliberately — the task says preserve the existing buoyancy
  coupling.
- The 4.90 → 5.60 light well around the bio-shield is intentionally open, so the underground plant is
  visible from the operating floor; the new pit slab catches whatever falls in.
- Ground equipment stands on plinths through the glass floor, so bricks read as removable access
  panels.
- Makeup tank/pump setpoints are a plausible invented operating rule (`TRIGA_ANALOGUE`).
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
- `CAM-G01`, `GLA-G01` — instancing, tiering and sleep are in place and counted, but frame cost is
  still **unmeasured on real hardware** (software renderer only).
- `PERF-G01` — the `physicalScene` chunk is 753.29 kB (202.10 kB gzip); no code splitting attempted.
- `GLA-G02` *(new)* — glass that comes to rest on the new shield lid or pit slab has no dedicated
  landing sound distinct from a generic impact; the audio path is shared and unverified.
- `OBS-G01` — **CLOSED** (measurement timing under a 0.76 fps software renderer, not a sleep leak).

## Handoff focus for the next REVIEWER

1. **Judge the two new colliders against the "no invisible collision surfaces" rule.** Both back a
   rendered mesh (`shieldTopCap`; the pit slab). If you disagree that the pit slab is visible enough
   to justify a collider, say so — the alternative is that glass falls forever, which is what the
   browser actually did before this change.
2. **Land the wall/ceiling click I could not.** Recipe: `__SOURCE_NAV__.home()`, then
   `__SOURCE_NAV__.fly('w', 3)` to push the pivot toward a wall and `orbit` until
   `__SOURCE_PICK__().at(x, y).sceneHit` starts with `GLA-WALL-` or `GLA-CEILING`; then click that
   point and assert `__SOURCE_FLOOR__().grabbed === null`. The named meshes make the hit unambiguous.
3. **Perform the floor-brick drag** with `__SOURCE_PICK__().nearestBrick(x, z)`, move a brick clear,
   and confirm the underground plant is visible through the hole (`at()` through the gap should
   report an underground object, not the support plate).
4. **Judge transparent composition by eye** — screenshots at the three viewports. The one risk
   aggregate pixel statistics cannot settle.
5. Verify the ground-floor **heat-exchanger → makeup-skid substitution** against the locked
   two-heat-exchanger rule in `REACTOR_POOL_SYSTEM.md` before reading it as scope drift.
6. Fire a **manual pulse** from the MANUAL desk with millisecond sampling (`mode` → `pulseFire`,
   then poll `pulsePowerProxy` every frame) to close the one console gap listed above.
