# Agent Implementation Report

IMPLEMENTATION_STATUS: COMPLETE_WITH_BROWSER_EVIDENCE

- Task: `source-lab-optics-free-camera-2026-07-28`
- Implementation round: 1 of 2
- Base commit: `64ae32a2b14c3c7d203d01b91189357a90ae5dca`
- Round review base commit: `3a91731f7f2fd4ec76624ca4536bc3cb599cdaac`
- Implementer runtime: claude / opus / max
- Latest verdict handled: `NOT_REVIEWED` (no Blocker/Major existed to address)

## What this slice did

The code for `LAB-*`, `CAM-*`, `WTR-*`, `CHR-*`, `CTL-*`, `GLA-*` and `GLA-CTRL-*` was built in the
earlier slices of **this same round** and is summarised below because the REVIEWER reviews the whole
range from `3a91731`. This slice closed the four verification holes the previous slice left open, and
made two small changes needed to close them honestly:

| Change | File | Why |
| --- | --- | --- |
| `group.name = "UG-PLANT"`; unnamed underground meshes named `UG-PLANT-MESH` | `undergroundPlant.js` | Underground geometry was anonymous, so `at()` reported `"Mesh"` and "the plant is visible through the hole" could not be told apart from "something else is visible". Same technique `glassArchitecture.js` already uses for fixed glass. No geometry/material/state change. |
| `at().stack` entries now carry hit distance (`name@dist`), 4 deep instead of 3 | `physicalScene.js` | Makes ray depth through a removed floor brick measurable rather than inferred. |

Both are read-only acceptance visibility. Diff vs the round review base: **15 files, ≈ +3060 / −252**.

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

### LAB-003 — underground plant (`undergroundPlant.js`)

Every bullet of the spec's minimum set has a named object with upstream, downstream and a source
tag: primary `UG-P01/V01/H01/P02`; intermediate `UG-K01/K02/T01/H02/V02/X01`; tertiary interface
`UG-V02/X01` plus flow and temperature gauges whose **needle geometry** is state-driven;
purification `UG-F01/F02/F03`; sampling `UG-S01/S02`; drainage `UG-D01/D02/D03`; TRANS pneumatics
`UG-A01/A02/A03`; electrical `UG-E01/E02`; Pavia rabbit transfer `UG-R01/R02`. Flow direction is
shown by `flowBeads` — instanced spheres advancing along the real pipe centreline, emissive
intensity = flow, **stationary at zero flow**. Pit bounds `UNDERGROUND_BOUNDS`: ceiling −0.45,
floor −9.2, retaining wall ±19.5, shield clearance 5.35. The whole group is now `UG-PLANT` and its
anonymous meshes are `UG-PLANT-MESH`, so a ray probe can name what it hit.

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
budget 900 desktop / **360 small viewport** (confirmed in-browser at both 768×1024 and 390×844).

### CTL-001/002/003 — `controlConsole.js` + `autoConsole.js`

MANUAL desk unchanged; a physically separate AUTO bay at `[4.9, 0, 6.2]` carries exactly two
hotspots (`session.requestAuto`, `session.scram`) and no second reactor state. Both consoles'
hotspots merge into one pick list (`allHotspots`); ownership is arbitrated solely by
`sessionController`. The AUTO square button was moved off the MANUAL desk per spec §CTL-002. The
browser reports **13 hotspots, all `onScreen`** — 11 MANUAL (`start`, `scram`, `pump`, `mode`,
`pulseFire`, `SHIM_up/dn`, `REG_up/dn`, `TRANS_up/dn`) + `auto`, `autoScram` tagged `console: "AUTO"`.

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

Two static colliders added in the previous slice remain: `shieldCap` (16 trapezoidal segments,
`deck.outerRadius → shield.outerRadius`, top at `shield.topY`) and `pitFloor` (one box at
`UNDERGROUND_BOUNDS.floorY` spanning the ±19.5 m retaining walls). Both back a mesh that is drawn —
before them, glass lifted over the railing fell through visible concrete forever. Four tests pin the
drop path (lid inner radius = walkway outer radius; lid above walkway; lid outer radius inside
`supportInnerR`, so the light well stays open; pit slab below the pool floor and past `supportInnerR`).

## Verification

| Check | Result |
| --- | --- |
| `./scripts/run-validation.sh` | **PASS** (configured-check status) |
| Dependency check | PASS |
| Build | PASS — `physicalScene` chunk 754.44 kB / 202.49 kB gzip (>500 kB warning) |
| Tests `node tests/run.mjs` | **199/199** |
| Lint | **NOT CONFIGURED** |
| Type check | **NOT CONFIGURED** |
| Browser / visual | script reports **MANUAL REQUIRED**; performed via Playwright MCP, below |

### Browser origin

`dist/` is served through `page.route('**/*', …)` at the synthetic origin
`http://source.local/index.html`. The route rejects any host but `source.local`, maps the entry URL
and directory URLs to `index.html`, **aborts** on `..` or `%` in the path and on a missing file, and
sets an explicit MIME type per extension. Only four files were ever served (`/index.html`, the two JS
chunks, the CSS) and **zero requests were aborted**. The MCP code sandbox exposes neither `require`
nor dynamic `import` nor `URL` nor `global`, so the route uses `route.fulfill({ path })`, a regex URL
parse and `page.__*` properties.

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
| awake at load / kinds | 22 / `{grating:1, cube:21}` | 22 / same | 22 / same |
| awake after `ADVANCE(5)` | **0 / {}** | **0 / {}** | **0 / {}** |
| floor bricks dyn / fixed | 36 / 264 | 36 / 264 | **96 / 204** |
| wall / ceiling bricks | 512 / 256 | 512 / 256 | 512 / 256 |
| particle budget | 360 | 360 | 900 |
| glass asleep / stages | 21 / all INTACT | 21 / all INTACT | 21 / all INTACT |
| DPR | 1 | 1 | 1 |

Console warnings are 4 per load and are Chromium/SwiftShader WebGL notices, not page errors.

### Behaviour verified in the browser this slice

- **Session reset** — every reload at every viewport: `unlocked false`, `owner "NONE"`, `power 0`,
  `phase "INTERLOCKED_RESET"`, Cherenkov `shown 0`, particles `0`, floor `atHome 36/36` or `96/96`,
  all bricks and cubes asleep, `stages {INTACT: 21}`.
- **Clear water, reactor visible from above (WTR-001, owner-locked).** Camera at pitch −1.298,
  distance 7.15 over the pool: the screenshot
  (`.agent/artifacts/browser/r1-pool-top.png`) shows the **core grid plate with its fuel-element hole
  pattern** read through the water surface, through the grating bars, behind transparent glass cubes.
  No opaque volume hides the pool.
- **Wall glass is not grabbable (GLA-001).** Camera inside the hall at y 6.84 looking horizontally, a
  screen scan found `sceneHit "GLA-WALL-2"` at distance 38.97 m with `grabbable false`. A real
  `mouse.down()` on that exact point → `__SOURCE_FLOOR__().grabbed === null`. This is the click the
  previous slice could not land: the hit is *named*, so "not grabbable" is distinguished from
  "missed".
- **Ceiling glass is not grabbable (GLA-001).** Same method, `sceneHit "GLA-CEILING"` at 6.88 m,
  `grabbable false`, real mousedown → `grabbed null`.
- **Real pointer drag of a floor brick (GLA-CTRL-001/002/003)** — brick 0 at `[-6, -0.19, -13.2]`:
  - grab: `grabbed "floor"`, `grabTarget [-6, -0.19, -13.203]` = the brick's own position, **no jump**;
  - `W` held 11 s: target height `-0.19 → 0.41`, body `-0.204 → 0.373`, and the camera stayed
    **byte-identical** (`pos [0,10.95,12.69]`, `yaw 0`, `pitch −0.6981`, `dist 16.563`) — the glass
    really owns `W`;
  - mouse +300 px: horizontal target `[-6,·,-13.203] → [2.139,·,-9.989]` with the **height component
    unchanged at 0.41**; the body tracked it exactly;
  - `A` held 7 s: `grabYaw 0 → 0.4` and body `yaw 0 → 0.4`, with **position unchanged, `tilt` 0 and
    `spin` 0** — pitch and roll are locked, no random rotation;
  - release: `grabbed null`, `spin 0` (no angular velocity injected), body falls at 0.997 m/s and
    settles at `y 0.0699` — exactly the top of the neighbouring brick — with `tilt 5e-6`, `spin 0`,
    `speed 0`, `asleep`. `atHome 95/96`, `damaged 0`, grating cubes still `{INTACT: 21}`.
- **Underground plant visible through the vacated slot (GLA-002 / LAB-003).** Before the drag the ray
  through that brick's centre read
  `Mesh@24.50 | Mesh@28.48 | GLA-FLOOR-SUPPORT@29.15 | GLA-FLOOR-SUPPORT@29.33`. After the brick was
  moved away the same ray reads
  `Mesh@24.50 | GLA-FLOOR-SUPPORT@29.15 | GLA-FLOOR-SUPPORT@29.33 | **UG-PLANT-MESH@35.82**` —
  the brick occluder is gone and the ray terminates on underground equipment. Re-checked from
  directly above the slot (camera `[-5.96, 4.28, -11.62]`, pitch −1.202): screen-centre stack is
  `GLA-FLOOR-SUPPORT@4.93 | GLA-FLOOR-SUPPORT@5.00 | UG-PLANT-MESH@14.45` — only the two faces of the
  transparent support plate stand between the open slot and the plant.
- **MANUAL desk pulse, peak captured (CTL-002).** The previous slice could not distinguish "fired and
  decayed" from "declined". Full sequence from a fresh session, all through real hotspot clicks:
  `start` (609,711) → `owner "MANUAL"`, `mode "OPERATE"`; hold `SHIM_up` (630,741) for 150 s of
  simulated time → `SHIM 1.0`, `power 2.568e-6`; `mode` (779,702) → `"PULSE"`, `pulseReady true`;
  `pulseFire` (834,711) → **peak `pulsePowerProxy` 0.5013 at t = 0.133 s, 13 frames above 1 %**,
  fully decayed inside 15 s (`state.pulse` null), fuel temperature bumped to 0.155, water disturbed
  and returned to `maxDeviation 0.00206`. The peak is 0.50 rather than the AUTO program's 0.988
  because only SHIM was withdrawn, so the ejected-TRANS insertion is a smaller super-prompt-critical
  step — causally consistent, not a defect.
- **First firing attempt from deep subcritical returned zero peak, and that is correct.** Firing at
  `power 3.765e-7` with rods in gave `pulsePowerProxy` 0 for the whole transient. `cmdPulseFire`
  computes `rhoInsert = rodNow + ROD_WORTH.TRANS − ROD_BIAS − ALPHA_FB·T_fuel` and only produces a
  spike when `rhoInsert > 1 $`; the in-code comment states this requirement explicitly. Recorded here
  because it looks like a bug until you check the interlock.
- **W/S/A/D belong to the camera when nothing is grabbed (GLA-CTRL-003, negative control).** A
  mousedown aimed at a brick whose projection fell below the viewport did not grab; the subsequent
  `W` and `A` holds moved the camera pivot (`[0,0.3,0] → [-1.3,-0.74,-1.24]`) and left every brick at
  home. Input ownership flips on grab state, not on key identity.

Carried forward from the earlier slices of this round (unchanged code, still valid): continuous
operation (`powerProxy` advancing with no input), the full AUTO program to `FULL_POWER_EQUILIBRIUM`
(`power 0.9987–1.002`, `poolT 0.370`, `flow 0.656`), the historic pulse (peak `pulsePowerProxy`
**0.988**, only **7 frames above 1 %**, water `centerDeviation` −0.562 returning to 0), Cherenkov
causality (shutdown 0 / low-power 0 / 250 kW `shown 0.9719` with 897–900 particles), free-camera
traversal from `(0, 9.74, 11.25)` to underwater `(0, −2.99, 0.22)` to the pit at `(0, −8.51, 0.41)`
with the glass snapshot byte-identical, AUTO→MANUAL in-place takeover preserving power/temperature/
flow/rod position, MANUAL→AUTO refused at power and granted after SCRAM, the AUTO console driving the
same single controller, a real grating-cube drag with identical constraint results, and glass that
leaves the deck coming to rest on the pit slab at y = −8.70 with honest fall damage (durability
0.852, stage still `INTACT`, `fragments 0`).

## Not verified

- **Audio.** No audio device in this environment. Gesture-gated unlock, per-material timbres,
  rate/concurrency/peak limiting and audibility are unverified. `reduceMotion` is likewise
  unexercised in-browser.
- **Frame rate.** The renderer is SwiftShader **software** WebGL at ≈0.76 rAF ticks/s. Draw calls,
  triangles, body, brick and particle counts are meaningful; FPS is not, and no GPU measurement
  exists.
- **Glass fracture in this slice.** No brick or cube was driven to `stage != INTACT` here; the damage
  ladder is exercised only by the carried-forward fall-damage result (durability 0.852) and by the
  199 logic checks.
- **The floor-hole screenshot is framed too close.** `r1-floor-hole.png` shows the empty brick slot
  and the darker opening, but the camera ended at 4.4 m distance, so it is not a compelling picture
  of the plant below. The claim rests on the ray stacks above, which are unambiguous.
- **Underwater `FogExp2` does not affect `ShaderMaterial` layers** (caustics, plume, Cherenkov) — a
  deliberate abstraction whose on-screen appearance is unchecked.
- **Ground-floor equipment has no colliders** (consistent with the pre-existing crane, ducts and
  cabinets); grabbed glass passes through it.
- **Transparent composition at the two small viewports was captured but not read back by eye**
  (`r1-768x1024.png`, `r1-390x844.png` in `.agent/artifacts/browser/`); their numeric metrics are in
  the table above. The 1440×900 home frame and the pool-top frame *were* read and are correct.

## Deliberate abstractions

- Buoyancy and drag apply to **fragments only**, as in the accepted baseline. Intact glass cannot
  reach the water anyway: the grating collider is a full disc of the pool radius (3.4), so the pool
  mouth is covered. Left unchanged deliberately — the task says preserve the existing coupling.
- The 4.90 → 5.60 light well around the bio-shield is intentionally open, so the underground plant is
  visible from the operating floor; the pit slab catches whatever falls in.
- Ground equipment stands on plinths through the glass floor, so bricks read as removable access
  panels.
- Makeup tank/pump setpoints are a plausible invented operating rule (`TRIGA_ANALOGUE`).
- Cherenkov particles are a `TUNED_PRESENTATION` light-transport proxy, not per-particle physics.
- The transparent floor support layer, the glass-brick building and the free traversing camera are
  `SOURCE_ART_DIRECTION`, not Pavia building facts.
- Per-unit underground coordinates are `REALTIME_PROXY`; no Pavia as-built drawings are public.
- `UG-PLANT-MESH` is a debug-visibility name only; it carries no engineering meaning.

## Open gaps

- `LAB-G01` — underground per-unit coordinates remain `REALTIME_PROXY`. Unchanged.
- `LAB-G02` — ground-floor equipment carries no collision geometry.
- `LAB-G03` — makeup/ventilation setpoints are invented operating rules, not sourced.
- `WTR-G01` — no volumetric light transport; absorption is transmission thickness above water and
  `FogExp2` below, caustics are a curvature proxy.
- `CHR-G01` — covered by the `TUNED_PRESENTATION` particle system.
- `CAM-G01`, `GLA-G01` — instancing, tiering and sleep are in place and counted, but frame cost is
  still **unmeasured on real hardware** (software renderer only).
- `PERF-G01` — the `physicalScene` chunk is 754.44 kB (202.49 kB gzip); no code splitting attempted.
- `GLA-G02` — glass that comes to rest on the shield lid or pit slab has no dedicated landing sound
  distinct from a generic impact; the audio path is shared and unverified.
- `OBS-G01` — **CLOSED** in the previous slice (measurement timing under a 0.76 fps software
  renderer, not a sleep leak). Re-confirmed here at all three viewports: 22 awake at load,
  **0 awake with `awakeKinds {}`** after `ADVANCE(5)`.
- `CTL-G01` — **CLOSED** this slice: the MANUAL desk pulse peak is measured (0.5013).
- `GLA-G03` — **CLOSED** this slice: wall and ceiling glass proven non-grabbable by real clicks on
  named hits.
- `GLA-G04` — **CLOSED** this slice: floor-brick drag performed and the underground plant confirmed
  visible through the vacated slot.

## Handoff focus for the next REVIEWER

1. **Judge transparent composition by eye at 768×1024 and 390×844.** The screenshots are already in
   `.agent/artifacts/browser/`; I captured them but spent my remaining slice on behaviour, so nobody
   has looked at those two frames. This is the largest unexamined visual risk.
2. **Judge the two static colliders against the "no invisible collision surfaces" rule** —
   `shieldCap` and `pitFloor` both back a rendered mesh. If you disagree that the pit slab is visible
   enough to justify a collider, say so; the alternative is glass falling forever, which is what the
   browser actually did before they existed.
3. **Verify the ground-floor heat-exchanger → makeup-skid substitution** against the locked
   two-heat-exchanger rule in `REACTOR_POOL_SYSTEM.md` before reading it as scope drift.
4. **Re-frame the floor-hole shot** if you want a picture rather than a ray stack: move a brick with
   `__SOURCE_PICK__().nearestBrick(x, z)`, then view the slot from ~10 m rather than 4.4 m.
5. **Drive a brick or cube to fracture** — the damage ladder past `INTACT` was not exercised by a
   real interaction in this slice.
6. Audio and real-hardware frame cost remain environmentally unverifiable here; if you have a GPU
   browser, `__SOURCE_PERF__()` plus a rAF counter closes `CAM-G01`/`GLA-G01`.
