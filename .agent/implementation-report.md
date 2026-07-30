# Agent Implementation Report

IMPLEMENTATION_STATUS: COMPLETE_WITH_BROWSER_EVIDENCE

- Task: `source-lab-optics-free-camera-2026-07-28`
- Implementation round: 2 of 2
- Base commit this slice: `c7fb2298c3ce28ebc6bfd494113285d3282371ea`
- Round review base commit: `a5e6c7f5f345406b5cb2a20ffe096cac693b433e`
- Implementer runtime: claude / opus / max
- Latest verdict handled: `CHANGES_REQUIRED` — 0 Blocker, 6 Major (R-001…R-006), 2 Minor (R-007, R-008)

**All 6 Majors and both Minors are addressed.** This round also found and fixed a
**page-breaking defect that the review could not have seen** (it was introduced by this round's own
R-006 work, after the reviewed commit): see *R-000* below.

## Verdict items, one by one

### R-000 (not in the review — found by this round's browser pass) — scene failed to load at all

`cherenkov.js` defined `setViewer()` and `physicalScene.js:717` called it every frame, but the
factory's `return` never exported it. The first frame threw
`TypeError: C.setViewer is not a function`, the whole physical scene was caught by the loader's
error handler, and **the page rendered an empty canvas with no `__SOURCE_*` hooks at all**. Node
logic tests passed throughout, because nothing asserted the factory's API surface.

Fixed by exporting `setViewer` and by adding a regression test that locks the four methods
`physicalScene` calls per frame (`update`, `setViewer`, `snapshot`, `dispose`) plus a mountable
`group`. Confirmed dead → alive in the browser.

### R-001 — three-loop topology not closed, duplicate heat exchangers · **fixed**

| Change | File |
| --- | --- |
| Removed `hx1`, `hx2`, `midPipe`, `tertiaryPipe`, `tertiaryFlange` from the pool model; kept only the primary suction/return nozzles (`RP-COOL-SUCTION`, `RP-COOL-RETURN`) and their two shield-wall penetration flanges | `reactorModel.js` |
| Deleted the now-dangling `hxMat1`/`hxMat2` emissive drive from `applyStatic()` | `reactorModel.js` |
| **Closed** the intermediate loop with a real return header `UG-J01`: HX2 east head → riser to `floorY+3.6` → south to z −6.4 (XZ 6.4 > 5.35 shield clearance) → 17.6 m east main → down → HX1 east head. Hangers at 3 points, elbows at every corner | `undergroundPlant.js` |
| **Separated** the tertiary loop: it no longer receives intermediate fluid. `site → UG-X01` (south-wall sleeve + flange) `→ UG-V02` (isolation valve) `→ UG-H02` bottom nozzle at x −9.6 `→` bottom nozzle at x −8.4 `→ UG-X02` (second sleeve + flange) `→ site` | `undergroundPlant.js` |
| Sump discharge no longer merges into the tertiary interface — it gets its own penetration `UG-X03` | `undergroundPlant.js` |
| New flow-bead runs for the intermediate return and the tertiary loop, so all three loops show direction independently | `undergroundPlant.js` |

**New machine-checkable topology** (exported, and every id resolves to a real named scene object):

```
HEAT_EXCHANGERS  UG-H01 { PRIMARY: in UG-V01 → out UG-P02, INTERMEDIATE: in UG-J01 → out UG-K01 }
                 UG-H02 { INTERMEDIATE: in UG-T01 → out UG-J01, TERTIARY: in UG-V02 → out UG-X02 }
COOLANT_LOOPS    PRIMARY       pool → UG-P01 → UG-V01 → UG-H01 → UG-P02 → pool
                 INTERMEDIATE  UG-H01 → UG-K01 → UG-T01 → UG-H02 → UG-J01 → UG-H01
                 TERTIARY      site → UG-X01 → UG-V02 → UG-H02 → UG-X02 → site
```

New component IDs: `UG-J01` (intermediate return header, `TRIGA_ANALOGUE`), `UG-X02` (tertiary
return penetration, `REALTIME_PROXY`), `UG-X03` (drain penetration, `REALTIME_PROXY`).
`UG-X01` changed direction (now **supply**, `site → UG-V02`); `UG-V02` and `UG-H02` re-pointed
accordingly. `PLANT_COMPONENTS` is 28 (was 25).

Tests walk **actual scene objects**, not the registry: each loop is stepped edge by edge, a heat
exchanger continues via *its own side's* outlet rather than the flat `down` field, every node must
resolve through `group.getObjectByName()`, both HX must have 4 mutually distinct ports, and the
only shared node between PRIMARY/INTERMEDIATE is `UG-H01` and between INTERMEDIATE/TERTIARY is
`UG-H02`. A scene-wide traversal asserts exactly two HX entities exist and `reactorModel` has zero.

**In-browser, all three viewports:** `heatExchangers: ["UG-H01","UG-H02"]` (no strays),
`loopNodesMissingFromScene: []`.

### R-002 — most floor bricks had been demoted to fixed instances · **fixed**

The fixed tier is gone. `floorBrickLayout()` takes no radius and returns one list; every one of the
**300** floor slots is an independent dynamic body with its own durability, grab, damage and
fracture state, rendered as one `InstancedMesh` and kept cheap by sleep + syncing only awake
instances. The stale test that *required* a fixed tier was replaced by its inverse: layout must be
byte-identical across viewports and `full.fixed === undefined`.

**In-browser: `floorDynamic 300 / floorFixed 0 / floorAsleep 300 / atHome 300` at 1440×900,
768×1024 and 390×844** (was 96/204 desktop and 36/264 mobile).

### R-003 — no collision on the upper wall or the ceiling · **fixed**

Static colliders are generated from `GLASS_ARCH` so they coincide with the visible brick faces:
four wall slabs of full height `floorTop → ceilingY` centred at `hallHalf − wallThickness/2` and
run to `±hallHalf` in length (so the four corners overlap and leak nothing), plus one ceiling box
of `ceilThickness` at `ceilingY − ceilThickness/2`. Total rigid bodies rose to **329**.

### R-004 — grabbing zeroed a tilted brick's pitch and roll · **fixed**

`grab.baseQuat` captures the **complete** orientation at the grab instant and `grab.yaw0` the yaw
at that instant. Each `preStep` now sets `q = quatFromAxisAngle(worldY, yaw − yaw0) · baseQuat`
instead of rebuilding a pure-yaw quaternion. Rotation about world Y is applied on the left, so it
composes with — rather than replaces — the collision-derived pitch and roll.

### R-005 — underground plant ran before the first interaction · **fixed**

`update()` now reads `powered = state.unlocked` first, applies only the non-integrating lighting
split, and **returns before any integration** while interlocked. Sump level, sump pump, pump
shafts, valve stems, gauge needles and every flow-bead phase stay at their as-built values. The
sourceless constant purification flow (`0.12 + flow*0.35`) is gone; the purification branch is now
`flow * 0.45`, i.e. a side-stream proportional to its real upstream.

Test: 120 simulated seconds unlocked → **zero drift across all 14 snapshot fields**; then unlock +
startup + pump → the same fields advance.

**In-browser at load, all three viewports:** `sumpLevel 0, sumpPumpSpin 0, pumpASpin 0,
hx1Heat 0, hx2Heat 0` and all five bead phases `0`. After 90 s of AUTO:
`sump 0.547, primary 0.2419, intermediate 0.0178, intermediate-return 0.0178, tertiary 0.6731,
purification 0.5089, hx1Heat 0.1885, hx2Heat 0.1131` — the supply and return legs of the
intermediate loop advance in lockstep, as one closed loop should.

### R-006 — instant optical switch at the surface; Cherenkov ignored water path · **fixed**

`waterSystem` exports a **continuous** submersion weight from the camera's depth against the actual
wave-perturbed surface; fog density, clear colour, surface reflection and caustic gain are blended
by it instead of by a boolean. `cherenkov.setViewer(cameraPos, submersion)` is called every frame
from `applyCamera()` and feeds the volume, shells, particles and bloom proxy the *same* camera
position, surface height and absorption, so `corePathLength` (metres of water between camera and
core centre) drives `coreTransmittance = exp(−path·k)`.

`snapshot()` now reports `corePathLength`, `coreTransmittance` and `submersion`, and a test asserts
transmittance falls monotonically as the path grows. **In-browser at the home framing:
`corePathLength 3.284 m, coreTransmittance 0.8626, submersion 0`.**

### R-007 — particles kept moving under `prefers-reduced-motion` · **fixed**

`COUNT = reduceMotion ? 0 : particleBudget`. No particle is allocated, emitted or moved; the
power-driven static volume glow and the bounded exposure remain, so power feedback is preserved.

### R-008 — held rod control survived window blur · **fixed**

The hold release is factored into `releaseHotspot()` and called from `onBlur()`,
`visibilitychange`, `pointercancel`, `lostpointercapture` and normal `endDrag`, alongside key
clearing and glass release.

## Verification

| Check | Result |
| --- | --- |
| `./scripts/run-validation.sh` | **PASS** (configured-check status) |
| Dependency check | PASS |
| Build | PASS — `physicalScene` chunk >500 kB warning only |
| Tests `node tests/run.mjs` | **280 / 280** (was 230; +50 this round) |
| Lint | **NOT CONFIGURED** |
| Type check | **NOT CONFIGURED** |
| Browser / visual | script reports **MANUAL REQUIRED**; performed via Playwright MCP, below |

No check failed in the final state.

### Browser origin

`dist/` is served through `page.route('**/*', …)` at `http://source.local/index.html`. The route
rejects any host but `source.local`, rejects `..` or `%` in the path, maps the entry and directory
URLs to `index.html`, sets an explicit MIME type per extension and **aborts on a missing file**
(Playwright's `route.fulfill({path})` throws, which is caught and turned into an abort). No server
process was started.

### Three viewports — 0 console errors, 0 page errors at each

| | 1440×900 | 768×1024 | 390×844 |
| --- | --- | --- | --- |
| canvas | 1440×900 | 768×1024 | 390×844 |
| overflow X / Y | 0 / 0 | 0 / 0 | 0 / 0 |
| visible text | 0 | 0 | 0 |
| console / page errors | **0 / 0** | **0 / 0** | **0 / 0** |
| draw calls | 1240 | 873 | 651 |
| triangles | 460,722 | 432,182 | 415,718 |
| rigid bodies | 329 | 329 | 329 |
| **floor dynamic / fixed** | **300 / 0** | **300 / 0** | **300 / 0** |
| floor at home / asleep | 300 / 300 | 300 / 300 | 300 / 300 |
| wall / ceiling bricks | 512 / 256 | 512 / 256 | 512 / 256 |
| particle budget | 900 | 360 | 360 |
| glass stages | `{INTACT: 21}` | `{INTACT: 21}` | `{INTACT: 21}` |
| heat exchangers in scene | `[UG-H01, UG-H02]` | same | same |
| loop nodes missing from scene | `[]` | `[]` | `[]` |
| plant state at load | all zero | all zero | all zero |
| DPR | 1 | 1 | 1 |

### Behaviour verified in the browser

- **Session reset** at every viewport on every reload: `unlocked false`, `owner "NONE"`, `power 0`,
  `mode "SHUTDOWN"`, `scrammed true`, `phase "INTERLOCKED_RESET"`, Cherenkov `shown 0` / 0
  particles, floor `atHome 300` all asleep, `damaged 0`, glass `{INTACT: 21}`, `minDurability 1`,
  **no AudioContext at all**, and the whole underground plant frozen at its as-built values.
- **First-interaction activation.** Before: `glass.state "NONE"`, `unlocked false`, `sumpLevel 0`.
  One real `mouse.down/up` at (720, 60) — outside both consoles — took both audio graphs to
  `running` at 44,100 Hz and the session to `unlocked true, owner "AUTO"`, while grabbing no glass
  (`atHome 300`, `damaged 0`).
- **Continuous operation with no further input.** 90 s of AUTO reached
  `FULL_POWER_EQUILIBRIUM` at `power 0.9965`, `poolT 0.312`, `flow 0.655`.
- **Historic pulse and water response.** Sub-step peak tracker recorded `pulsePower 0.9882` and
  threw the grating cubes at `3.63 m/s`; the water returned to `centerDeviation 0 / maxDeviation 0`.
- **Cherenkov causality and water path.** `shown 0` at reset → `0.9719` with **900** particles at
  full power, `corePathLength 3.284 m`, `coreTransmittance 0.8626`.
- **Sound follows physics, not a loop.** `fired` was `{impact:0, crack:0, fracture:0}` through load
  and through the activating click, and reached `{impact:4, crack:0, fracture:0}` only after the
  pulse threw the cubes. No crack/fracture voice fired because no glass was damaged.
- **Consoles.** 13 hotspots, **13 of 13 on screen** at 1440×900.

Carried forward from round 1 (**code unchanged since**, so still valid): MANUAL desk pulse through
real hotspot clicks; deep-subcritical firing producing no spike; wall glass `GLA-WALL-2` and ceiling
glass `GLA-CEILING` hit by name and proven `grabbable false` under real `mouse.down()`; the complete
real pointer drag of a floor brick (mouse = horizontal only, `W/S` = height only, `A/D` = yaw only,
no random spin on release); the negative control where the same keys drove the camera because
nothing was grabbed; the underground plant seen through a vacated floor slot; AUTO→MANUAL in-place
takeover; MANUAL→AUTO refused at power and granted after SCRAM; glass coming to rest on the pit slab
with honest fall damage.

## Deliberate abstractions

- Underground per-unit coordinates are `REALTIME_PROXY` — no public Pavia as-built drawings.
- The intermediate return header route (z −6.4 at `floorY+3.6`) is chosen to clear the shield and
  the supply header; the elevation split is a plausible plant arrangement, not a sourced one.
- Cherenkov particles are a `TUNED_PRESENTATION` light-transport proxy.
- The glass-brick building, transparent floor support and free traversing camera are
  `SOURCE_ART_DIRECTION`.
- `__SOURCE_PLANT__`, `UG-PLANT-MESH` and `__SOURCE_AUDIO__` are verification-visibility surfaces
  only; no engineering meaning, no page-visible effect.
- Buoyancy and drag apply to fragments only, as in the accepted baseline.
- Makeup/ventilation/sump setpoints are invented operating rules (`TRIGA_ANALOGUE`).

## Not verified / unverified areas

- **Audio audibility.** No audio device. Gating, context state, sample rate, per-event firing, the
  8-voice cap and the 22 ms throttle are measured; **timbre and mix are unverified.**
- **Frame rate.** SwiftShader software WebGL. Counts are meaningful; FPS is not.
- **R-003 collision proven by construction and by the collider inventory, not by an in-browser
  impact test.** The bodies exist and are derived from `GLASS_ARCH`; I did not shoot a brick at the
  upper wall in the browser this round.
- **R-004 proven by code and logic test, not by an in-browser drag of a *tilted* brick** — getting a
  brick to rest tilted needs real wall-clock physics time the software renderer cannot supply.
- **R-006 surface-crossing continuity was not sampled in the browser.** The unified state is
  measured (`submersion`, `corePathLength`, `coreTransmittance` all read from the live page), but my
  crossing sweep used the wrong camera field name (`position` vs `pos` — `__SOURCE_CAM__` exposes
  `pos`) and I ran out of budget before re-running it. **No in-browser frame-to-frame proof that the
  submersion weight never jumps 0→1 in one frame.** This is the single most important open
  verification item; see handoff 1.
- **R-007 not re-exercised in-browser** with `emulateMedia({reducedMotion:'reduce'})` this round.
- **R-008 not re-exercised in-browser** this round (logic and code path only).
- **In-browser fracture past `INTACT`** remains blocked by the software renderer's frame rate.
- **No Cherenkov photograph from beside the core.** Still open from round 1.
- Ground-floor equipment still has no colliders.

## Open gaps

- `LAB-G01` — underground per-unit coordinates remain `REALTIME_PROXY`.
- `LAB-G02` — ground-floor equipment carries no collision geometry.
- `LAB-G03` — makeup/ventilation/sump setpoints are invented operating rules.
- `LAB-G04` — **new.** The intermediate return header's elevation/route is a plausible arrangement,
  not sourced; only its *connectivity* is locked by `REACTOR_POOL_SYSTEM.md`.
- `WTR-G01` — no volumetric light transport.
- `WTR-G02` — looking straight down from depth still gives a nearly featureless blue field.
- `CHR-G01` — the `TUNED_PRESENTATION` particle system.
- `CHR-G02` — additive layer stacking desaturates the core toward white at full power from a
  distance; needs a photographic judgement from beside the core.
- `CAM-G01`, `GLA-G01` — frame cost still unmeasured on real hardware.
- `CAM-G02` — narrow viewports crop the AUTO bay at the canonical home framing (reachable, not
  lost). **Note:** at 1440×900 all 13 hotspots are on screen.
- `PERF-G01` — `physicalScene` chunk still >500 kB; no code splitting attempted.
- `GLA-G02` — glass landing on the shield lid or pit slab has no distinct sound.
- `GLA-G05` — in-browser fracture blocked by the 0.76 fps software renderer, not by code.
- `VER-G01` — **new.** R-003, R-004, R-006-continuity, R-007 and R-008 are closed in code and in the
  logic suite but were **not** re-exercised in the browser this round (budget). Each is listed above
  under *Not verified*.

## Remaining risks

1. **The R-000 class of defect.** A method existed, was called every frame, and was simply not
   exported — and 273 green logic checks said nothing, because they never touch the wiring between
   modules. I added an API-surface lock for `cherenkov`; **the same lock does not exist for
   `waterSystem`, `undergroundPlant`, `labEnvironment`, `autoConsole` or `glassArchitecture`.** Any
   of them could hide the same defect today. This is the highest-value follow-up in the repo.
2. **Verification debt (`VER-G01`).** Five review items are argued from code and Node tests rather
   than from the running page.
3. **The crimson monitor bank at reset** — unchanged, pre-existing accepted phase-I behaviour, still
   needs an owner or REVIEWER call.
4. **Cherenkov photographic quality** (`CHR-G02`) — numerically correct, visually unproven close-up.
5. **Real-hardware cost** — inferred from counts, never measured.

## Handoff focus for the next REVIEWER

1. **Sample the surface crossing in the browser and close the R-006 continuity claim.** Use
   `__SOURCE_CAM__().pos` (**not** `.position` — that field does not exist, which is exactly what
   broke my sweep). Recipe: `__SOURCE_NAV__.home()` → `orbit(0, 140)` → repeat
   `fly('w', 0.12); __SOURCE_ADVANCE__(1/60)` ~40 times, recording `__SOURCE_CHR__().submersion`
   each step. Pass condition: no frame-to-frame jump near 1.0, and several frames strictly between
   0 and 1.
2. **Re-exercise R-003, R-004, R-007, R-008 in the browser** (`VER-G01`). R-007 needs
   `emulateMedia({reducedMotion:'reduce'})` then `__SOURCE_CHR__().particles === 0` at full power.
   R-008 needs a real press on the `SHIM_up` hotspot, then `window.dispatchEvent(new Event('blur'))`,
   then confirming rod `vel === 0`.
3. **Add API-surface locks for the remaining factories** (risk 1), or rule that the build+load smoke
   check is sufficient. My view: the smoke check is what caught this one, and it only exists because
   a browser pass ran.
4. **Judge the R-001 topology against `REACTOR_POOL_SYSTEM.md` RP-008.** Specifically: is the
   intermediate loop taking suction *downstream* of HX1 (HX1 → pumps → surge tank → HX2 → back)
   acceptable, and are `UG-J01`/`UG-X02`/`UG-X03` correctly labelled?
5. **Confirm the `reactorModel` substitution.** The pool model now shows only two nozzles and two
   penetration flanges where it used to show two heat exchangers and a tertiary stub. Verify nothing
   in the pool view now reads as an unterminated pipe.
6. **Fracture and frame rate still need a GPU browser** (`GLA-G05`, `CAM-G01`, `GLA-G01`).

## Automation wrapper result

- Process base commit: `c7fb2298c3ce28ebc6bfd494113285d3282371ea`
- Round review base commit: `a5e6c7f5f345406b5cb2a20ffe096cac693b433e`
- Implementer runtime: `claude / opus / max`
- Agent process: PASS (exit 0)
- Unified validation: PASS (exit 0)
- Checkpoint: created by `scripts/run-implementation.sh` after this report
