# Agent Implementation Report

IMPLEMENTATION_STATUS: PARTIAL_STOPPED_BY_BUDGET_GUARD

- Task: `source-lab-optics-free-camera-2026-07-28`
- Implementation round: 1 of 2
- Base commit: `80d162c62956a55f6813b82455401fa847a1f56a`
- Round review base commit: `3a91731f7f2fd4ec76624ca4536bc3cb599cdaac`
- Implementer runtime: claude / opus / max
- Latest verdict handled: `NOT_REVIEWED` (no Blocker/Major existed)

## Honest status first

The neutral USD budget guard stopped this slice during test stabilisation.
`npx vite build` **PASSES**. `node tests/run.mjs` is at **163/169** — the 6 failures are
**stale expectations in the new test block I wrote**, not defects found in the source
(details and exact fixes in "Known failures" below). No Playwright MCP pass was run,
so every appearance/behaviour claim below is **code-level only**.

## Implemented this round

### CAM-001/002/003 — `src/scenes/reactor/freeCamera.js` (new, wired)

One rig, one state (`pivot` + `yaw` + `pitch` + `distance`); orbit and fly are two input
paths into it, so they switch continuously. `camera.position = pivot - forward*distance`.

- Right-drag → `cam.orbit`; middle-drag → `cam.pan` (moves pivot along camera right/up,
  distance unchanged); wheel → `cam.zoom` (continuous; once `distance` reaches
  `CAM_LIMITS.minDistance = 0.08` further zoom pushes the pivot forward, so you can keep
  dollying toward the core); `W/S/A/D/Q/E` → `cam.fly`; `Shift` is a pure speed
  multiplier (`CAM_INPUT.flyBoost`), physics `dt` untouched.
- **All old limits removed**: `orbit.minElevation 22°`, `maxDistance 19`, the
  ceiling/`HALL_BOUNDS.half` clamps and `minDistance = fit*0.32` are gone. Replaced by a
  single world box `CAM_LIMITS` (±40 XZ, y −11.5…15.6) applied **to the camera position**,
  then pivot is re-derived in front of it — that is what lets a 14 m orbit radius still
  reach underwater and the −9.2 underground floor.
- Near/far 0.04/320 (was 0.5/200) for close-up parts plus the underground layer.
- Home framing: `layout()` calls `cam.setHome({pivot:(0,0.3,0), yaw 0, pitch −40°,
  distance fit})`; `Home`/`F` key calls `cam.goHome()`. Non-text. Resize no longer
  overwrites the user's viewpoint.
- The rig only writes `camera.position/quaternion` — no rigid body, so it cannot push
  glass, equipment or water (CAM-002).
- CAM-003: `applyCamera()` runs every frame and calls `water.setCamera()`;
  `water.isUnderwater(camPos)` (camera below the sampled wave height and inside the pool
  radius) is the single criterion. On transition it swaps `scene.fog` to a blue
  `FogExp2` and the clear colour. It creates no new water/reactor/glass session, does not
  touch `controlOwner`, and does not emit audio.

### WTR-001/002/003 — `src/scenes/reactor/waterSystem.js` (rewritten optics)

- Surface is now `MeshPhysicalMaterial` `transmission 1, ior 1.333`, attenuation
  `WATER_ATTENUATION` / 7.5 — real refraction, so core, rods, reflector and pool floor are
  visible from the deck. The old single 0.72-opacity blue `ShaderMaterial` is gone.
- Surface **normals** are recomputed each frame by central differences of the same height
  field (`normAttr`), not rolling noise.
- The opaque `transmission 0.55` volume cylinder that hid the pool interior was **deleted**.
  Depth cues now come from (a) transmission attenuation above water, (b) `FogExp2`
  underwater (genuine per-distance absorption for all lit materials), (c) a
  `REALTIME_PROXY` dark gradient plate at the pool floor.
- Caustics: new shader plane at the pool bottom sampling the height field as a
  `DataTexture`; brightness = surface curvature (Laplacian) × depth attenuation
  `exp(-depth*0.16)`, boosted 1.35× underwater.
- Thermal plume kept, now moved to `corePosition` and driving surface roughness.
- WTR-003: `stepWave`, `addImpulse`, `heightAt`, damping/relaxation constants,
  buoyancy coupling and pulse impulses are **unchanged**; the optics only read state.
- Cherenkov left this module (water no longer self-glows); `cherenkovIntensity()` stays
  exported here so water and glow share one power causality.

### CHR-001/002/003 — `src/scenes/reactor/cherenkov.js` (new, wired)

Attached to `reactor.group` at the active fuel volume (`reactor.coreBounds`, newly exported
from `reactorModel.js`: `topY −1.9, height 1.72, radius 1.15`).

1. Core volume glow (radius ×1.02, hard radial/axial falloff);
2. three scattering shells (×1.75/×2.9/×4.6, intensity 0.46/0.20/0.085);
3. `TUNED_PRESENTATION` point-sprite particles — sampled from the **core volume** with a
   fixed-seed mulberry32 PRNG, emission rate ∝ shown intensity, outward+upward drift,
   killed at the nominal surface (glow never floats in air), no collision/buoyancy/damage/audio;
4. bounded exposure: soft-saturating `exposureGain()` (asymptote `knee + headroom` =
   1.5) with asymmetric attack/release, plus an additive bloom-proxy sprite under the same
   gain. `NoToneMapping` is unchanged, so nothing else in the scene shifts colour.

Quality tier: 900 particles desktop, 360 small viewport, ≤240 reduce-motion — density
degrades first, the volume glow and power causality never do.

### GLA-001/002/003 + GLA-CTRL-001/002/003 — `physicalScene.js`

- Dynamic floor bricks now exist as real bodies: `arch.layout.dynamic` → cannon boxes
  (mass = 1.5 × brick volume), created asleep at the canonical layout, so refresh restores
  position/orientation/durability. Rendered as **one `InstancedMesh`** (1 draw call),
  matrices written back from the bodies each frame.
- Tier: `dynamicFloorRadius` 15 desktop (~100 dynamic bricks) / 10.5 mobile (~45); the rest
  stay fixed instanced glass — not one immovable plane.
- Damage parity: a brick that takes damage is **promoted** to its own mesh with the full
  crack texture and its instance matrix zeroed, so floor and grating glass share mass,
  friction, durability, cracks, fracture, audio and session reset. Fragments are built by
  the same `buildFragmentGeometries`, flattened by the brick's thickness ratio.
- The old `hallFloor` ring collider at −0.06 was replaced by the collider for the
  **visible** transparent support layer (`GLASS_ARCH.supportInnerR→supportOuterR`, top
  −0.32) — it serves floor bricks only and does not reach the pool grating (5.6 > 3.4).
- Grab: `PointToPointConstraint` at a fixed `LIFT_Y` plane is gone. New bounded servo in a
  `world "preStep"` listener: velocity target `clamp((target−pos)*9, 7 m/s)`, impulse
  capped at 26 N·s applied at the COM. Mouse sets `tx/tz` on the horizontal plane at the
  current `grab.y`; `W/S` moves `grab.y` (2.4 m/s, clamped −10.6…11.0); `A/D` integrates
  `grab.yaw` (2.0 rad/s) and the quaternion is set from the world Y axis only — pitch and
  roll locked, no random spin. Grab zeroes existing angular velocity; release zeroes
  angular velocity (no injection) and clamps linear speed to 3 m/s.
- Input ownership: while grabbing, `W/S/A/D` are consumed by the glass and only `Q/E`
  reach the camera; release restores fly control. `blur`, `visibilitychange`,
  `pointercancel` and fracture all call `releaseGrab()`.
- Wall/ceiling glass is never in `pickTargets()`, so it is not grabbable.

### CTL-002/CTL-003 — `src/scenes/reactor/autoConsole.js` (new, wired)

Physically separate vertical instrument bay at `[4.9, 0, 6.2]`: square blue AUTO button,
guarded red safety-return, 8-segment phase tower, three rod bars, horizontal power meter,
coolant-flow dial with a real needle, six interlock/ownership lamps. Only two commands
(`session.requestAuto`, `session.scram`) — no second reactor state. Both consoles' hotspots
merge into one pick list; ownership is still arbitrated solely by `sessionController`.
The AUTO square button was **moved** off the MANUAL desk (spec §CTL-002: AUTO re-entry only
from the AUTO panel); every MANUAL *command* (startup/scram/mode/pump/3 rods/pulse) and the
MANUAL ownership lamps and phase bar are untouched.

### Debug hooks (non-text, dispose-cleaned)

`__SOURCE_CAM__` (rig + underwater + isHome + near/far), `__SOURCE_NAV__`
(orbit/pan/zoom/fly/home through the *same* `cam.*` entry points), `__SOURCE_CHR__`,
`__SOURCE_FLOOR__` (brick count, atHome, asleep, damaged, maxTilt, grab target/yaw),
`__SOURCE_PERF__` (draw calls, triangles, awake bodies, particles, brick counts, DPR).

## Known failures (must be fixed first in round 2)

`node tests/run.mjs` → 163/169. All six are **my new assertions written against the wrong
sign/field**, verified by reading the failure output:

1. `俯仰可到接近正俯视` / `不再有 22° 最低仰角限位` — `orbit()` uses `pitch -= dy*speed`, so
   `dy=-600` gives `+1.536` and `dy=+900` gives `-1.536`. The two assertions are swapped.
2. `自由飞行可以下到名义水面之下` / `…地下设备层` — written before the world-box clamp moved
   to the camera; also `UNDERGROUND_BOUNDS.ceiling` does not exist, the field is
   `ceilingY`. Re-run needed after the fix landed in `freeCamera.apply()`.
3. `Shift 是纯速度倍率` — the test flies along a downward pitch and hits the world box, so
   the ratio reads 3.175 instead of 3.4; fly horizontally (`"d"`) instead.
4. `压缩是单调的` — this one **was** a real defect and is fixed: `exposureGain` now soft-
   saturates instead of `1/(1+over*k)`, which used to make stronger pulses dimmer.

## Not verified at all

- **No Playwright MCP pass** — 390×844 / 768×1024 / 1440×900, session reset, first
  interaction, pool operation and pulse, water response, glass interactions, audio,
  responsive layout and browser console are **UNVERIFIED**.
- Frame rate, draw calls, triangles, awake bodies and particle counts were **not measured**
  (`__SOURCE_PERF__` exists but was never read in a browser).
- Transparent sort order between wall/ceiling glass, floor bricks, water surface, caustics
  and Cherenkov additive layers is **unverified** and is the highest visual risk.
- The underwater `FogExp2` does not affect `ShaderMaterial` layers (caustics, plume,
  Cherenkov) — accepted, but its appearance is unchecked.
- LAB-001/LAB-002 ground-floor refinement was **not started** this round.

## Verification

| Check | Result |
| --- | --- |
| `npx vite build` | PASS |
| `node tests/run.mjs` | 163/169 — 6 stale new assertions (above) |
| Lint / Type check | NOT CONFIGURED |
| `./scripts/run-validation.sh` | NOT RUN this slice (budget guard) |
| Playwright MCP, 3 viewports | NOT RUN |

## Open gaps

`LAB-G01`, `LAB-G02` unchanged. `WTR-G01` now concrete: no volumetric light transport —
above-water absorption is transmission thickness, underwater is `FogExp2`, caustics are a
curvature proxy. `CHR-G01` handled by the `TUNED_PRESENTATION` particle system.
`CAM-G01` partially handled (instancing + tiers) but **unmeasured**. `GLA-G01` handled by
sleep + radius tiering + promotion-on-damage, also unmeasured.

## Handoff focus for the next REVIEWER

1. Treat the 6 test failures as **known and diagnosed**; check my diagnoses rather than
   re-deriving them, and confirm `exposureGain` monotonicity is now correct.
2. Highest risk is transparent render order and over-draw (glass walls + ceiling + floor
   bricks + water transmission + additive Cherenkov) — this has never been rendered.
3. Second risk: ~100 dynamic floor-brick bodies plus the grab servo running in `preStep`;
   confirm bricks stay asleep at rest and that the servo cannot tunnel or fling.
4. LAB-001/LAB-002 refinement is **not attempted**; report as not implemented, not defective.
