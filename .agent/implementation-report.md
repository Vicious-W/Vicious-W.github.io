# Agent Implementation Report

IMPLEMENTATION_STATUS: COMPLETE
VERDICT_ADDRESSED: none (latest review is `NOT_RUN` / `NOT_REVIEWED`)

## Metadata

- Task: `source-camera-control-refinement-2026-07-30`
- Implementation round: 1 (absolute target for this parent run: 1)
- Round review base commit: `b6b9caddd6eedee39fc90ed85daab268309ac4c6`
- Last recovery checkpoint this slice started from: `43bd7f40d93d5937df4c0880e2f9cbc4b2d6acc1`
- Implementer runtime: claude / opus / high
- Session generation: 1 (role session `b9b4671a-091b-45b2-aba8-00323822e2ab`, resumed across
  three autonomy slices; slices 1–3 produced recovery checkpoints `0ae673d…43bd7f4`)
- Scope: SOURCE observation camera input and motion only. No laboratory, reactor,
  underground, water, Cherenkov, console or glass business model was changed.

## 1. Objective and what actually changed

Owner-locked goal: rebuild the SOURCE observation camera so the laboratory can be
inspected slowly and predictably. Files touched across this round
(`git diff b6b9cad..working tree`):

| File | Change |
| --- | --- |
| `src/scenes/reactor/freeCamera.js` | Camera state model, `beginOrbit()`, sensitivity, damped dolly, `panKeys()`, `tick()` |
| `src/scenes/reactor/physicalScene.js` | Centre-ray focus pick, focus marker, wheel `deltaMode` normalisation, input ownership, blur cleanup, `__SOURCE_NAV__` verification hooks |
| `src/styles/main.css` | `.physical-focus-marker` (blue, textless, 10 px, fades) |
| `src/scenes/reactor/cherenkov.js` | `raycast = () => {}` on glow volume, bloom sprite, particle proxy |
| `src/scenes/reactor/waterSystem.js` | `raycast = () => {}` on caustics and plume proxies |
| `tests/run.mjs` | Camera logic tests rewritten and extended (338 checks total) |
| `PROJECT.md` | Current-fact update for the camera (already in checkpointed history) |

### CAM-001 centre focus

- `pickFocusPoint()` casts an **independent** ray from NDC `(0, 0)` — the screen centre,
  not the mouse position — on right-button `pointerdown` only.
- The first hit with `distance > 1e-3` becomes the orbit focus. Purely optical proxies
  (Cherenkov volume/bloom/particles, caustics, convection plume) now have `raycast`
  disabled, so the focus can only land on real structure. This is the same principle
  the spec already applies to those proxies ("particles are light-transport proxies,
  they own no collision"), extended to picking; no whitelist/blacklist was needed.
- `beginOrbit(hitPoint)` rebuilds the pivot **along the current view axis**
  (`camera.position + forward * clamp(dist, min, max)`) rather than copying the hit
  point. Inside the distance range this is bit-identical to the hit point; beyond
  `maxDistance = 64` it prevents `apply()` from dragging the camera forward, i.e. no
  jump at the instant the right button goes down. Covered by a dedicated node check.
- No hit → pivot and distance are left untouched. That *is* the "stable virtual focus
  along the current sight line at the existing focal length" the contract asks for; no
  extra construction is needed.
- The focus never re-picks during a drag: `orbit()` only writes yaw/pitch.

### CAM-001 sensitivity

- `CAM_INPUT.orbitSpeed = 0.0018 rad/px`, applied identically to yaw and pitch.
- Pitch stays bounded at `±88°`; yaw is unbounded and continuous (no `±π` wrap logic,
  so no jump).

### CAM-001 centre marker

- `.physical-focus-marker`: 10 px ring, `box-shadow 0 0 0 1px rgba(90,170,255,.55)`,
  `pointer-events: none`, `aria-hidden`, no text. Appears on right-press and fades
  itself out after `FOCUS_MARKER_MS = 1200` (literal reading of "短暂"), and is hidden
  immediately on release, `pointercancel`, `lostpointercapture` and blur.
- Because `apply()` ends with `camera.lookAt(pivot)` every frame, the locked focus
  projects to the exact screen centre, so the marker is statically centred by CSS and
  needs no per-frame reprojection.
- `prefers-reduced-motion: reduce` disables its transition.

### CAM-001A wheel dolly

- `physicalScene.onWheel` normalises `WheelEvent.deltaMode` first:
  `0 → ×1`, `1 → ×16 px/line`, `2 → ×canvas.clientHeight`.
- `cam.zoom()` clamps a single event to `±wheelMaxDelta = 120` px-equivalent, then sets
  **only** `rig.targetDistance`. FOV is never touched.
- `tick(dt)` converges `rig.distance → rig.targetDistance` with `1 - e^(-14·dt)`:
  frame-rate independent and structurally incapable of overshoot.
- **Defect found and fixed in this slice.** The step was originally purely geometric
  (`target *= exp(d·zoomSpeed)`). Once `targetDistance` sat at `minDistance = 0.08`,
  one wheel notch produced ≈ 6 mm of forward travel, so the browser evidence pass showed
  the camera stalling at `y ≈ 2.5` — the underground plant was effectively unreachable
  and backing out was equally stuck. The step now uses a floored length scale:
  `step = (exp(d·zoomSpeed) − 1) · max(targetDistance, dollyFloor)` with
  `dollyFloor = 6 m`. Far away this is the familiar proportional zoom (canonical framing
  still 6.195 %/notch, inside the ≤ 8 % bound); close in it floors at ≈ 0.37 m/notch, in
  both directions. Three node checks and a browser dive/back-out series guard it.
- Past `minDistance` the residue accumulates into `rig.pushBudget`, which `tick()`
  spends as continuous `pivot += forward · move` — camera and focus advance together,
  no discontinuous pivot teleport.

### CAM-001A arrow-key screen pan

- `panKeys(dt, {up,down,left,right})` moves the pivot along the **current screen basis**
  (`right = forward × worldUp`, `up = right × forward`), not fixed world X/Z; `apply()`
  then carries the camera with it.
- Time-integrated, diagonals normalised to unit length, returns `false` when no key is held.
- `Home` and `F` both call `goHome()`, restoring the exact `layout()` framing.

### CAM-002 / CAM-003 reachability and optics

- `CAM_LIMITS` keeps only a world bounding box (`±40` horizontal, `y ∈ [-11.5, 15.6]`),
  `near = 0.04`, `far = 320`. The world clamp is applied to the **camera**, then the
  pivot is re-derived along the view axis, so rig state and the real pose stay consistent.
- The camera writes only `camera.position`/`quaternion`; it creates no rigid body, so it
  cannot push glass, equipment or water.
- Water-surface crossing, the AUTO/MANUAL owner, the reactor session, glass durability
  and audio are untouched by camera code.

### Input ownership and focus-loss cleanup

- Right/middle `pointerdown` and `wheel` return early while `grab.entry` is set: during a
  glass grab the camera receives nothing (`GLA-CTRL-003`).
- `W/S/A/D` are grab-only. They are no longer camera inputs; `Q/E`, `Shift` boost and the
  whole `cam.fly()` path were deleted (no references remain anywhere in `src`, `tests`
  or `README.md`).
- Arrow keys are camera-only and `preventDefault()`ed so the page cannot scroll.
- `onBlur()` (window `blur`, `visibilitychange → hidden`) clears the key set, releases the
  console hotspot, releases pointer capture, hides the marker, releases the grab and
  clears the pointer id. `pointercancel` and `lostpointercapture` route through the same
  release path.

## 2. Verification

### `./scripts/run-validation.sh` — Configured-check status: **PASS**

| Check | Status |
| --- | --- |
| Dependency check | PASS |
| Build (`npm run build`) | PASS |
| Tests (`npm test`) | PASS — 338/338 |
| Lint | **NOT CONFIGURED** |
| Type check | **NOT CONFIGURED** |
| Browser / visual | MANUAL REQUIRED → performed with Playwright MCP, below |

New/rewritten camera checks in `tests/run.mjs`: locked sensitivity and strict linearity
with `orbitSpeed`; hit-point lock plus exact centre projection after dragging; no-hit
fallback leaves pivot/distance untouched; over-range hit does not move the camera;
single-notch target change ≤ 8 %; `distance` does not move until `tick()`; no overshoot
outside `[target, start]`; observable intermediate states; 200-event monotonic descent;
near-field step floor (0.372 m) and its symmetric back-out; `dollyFloor` does not change
the canonical-framing ratio; arrow-key screen-horizontal purity (`Δy` exactly 0),
screen-vertical sign, diagonal normalisation, frame-rate independence, and the idle
`false` return.

### Playwright MCP browser evidence

Built to `dist/`, served through `page.route('**/*')` at `http://source.local/index.html`
with the route confined to `dist/` (path-traversal segments and missing files aborted,
MIME from the file extension). No background server was started.

**Three viewports — 390×844, 768×1024, 1440×900**

| Item | 390×844 | 768×1024 | 1440×900 |
| --- | --- | --- | --- |
| Canvas | 390×844 | 768×1024 | 1440×900 |
| Overflow X / Y | 0 / 0 | 0 / 0 | 0 / 0 |
| Visible text length | 0 | 0 | 0 |
| Canonical framing (`yaw`,`pitch`,`dist`) | 0, −0.6981, 16.957 | 0, −0.6981, 16.957 | 0, −0.6981, 16.563 |
| Session on load | `INTERLOCKED_RESET`, owner `NONE`, `unlocked:false` | same | same |
| Glass | 21 cubes, 0 fragments, `minDurability 1.0`, all `INTACT` | same | same |
| Audio before gesture | `unlockedAll:false`, contexts `NONE` | same | same |
| Console | 0 messages | 0 messages | 0 messages |

**Desktop 1440×900 camera measurements (real mouse/keyboard/wheel events)**

- Right-drag 300 CSS px horizontally → **`Δyaw = 0.540 rad`** (target 0.54, band 0.45–0.65).
  Vertical 200 px → `Δpitch = 0.360 rad`.
- Locked-focus screen error during the drag, 10 samples: **max `1.27e-13` px** (≤ 2 px).
  Pivot drift during the drag: **0**.
- Marker: active on press, self-cleared after 1.4 s, cleared on release and on
  `pointercancel`.
- Wheel, canonical framing, `deltaMode 0 / deltaY −100`: target change **6.195 %**;
  `rig.distance` had not yet moved on the event itself; settle samples
  `16.046 → 15.790 → 15.662 → 15.599 → 15.568 → 15.552` (continuous, no overshoot,
  converged). `deltaMode 1 / −3` → **3.025 %**; `deltaMode 2 / −1` → **7.39 %**.
- 12 consecutive same-direction notches: `16.046 … 8.027`, **strictly monotonic**, no jump
  to either limit.
- Arrow keys at `yaw −0.54 / pitch −0.482`: right `Δpivot (0.31, 0, 0.18)` with
  **`Δy` exactly 0**; left the exact negation (right+left cancel to 0); up
  `(0.08, 0.32, −0.14)`, down its negation; camera followed the pivot (0.35 vs 0.358).
- Focus-loss: `ArrowRight` held → `window.blur` → **0 further pivot motion** over 400 ms.
  Right-button held → `pointercancel` → 180 px of mouse motion → **`Δyaw = 0`**.
- Grab exclusivity: grabbed a floor brick via the real pick table, then applied right-drag
  + 4 wheel notches + `ArrowRight`. Camera `Δposition = 0`, `Δyaw = 0`, `Δdistance = 0`,
  `ΔtargetDistance = 0`. After release, `ArrowRight` panned 0.46 m again.
- Dive (pitch down, wheel): `y 14.21 → −11.50`, monotonic. Underwater engages at step 10
  with a continuous optical transition — `submersion 0 → 0.979 → 1.0`,
  `fogDensity 0 → 0.1371 → 0.1400`. Back-out series
  `−10.78 → −9.53 → … → 13.94 → 15.60` in 12 wheel groups.
- Invariance across the whole dive: owner stayed `AUTO`, phase advanced normally
  (`INTERLOCKED_RESET → LOW_POWER_APPROACH`), glass stayed 21 / 0 fragments /
  `minDurability 1.0` / 0 below deck; audio `unlockedAll:true`, both contexts `running`.
- `Home` and `F` from orbited, zoomed, panned, underwater and underground poses all
  returned to `yaw 0, pitch −0.6981, dist 16.563, pivot (0,0.3,0)`, `home:true`.
- Console during the whole desktop pass: **0 errors**. 4 warnings, all the SwiftShader
  driver notice `GPU stall due to ReadPixels` from the headless software renderer —
  environment, not page code.
- Screenshots kept in the ignored path `.agent/artifacts/camera-evidence/`
  (`home-`, `underwater-`, `underground-1440x900.png`).

## 3. Component IDs, sources, proxies and abstractions

- Changed IDs: `CAM-001` (centre focus, sensitivity, marker), `CAM-001A` (dolly and
  arrow-key pan), `CAM-002` (reachability, no rigid-body participation),
  `CAM-003` (water crossing — behaviour unchanged, re-verified),
  `GLA-CTRL-003` (input ownership now excludes the camera during a grab).
- Unchanged this round: all `RP-*`, `LAB-*`, `WTR-*`, `CHR-*` (except `raycast` opt-out),
  `GLA-001/002`, `CTL-*`. Reactor pool, laboratory, underground plant, water optics,
  Cherenkov volume/particles, MANUAL/AUTO consoles, wall/ceiling/floor glass, grating
  support, damage/fracture and audio activation carry the previous round's geometry,
  state links and sources unmodified.
- Source label for the camera itself remains `SOURCE_ART_DIRECTION`: a camera that can
  cross water, floor and equipment is an owner-locked SOURCE direction, not a Pavia
  operator viewpoint. It is not presented as reactor documentation.
- Deliberate abstractions introduced this round:
  - `dollyFloor = 6 m` is a **feel constant**, not a physical length. It exists so the
    near-field wheel step stays usable; it is documented as such in `CAM_INPUT`.
  - `FOCUS_MARKER_MS = 1200` is a presentation constant.
  - `WHEEL_LINE_PX = 16` is the conventional line-height equivalent for `deltaMode 1`.
- Performance: the centre-ray pick runs **once per right-press**, not per frame; the
  marker is a static CSS element with no per-frame work; `tick()` adds one exponential
  per frame. No new draw calls, geometry, materials or render targets.

## 4. Failures, NOT CONFIGURED, unverified areas and risks

- **Failures:** none outstanding. Two were found and fixed inside this round: the
  near-field dolly stall described above, and a missing comma after `dollyFloor` that
  broke module parsing (caught by `npm test`, fixed, 338/338 green afterwards).
- **NOT CONFIGURED:** lint and type check — the project has neither configured; this is
  reported, not silently skipped.
- **Unverified in the browser (honest gaps):**
  - `GAP-CAM-B1` — the "no centre-ray hit" fallback was only reachable in the node test
    (`beginOrbit(null)`). Every browser attempt to aim at empty space still hit real
    structure, because the hall is fully enclosed in glass. The fallback path is correct
    but browser-unproven.
  - `GAP-CAM-B2` — during the browser grab test the pick landed on a **floor brick**
    while the sampled body was grating cube 0, so "W/S still lift and A/D still yaw the
    grabbed glass" is *not* demonstrated by this round's browser data. Those code paths
    were not modified this round (only the camera-side early-return was added) and the
    node suite still covers the grab servo, but the browser leg is open.
  - `GAP-CAM-B3` — arrow-key pan distance per wall-clock second is much smaller in the
    headless SwiftShader browser than on a real GPU, because `frameDelta` clamps to
    0.05 s/frame and the software renderer produces very few frames. The node suite
    proves frame-rate independence of `panKeys` itself (60×1/60 s ≡ 1×1 s); the absolute
    on-screen speed on the owner's machine is **not** verified and may need retuning of
    `panKeySpeed = 5.5` after the owner tries it.
  - `GAP-CAM-B4` — the 390×844 and 768×1024 viewports were verified for load, framing,
    layout, session state and console only. Touch/pointer camera interaction was not
    exercised there; multi-touch camera gestures are an explicit non-goal.
  - `GAP-CAM-B5` — no pulse, MANUAL console chain, glass fracture or water-response run
    was replayed this round. Those flows are outside the camera scope and were verified
    in the previous task; this round only confirms the camera does not disturb the
    session, glass or audio state.
- **Risks:**
  - `dollyFloor = 6` is a hand-picked feel constant. It satisfies every quantitative
    acceptance number, but "0.37 m per notch near the core" is a judgement call the owner
    may want faster or slower.
  - `pushBudget` is only spent by `tick()`, which is skipped while a grab is active. A
    wheel input queued immediately before a grab therefore resumes on release rather than
    being discarded. This is deliberate (camera input is *paused*, not cancelled), but a
    reviewer may prefer it cleared.
  - Disabling `raycast` on the optical proxies is the right call for focus picking, but it
    is a global opt-out on those objects — any future feature that wants to ray-test them
    must re-enable it explicitly.

## 5. Explicitly NOT claimed

The laboratory, reactor pool, underground plant, water optics, Cherenkov appearance and
glass architecture have **not** been reviewed or accepted for visual quality. This round
did not touch them and makes no claim about them. There is no external campus, terrain,
sky or cloud work, and none was started. The owner has not yet inspected the laboratory
through the new camera; that inspection is the point of stopping here.

## 6. Handoff focus for the next REVIEWER

Review range: `b6b9caddd6eedee39fc90ed85daab268309ac4c6` → final implementation commit
(this covers recovery checkpoints `0ae673d`, `435d7bc`, `b600f20`, `7d1e285`, `781883d`,
`43bd7f4` and the final one, so no business change is skipped).

Please concentrate on:

1. `freeCamera.js zoom()` — the `max(targetDistance, dollyFloor)` step scale. Confirm it
   keeps ≤ 8 % at the canonical framing, stays strictly monotonic, never overshoots, and
   that `dollyFloor = 6` is an acceptable feel constant rather than a hidden limit change.
2. `beginOrbit()` rebuilding the pivot along the view axis instead of copying the hit
   point — verify the in-range case is exactly the hit point and the over-range case
   really cannot move the camera.
3. The `raycast = () => {}` opt-outs in `cherenkov.js` and `waterSystem.js` — confirm they
   only affect picking and do not alter any visual or physical behaviour.
4. Input ownership: that the camera truly receives nothing during a grab, that arrow keys
   are camera-only, that `W/S/A/D` are grab-only, and that every focus-loss path
   (`blur`, `visibilitychange`, `pointercancel`, `lostpointercapture`) zeroes continuous input.
5. The five open gaps `GAP-CAM-B1…B5` above — particularly `GAP-CAM-B2` (browser proof
   that `W/S/A/D` still drive the grabbed glass) and `GAP-CAM-B3` (real-GPU arrow-key
   pan speed), which are the two most worth closing with browser evidence.
6. That nothing outside the camera scope regressed: session reset on load, first-interaction
   AUTO/MANUAL split, water-surface optical continuity, glass durability, and audio unlock.

## Automation wrapper result

- Process base commit: `43bd7f40d93d5937df4c0880e2f9cbc4b2d6acc1`
- Round review base commit: `b6b9caddd6eedee39fc90ed85daab268309ac4c6`
- Implementer runtime: `claude / opus / high`
- Agent process: PASS (exit 0)
- Unified validation: PASS (exit 0)
- Checkpoint: created by `scripts/run-implementation.sh` after this report
