# Agent Implementation Report

IMPLEMENTATION_STATUS: COMPLETE_WITH_BROWSER_EVIDENCE

- Task: `source-lab-optics-free-camera-2026-07-28`
- Implementation round: 1 of 2
- Base commit this slice: `228ebfdf835e92d32a3562a4c8a529443ef8eb17`
- Round review base commit: `3a91731f7f2fd4ec76624ca4536bc3cb599cdaac`
- Implementer runtime: claude / opus / max
- Latest verdict handled: `NOT_REVIEWED` (no Blocker/Major existed to address)

The REVIEWER reviews the whole range from `3a91731`. Diff over that range in `src/` and `tests/`:
**17 files, ≈ +3200 / −254**. Control-plane script changes inside the same range are not mine.

## What the last two slices of this round changed

The `LAB-*`, `CAM-*`, `WTR-*`, `CHR-*`, `CTL-*`, `GLA-*` and `GLA-CTRL-*` code was built earlier in
this same round and is summarised below. These two slices fixed one real defect and added two
verification-visibility surfaces:

| Change | File | Why |
| --- | --- | --- |
| `homeFitDistance()` — canonical home distance now capped by hall clearance | `freeCamera.js`, `physicalScene.js` | **Real defect.** The pure geometric fit distance blows up on tall-narrow viewports (`radiusH / sin(halfH)`): 1440×900 → 16.56, 768×1024 → 18.78, 390×844 → **29.44**. At a 40° elevation that put the initial camera at y = 12.37 (**above** the 12.0 glass ceiling) and at y = 19.2 → clamped to 15.6, z = 22.55 (**outside** the 22 m glass wall). The opening frame on phone and tablet was two face-hugging refracting bricks with no pool in it. Now capped by `(ceilingY−0.8−targetY)/sin(elev)` and `(hallHalf−1.5)/cos(elev)`. Desktop framing is unchanged by construction (16.563 < the cap). |
| `status()` on both audio graphs + `window.__SOURCE_AUDIO__` | `glassAudio.js`, `reactorAudio.js`, `physicalScene.js` | Audibility needs a sound card; *gesture gating* does not. The hook reports `{unlocked, state, sampleRate, voices, maxVoices, minInterval, fired{impact,crack,fracture}}`. Read-only; the `fired` counters increment only after the pre-existing guards pass. |
| `UG-PLANT` / `UG-PLANT-MESH` names, `at().stack` carries hit distance | `undergroundPlant.js`, `physicalScene.js` | Lets a ray probe say *what* it hit and *how far*, so "the plant is visible through the vacated floor slot" is distinguishable from "something else is". |

## Requirement coverage

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
live underground as `UG-H01`/`UG-H02` and the sourceless third unit was replaced by the makeup skid.
A test asserts exactly two exist and both are underground. Judge this against the locked
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

The pre-existing wall monitor bank is **unchanged this round** and is state-driven:
`cMonIdle → cRed` while `scrammed`, `cMonIdle → cMonPow` with power, `→ cMonHot` during a pulse.
Both ends were seen in the browser this slice (crimson at reset, cyan at power 1.0). See the
aesthetic note under *Remaining risks*.

### LAB-003 — underground plant (`undergroundPlant.js`)

Every bullet of the spec's minimum set has a named object with upstream, downstream and a source
tag: primary `UG-P01/V01/H01/P02`; intermediate `UG-K01/K02/T01/H02/V02/X01`; tertiary interface
`UG-V02/X01` plus flow and temperature gauges whose **needle geometry** is state-driven;
purification `UG-F01/F02/F03`; sampling `UG-S01/S02`; drainage `UG-D01/D02/D03`; TRANS pneumatics
`UG-A01/A02/A03`; electrical `UG-E01/E02`; Pavia rabbit transfer `UG-R01/R02`. Flow direction is
shown by `flowBeads` — instanced spheres advancing along the real pipe centreline, emissive
intensity = flow, **stationary at zero flow**. Pit bounds `UNDERGROUND_BOUNDS`: ceiling −0.45,
floor −9.2, retaining wall ±19.5, shield clearance 5.35. Group `UG-PLANT`, anonymous meshes
`UG-PLANT-MESH`.

### CAM-001/002/003 — `freeCamera.js`

One rig, one state (`pivot` + `yaw` + `pitch` + `distance`); orbit, pan, zoom and fly are input paths
into it. World box `CAM_LIMITS` (±40 XZ, y −11.5…15.6) is clamped on the camera **position**, then
the pivot is re-derived in front of it — that is what lets a 14 m orbit radius still reach underwater
and the −9.2 pit floor. Near/far 0.04/320. `Home`/`F` → `goHome()`. The rig writes only
`camera.position/quaternion`, so it cannot push glass, equipment or water. CAM-003 crossing uses
`water.isUnderwater(camPos)` and swaps `scene.fog` to a blue `FogExp2` plus the clear colour; it
creates no session, does not touch `controlOwner`, and emits no audio. `homeFitDistance()` is the
only new limit and applies **only to the canonical home framing**, never to where the user may fly.

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
budget 900 desktop / **360 small viewport** (re-confirmed in-browser at 768×1024 and 390×844).

### CTL-001/002/003 — `controlConsole.js` + `autoConsole.js`

MANUAL desk unchanged; a physically separate AUTO bay at `[4.9, 0, 6.2]` carries exactly two
hotspots (`session.requestAuto`, `session.scram`) and no second reactor state. Both consoles'
hotspots merge into one pick list (`allHotspots`); ownership is arbitrated solely by
`sessionController`. The AUTO square button was moved off the MANUAL desk per spec §CTL-002.
**13 hotspots, all `onScreen` at 1440×900** — 11 MANUAL (`start`, `scram`, `pump`, `mode`,
`pulseFire`, `SHIM_up/dn`, `REG_up/dn`, `TRANS_up/dn`) + `auto`, `autoScram` tagged `console: "AUTO"`.
At 768×1024 and 390×844, **11 of 13** are on screen: the AUTO bay falls outside the narrow frame at
the canonical home distance. It is reachable by orbiting/zooming, not lost (see `CAM-G02`).

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
never in `pickTargets()`. Static colliders `shieldCap` (16 trapezoidal segments) and `pitFloor`
(one box at `UNDERGROUND_BOUNDS.floorY`) each back a **rendered** mesh; before they existed, glass
lifted over the railing fell through visible concrete forever.

## Verification

| Check | Result |
| --- | --- |
| `./scripts/run-validation.sh` | **PASS** (configured-check status) |
| Dependency check | PASS |
| Build | PASS — `physicalScene` chunk 755.18 kB / 202.82 kB gzip (>500 kB warning) |
| Tests `node tests/run.mjs` | **230/230** (was 199; +16 CAM-002 home framing, +15 audio gating) |
| Lint | **NOT CONFIGURED** |
| Type check | **NOT CONFIGURED** |
| Browser / visual | script reports **MANUAL REQUIRED**; performed via Playwright MCP, below |

No check failed in this slice.

### Browser origin

`dist/` is served through `page.route('**/*', …)` at the synthetic origin
`http://source.local/index.html`. The route rejects any host but `source.local`, maps the entry URL
and directory URLs to `index.html`, **aborts** on `..` or `%` in the path, on escape from `dist/`, and
on a missing file, and sets an explicit MIME type per extension. Exactly four files were served
(`/index.html`, two JS chunks, the CSS) and **zero requests were aborted**.

### Three viewports — 0 console errors, 0 page errors at each

| | 390×844 | 768×1024 | 1440×900 |
| --- | --- | --- | --- |
| canvas css / backing | 390×844 / 390×844 | 768×1024 / 768×1024 | 1440×900 / 1440×900 |
| overflow X / Y | 0 / 0 | 0 / 0 | 0 / 0 |
| visible text length | 0 | 0 | 0 |
| console + page errors | **0** | **0** | **0** |
| home distance (was) | **16.957** (29.44) | **16.957** (18.78) | 16.563 (16.563) |
| home camera position | `[0, 11.20, 12.99]` | `[0, 11.20, 12.99]` | `[0, 10.95, 12.69]` |
| inside glass hall? | yes (ceiling 12.0, wall 22) | yes | yes |
| screen-centre ray at home | `cube` @13.33 m, grabbable | `cube` @13.33 m, grabbable | pool/deck |
| draw calls | 636 | 822 | 1165 |
| triangles | 412,750 | 425,958 | 451,778 |
| rigid bodies | 65 | 65 | 125 |
| awake at load / kinds | 22 / `{grating:1, cube:21}` | 22 / same | 22 / same |
| awake after settling | **0 / {}** | **0 / {}** | **0 / {}** |
| floor bricks dyn / fixed | 36 / 264 | 36 / 264 | 96 / 204 |
| wall / ceiling bricks | 512 / 256 | 512 / 256 | 512 / 256 |
| particle budget | 360 | 360 | 900 |
| hotspots on screen | 11 / 13 | 11 / 13 | 13 / 13 |
| glass stages | `{INTACT: 21}` | `{INTACT: 21}` | `{INTACT: 21}` |
| DPR | 1 | 1 | 1 |

Console warnings are 4 per load and are Chromium/SwiftShader WebGL notices, not page errors.

### Behaviour verified in the browser this slice

- **Session reset** at every viewport on every reload: `unlocked false`, `owner "NONE"`, `power 0`,
  `mode "SHUTDOWN"`, `scrammed true`, `phase "INTERLOCKED_RESET"`, Cherenkov `shown 0` / particles 0,
  floor `atHome 96/96` (or 36/36) all asleep, `damaged 0`, `maxTilt 0`, glass `{INTACT: 21}`,
  `minDurability 1`, and **no AudioContext at all**.
- **CAM-002 home framing at narrow viewports — the fix this slice.** 768×1024 and 390×844 both now
  report `dist 16.957`, camera `[0, 11.20, 12.99]`: **0.8 m below the glass ceiling and 9 m inside
  the glass wall**. The screen-centre ray at home hits a **grabbable grating `cube` at 13.33 m**, so
  the pool is in the middle of the opening frame. I read both frames by eye
  (`.agent/artifacts/browser/r1b-768x1024.png`, `r1b-390x844.png`): the bio-shield deck with hazard
  stripes, the pool with grating and the pale core grid plate read through the water, the
  bridge/hoist, the MANUAL desk in the foreground and the wall/ceiling glass are all legible and
  correctly composed. This was the previous slice's largest unexamined visual risk; it was a **real
  defect** and it is closed.
- **Audio activation, gesture-gated (measured, not assumed).** Before any interaction:
  `glass.state "NONE"`, `reactor.state "NONE"`, `unlocked false`, zero audio nodes built. One real
  `mouse.down/up` at (720, 60) — a point the pick probe first showed is `grabbable false`, so it is a
  scene interaction and not a console click — flipped both graphs to
  `unlocked true, state "running", sampleRate 44100`. The same click took `owner "NONE" → "AUTO"`,
  `unlocked true`, `phase "LOW_POWER_APPROACH"`, `mode "OPERATE"`, and grabbed no glass.
- **Sound is driven by physics events, not a loop.** `fired` stayed `{impact:0, crack:0, fracture:0}`
  through load and through the activating click; it reached `{impact:3, crack:0, fracture:0}` only
  after the AUTO pulse threw the grating cubes (`peaks.cubeSpeed 3.63 m/s`). No crack or fracture
  voice fired because no glass was damaged.
- **Continuous operation with no further input.** After that single click the AUTO program ran
  unattended through `LOW_POWER_APPROACH → POST_PULSE_HEAT_TRANSFER → STEADY_POWER_ASCENT →
  FULL_POWER_EQUILIBRIUM`, settling at `power 0.9969 → 1.0015`, `poolT 0.159 → 0.341`,
  `flow 0.601 → 0.655`, rods `SHIM 0.789 / REG 0.698 / TRANS 0`.
- **Historic pulse and water response.** The internal sub-step peak tracker recorded
  `peaks.pulsePower 0.9882`; the water centre dropped to **−1.2645 m** and returned to
  `centerDeviation 0 / maxDeviation 0`, with `state.pulse null` and fuel temperature bumped to 0.12.
  Sampling the same transient at 0.25 s granularity only caught 0.0432 — **the pulse is narrower than
  a quarter second**, which is the frame-rate-independence design working, and is why the in-code
  peak tracker rather than a sampler is the honest instrument here.
- **Cherenkov causality.** `shown 0` at shutdown and at `power 0.0056`; `0.9612` at `power 0.5757`;
  `0.9719` with **899–900 particles** at full power; `exposure 0.9719`, bounded below the 1.5
  asymptote. Particle budget drops to 360 at both small viewports.
- **CAM-002/CAM-003 free traversal across the water surface.** From the canonical home framing at
  `[0, 10.95, 12.69]`: `orbit` → pitch −1.5359, then repeated `fly('w')` crossed the surface at
  `[0, −0.64, 0.01]` with `underwater true`, continued to `[0, −7.14, −0.22]`, then out to the pit
  interior at `[0, −7.17, 19.78]`, where the screen-centre ray reads
  `UG-PLANT-MESH@22.76 | UG-PLANT-MESH@22.85 | UG-PLANT-MESH@23.14 | UG-PLANT-MESH@39.28` — four
  underground equipment hits, from below the floor, with the camera outside the pool. Throughout,
  `floor.atHome 96/96`, `damaged 0`, glass `{INTACT: 21}`, `owner "AUTO"` and power were undisturbed:
  the camera moves nothing.
- **Full-power frame read by eye** (`r1b-1440-fullpower.png`): the five wall monitors are cyan
  (power-driven — the same objects that were crimson at `scrammed`), the beacon is lit amber, the
  AUTO console bay is visible to the right of the MANUAL desk, and the ground equipment (makeup tank,
  pumps, sampling cabinet, vent drums, pipe runs, railing, ladder) is legible.

Carried forward from earlier slices of this round (**code unchanged since**, so still valid): the
full MANUAL desk pulse through real hotspot clicks (peak `pulsePowerProxy` 0.5013 at t = 0.133 s,
13 frames above 1 %, fully decayed in 15 s); the deep-subcritical firing that correctly produced no
spike because `rhoInsert ≤ 1 $`; wall glass `GLA-WALL-2` and ceiling glass `GLA-CEILING` hit by name
and proven `grabbable false` under a **real** `mouse.down()`; the complete real pointer drag of floor
brick 0 (grab with no jump; `W` held → target `−0.19 → 0.41` with the camera byte-identical;
mouse +300 px → horizontal target moved with the **height unchanged**; `A` held → `grabYaw 0 → 0.4`
with position unchanged, `tilt 0`, `spin 0`; release → `spin 0`, settles asleep with `tilt 5e-6`);
the negative control where the same keys moved the camera because nothing was grabbed; the
underground plant appearing in the ray stack through a vacated floor slot
(`… | GLA-FLOOR-SUPPORT@29.15 | GLA-FLOOR-SUPPORT@29.33 | UG-PLANT-MESH@35.82`); AUTO→MANUAL
in-place takeover preserving power/temperature/flow/rod position; MANUAL→AUTO refused at power and
granted after SCRAM; a real grating-cube drag with identical constraint results; and glass that
leaves the deck coming to rest on the pit slab at y = −8.70 with honest fall damage (durability
0.852, stage still `INTACT`).

## Not verified

- **Audio audibility.** No audio device. Gesture-gated unlock, context state, sample rate, per-event
  firing, the 8-voice cap and the 22 ms throttle are now measured (browser + 15 logic checks against
  a stubbed `AudioContext`); **timbre, mix balance and whether it sounds like glass are unverified.**
- **Frame rate.** SwiftShader **software** WebGL at ≈0.76 rAF ticks/s. Draw calls, triangles, body,
  brick and particle counts are meaningful; FPS is not, and no GPU measurement exists.
- **Glass fracture past `INTACT` by real interaction — still open, and I now know why.** The grab
  lift/yaw integrator lives in `frame()` and consumes real rAF `dt` (`physicalScene.js:1102–1108`),
  while `__SOURCE_ADVANCE__` only drives `simulate()`. At 0.76 fps, raising a brick to the 11.0 m
  clamp would need roughly five minutes of wall-clock key-holding. The AUTO pulse threw cubes at
  `peaks.cubeSpeed 3.63 m/s` without breaking any (`minDurability 1.0`). The damage ladder is covered
  by the logic suite and by the earlier fall-damage measurement (0.852), not by an in-browser
  fracture this round.
- **Cherenkov judged numerically, not photographically.** In the 1440×900 full-power frame the core
  region reads bright and pale through the grating at a 16.5 m stand-off rather than saturated blue —
  additive stacking of the blue layers clips R and G over an already lit core. I attempted a close
  underwater frame and mis-aimed twice: `r1b-underwater-downlook.png` is a near-featureless blue
  field (camera at y −7.14 looking straight **down** at the pool floor through `FogExp2`), and
  `r1b-pit-interior.png` shows the pit, not the core. I stopped rather than keep iterating on camera
  placement. **No frame in this round shows the Cherenkov volume from beside the core.**
- **`reduceMotion`** is unexercised in-browser.
- **Underwater `FogExp2` does not affect `ShaderMaterial` layers** (caustics, plume, Cherenkov) — a
  deliberate abstraction whose on-screen appearance is unchecked.
- **Ground-floor equipment has no colliders** (consistent with the pre-existing crane, ducts and
  cabinets); grabbed glass passes through it.

## Deliberate abstractions

- Buoyancy and drag apply to **fragments only**, as in the accepted baseline. Intact glass cannot
  reach the water anyway: the grating collider is a full disc of the pool radius (3.4). Left
  unchanged deliberately — the task says preserve the existing coupling.
- The 4.90 → 5.60 light well around the bio-shield is intentionally open, so the underground plant is
  visible from the operating floor; the pit slab catches whatever falls in.
- Ground equipment stands on plinths through the glass floor, so bricks read as removable access
  panels.
- Makeup tank/pump setpoints are a plausible invented operating rule (`TRIGA_ANALOGUE`).
- Cherenkov particles are a `TUNED_PRESENTATION` light-transport proxy, not per-particle physics.
- The transparent floor support layer, the glass-brick building and the free traversing camera are
  `SOURCE_ART_DIRECTION`, not Pavia building facts.
- Per-unit underground coordinates are `REALTIME_PROXY`; no Pavia as-built drawings are public.
- `UG-PLANT-MESH` and `__SOURCE_AUDIO__` are verification-visibility surfaces only; they carry no
  engineering meaning and no page-visible effect.
- The home-distance cap trades horizontal framing for staying indoors: at 390×844 the visible
  half-width at home is 3.65 m, so the AUTO bay and the outer hall are cropped until the user zooms
  out. Deliberate — starting outside the building was strictly worse.

## Open gaps

- `LAB-G01` — underground per-unit coordinates remain `REALTIME_PROXY`.
- `LAB-G02` — ground-floor equipment carries no collision geometry.
- `LAB-G03` — makeup/ventilation setpoints are invented operating rules, not sourced.
- `WTR-G01` — no volumetric light transport; absorption is transmission thickness above water and
  `FogExp2` below, caustics are a curvature proxy.
- `WTR-G02` — **new.** Looking straight down from 7 m depth, the frame is a nearly featureless blue
  field; the `FogExp2` density hides the pool floor at that range. Physically defensible, visually
  empty. Not tuned this round.
- `CHR-G01` — the `TUNED_PRESENTATION` particle system.
- `CHR-G02` — **new.** Additive layer stacking desaturates the core toward white at full power in the
  distant deck view. Needs a photographic judgement from beside the core before any tuning; see
  handoff item 1.
- `CAM-G01`, `GLA-G01` — instancing, tiering and sleep are in place and counted, but frame cost is
  still **unmeasured on real hardware** (software renderer only).
- `CAM-G02` — **new.** At 768×1024 and 390×844 the canonical home framing crops the AUTO console bay
  (11 of 13 hotspots on screen). It is reachable, not lost, but a first-time phone visitor does not
  see the second console without moving the camera.
- `PERF-G01` — the `physicalScene` chunk is 755.18 kB (202.82 kB gzip); no code splitting attempted.
- `GLA-G02` — glass resting on the shield lid or pit slab has no landing sound distinct from a
  generic impact.
- `GLA-G05` — **new.** In-browser fracture is blocked by the 0.76 fps software renderer, not by code
  (reason measured above). Needs a GPU browser or a test-only lift hook.
- `OBS-G01`, `CTL-G01`, `GLA-G03`, `GLA-G04` — **CLOSED** in earlier slices of this round; each was
  re-confirmed here (0 awake bodies after settling at all three viewports; MANUAL pulse peak
  measured; wall/ceiling glass proven non-grabbable by real clicks; plant visible through a vacated
  floor slot).

## Remaining risks

1. **The crimson monitor bank at reset.** Five wall monitors are the most saturated thing in the
   opening frame at every viewport, and the page's locked core colour is blue. This is
   **pre-existing accepted phase-I behaviour** — `git diff 3a91731..HEAD -- labEnvironment.js` shows
   no change to the `cMonIdle`/`cRed` monitor logic — and it is causally correct (`scrammed → red`,
   going cyan as power rises, which I confirmed in-browser). I did **not** change it, because that
   would alter accepted lab appearance outside this task's approved scope. It needs an owner or
   REVIEWER call.
2. **Cherenkov photographic quality** — see `CHR-G02`. Numerically correct, visually unproven
   close-up, and it is the owner's stated visual centrepiece.
3. **Real-hardware cost** — everything about the frame budget is inferred from counts, not measured.

## Handoff focus for the next REVIEWER

1. **Get one frame from beside the core underwater and judge the blue.** This is the owner's locked
   visual centrepiece and the only requirement I could not photograph. `__SOURCE_NAV__` has no
   absolute placement, so drive it as: `__SOURCE_NAV__.home()` → `orbit(0, 140)` (pitch ≈ −1.54) →
   `fly('w', 0.5)` repeatedly until `__SOURCE_CAM__().underwater` → `orbit(0, −256)` (pitch → 0) →
   `fly('s', …)` **in small steps**, checking `pos[1] ≈ −2.8` and `|pos[2]| ≈ 4` before shooting.
   My two attempts overshot; the numbers above are the corrected recipe.
2. **Rule on the crimson monitor bank** (risk 1). If it should be blue at reset, that is a small,
   local change to the `scrammed` branch of `monitors.forEach` in `labEnvironment.js` — but it
   touches accepted phase-I appearance and I would not make it unasked.
3. **Judge the home-distance cap.** `homeFitDistance()` deliberately crops the AUTO bay on a phone to
   keep the camera indoors (`CAM-G02`). If you would rather see the whole hall and accept starting
   outside the glass wall, say so — at aspect 0.46 the two goals are not simultaneously satisfiable.
4. **Judge the two static colliders** — `shieldCap` and `pitFloor` each back a rendered mesh. If you
   disagree that the pit slab is visible enough to justify a collider, the alternative is glass
   falling forever, which is what the browser actually did before they existed.
5. **Verify the ground-floor heat-exchanger → makeup-skid substitution** against the locked
   two-heat-exchanger rule in `REACTOR_POOL_SYSTEM.md` before reading it as scope drift.
6. **Fracture and frame rate need a GPU browser.** With one, `__SOURCE_PERF__()` plus a rAF counter
   closes `CAM-G01`/`GLA-G01`, and a real `W`-hold to the 11.0 m clamp followed by release closes
   `GLA-G05` (and should light `__SOURCE_AUDIO__().glass.fired.crack` / `.fracture`).

Evidence frames preserved in `.agent/artifacts/browser/` (ignored path): `r1b-390x844.png`,
`r1b-768x1024.png`, `r1b-1440-fullpower.png`, `r1b-underwater-downlook.png`, `r1b-pit-interior.png`.

## Automation wrapper result

- Process base commit: `228ebfdf835e92d32a3562a4c8a529443ef8eb17`
- Round review base commit: `3a91731f7f2fd4ec76624ca4536bc3cb599cdaac`
- Implementer runtime: `claude / opus / max`
- Agent process: PASS (exit 0)
- Unified validation: PASS (exit 0)
- Checkpoint: created by `scripts/run-implementation.sh` after this report
