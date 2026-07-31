# Agent Implementation Report

IMPLEMENTATION_STATUS: COMPLETE
VERDICT_ADDRESSED: none — `.agent/latest-review.md` is `NOT_RUN / NOT_REVIEWED` for the
previous task and contains no Blocker or Major for this task.

## Metadata

- Task: `fly-foundation-hot-air-balloon-v1-2026-07-31`
- Implementation round: 1 (absolute target for this parent run: 2)
- Implementation segment: 1
- Round review base commit: `a0f0907b0d42e6bfaed74811457c65a3bc8388ac`
- Process base commit / current HEAD: `a4785e6f40c0a91d7f454c9f1d49c5cc4f40edcb`
- Implementer runtime: codex / gpt-5.6-sol / xhigh
- Session generation: 1 (new role session; run manifest
  `.agent/artifacts/runs/implementation-r1-s1-20260731T180311Z-14431.env`)
- Scope: the first complete FLY `clear + hotAirBalloonC100` vertical slice, the shared
  multi-scene host, and only the minimum SOURCE lifecycle adapter/cleanup required by that host.
- Git: no stage, commit, push, deploy, reset, clean, rebase, branch switch or Git-history write was
  performed. The neutral wrapper still owns the checkpoint.

## 1. Outcome and changed components

The site now opens in a textless real-time three-dimensional selector rather than directly creating
SOURCE. One canvas and one host generation own exactly one of `SITE_SELECT`, `SOURCE`, or `FLY`.
The FLY route supports the registered clear-weather/C-100 configuration, its vehicle-specific guide,
explicit departure, manual burner and vent controls, three cameras, a deterministic journey with
floating-origin shifts, and a physical automatic safe landing that ends only after stable contact.

| Component ID | Files | Implemented result |
| --- | --- | --- |
| `SITE-HOST-001` | `src/core/sceneHost.js`, `resourceScope.js`, `src/main.js` | Single active scene generation; explicit create/dispose ownership; visibility/resize/Escape routing; test-only direct URL support; resource counters. |
| `SITE-SELECT-001` | `src/scenes/selector/selectorScene.js` | Textless pickable SOURCE reactor-pool miniature and FLY 16-gore balloon miniature; pointer and keyboard activation; portrait framing. It never creates either business physics world. |
| `SOURCE-LIFE-001` | `src/scenes/reactor/sourceScene.js`, one cleanup line in `physicalScene.js` | Idempotent SOURCE adapter around the accepted factory. Existing SOURCE owns its established visibility behavior. Dispose now also removes the previously omitted `__SOURCE_PLANT__` hook. No reactor, lab, water, glass, camera, console, or audio business behavior was rewritten. |
| `FLY-REG-001` | `src/scenes/fly/registry.js` | Data-driven registries contain exactly `clear` and `hotAirBalloonC100`; compatibility, guide, control schema, recovery strategy, and source manifest are vehicle/weather data. |
| `FLY-CLK-001` | `src/core/simulationClock.js`, `flySession.js` | `1/120 s` authoritative fixed step, timestamped action queue, 12-substep cap, explicit dropped backlog, pause/resume, previous/current snapshots, and render-only interpolation. |
| `FLY-ATM-001` | `atmosphere/standardAtmosphere.js`, `weather/clearWeather.js` | U.S. Standard Atmosphere troposphere/lower-stratosphere baseline plus one coherent moist density, layered wind, continuous deterministic gusts, thermal columns/downwash, and near-ground mechanical turbulence; precipitation/cloud water/electric field remain zero for clear weather. |
| `FLY-WORLD-001` | `world/proceduralWorld.js`, `worldView.js` | Seeded analytic terrain shared by render, ground contact, and landing safety; FIELD/FOREST/ROAD/WATER metadata; 25 bounded active chunks; continuous borders; instanced forest proxies; procedural sky/sun/fog; thermal-site 3D cloud clusters whose opacity reads atmospheric humidity; 96 m floating-origin threshold. |
| `FLY-C100-GEO-001` | `vehicles/c100Manifest.js`, `balloonModel.js` | 16 separately grouped longitudinal gores, 24 vertical envelope rings, longitudinal/horizontal load tapes, Nomex mouth, top parachute vent, deflation line, four load lines, frame, twin burners/valves/flames, two tanks/valves/hoses, four-wall wicker basket with thickness/ribs/floor/rim, and physical burner/vent handles. |
| `FLY-C100-THERM-001` | `vehicles/hotAirBalloon.js` | Fuel mass flow → thermal power → lumped internal energy → temperature/density/internal-air mass → displaced-air buoyancy. Heat transfer, mouth exchange, vent enthalpy loss, fuel exhaustion and maximum-temperature interlock are continuous states, not velocity commands. |
| `FLY-C100-DYN-001` | `vehicles/hotAirBalloon.js` | Independent envelope and basket positions/velocities, tension-only spring/damper suspension, distinct relative-wind drag, gravity, terrain contact/friction, visible swing/line load, liftoff/landing stages, and a recovered envelope-unload visual proxy. There is no horizontal user force. |
| `FLY-CTRL-001` | `flyScene.js`, `main.css` | Guide focus boundary, `Space`/burner, `V`/vent, `R`/recovery, `C`/camera, pointer-held physical handles, icon-only mobile controls, touch pointer cancellation, focus-loss zeroing, and icon-only abandon confirmation. Guide pause zeroes holds and does not accrue missed physics. |
| `FLY-REC-001` | `recovery/recoveryPlanner.js`, `flySession.js` | Candidate scoring rejects WATER/FOREST/ROAD, slope, and dense obstacles; planner records `writesPose:false`; AUTO owns only burner/vent, replans near unsafe terrain, follows real wind/contact, and requires 3 s stable safe-field contact before `RECOVERED`. |
| `FLY-CAM-001` | `flyScene.js` | PILOT (basket eye), CHASE, and ORBIT views read interpolated vehicle state only; camera switches do not write physics. |
| `FLY-AUD-001` | `audio/flyAudio.js` | AudioContext is created only by departure gesture. Independent burner, relative-wind, fabric/swing, suspension-load and contact-impact voices read authoritative state; pause/dispose suspends or closes all nodes. |

`PROJECT.md` and `README.md` were updated from the now-false “FLY not implemented” fact to the
present first-slice status. `tests/run.mjs` grew from 338 to 372 checks.

## 2. Resource ownership and SOURCE protection

- `SceneHost` tears down the current scene before incrementing the generation and constructing the
  next. Each scene owns one renderer/RAF; only FLY owns a FLY clock/world, and only SOURCE owns its
  existing cannon world.
- `ResourceScope` records listeners, timers and DOM cleanup. FLY additionally disposes world chunk
  geometry/materials, sky/cloud/tree resources, balloon geometry/materials, audio nodes/context,
  clock/action queue, guide/controls, renderer, and `__FLY__`. The selector disposes both miniature
  trees and its renderer. SOURCE remains behind an idempotent adapter.
- Successful desktop browser sequence ended with counts
  `created={SITE_SELECT:3,SOURCE:2,FLY:1}` and
  `disposed={SITE_SELECT:3,SOURCE:1,FLY:1}` while the second SOURCE was the sole active scene.
  After the first SOURCE return, SOURCE state and `__SOURCE_PLANT__` were absent before selector
  creation continued.
- First SOURCE interaction still selected `AUTO`, unlocked both accepted audio chains, preserved
  21 intact cubes / 0 fragments / durability 1.0, and reported one SOURCE world/RAF. The second
  SOURCE was a new `NONE / INTERLOCKED_RESET / unlocked:false` session with the same intact glass
  inventory. The existing 338 SOURCE logic checks remained green.

## 3. Physical clock, world coordinates and atmosphere

- Authoritative step: `0.008333333333333333 s`; maximum catch-up: 12 substeps. Excess wall time is
  counted as `droppedTime`, not replayed after a hidden tab. Guide and hidden-state pauses clear
  continuous inputs and reset the accumulator on resume.
- World state uses double-precision logical `x/y/z`. Render and camera positions subtract the current
  origin. A shift snaps horizontal origin to the 128 m chunk grid and records its event without
  changing logical position, velocity, temperature, fuel, wind phase, control owner or trajectory.
- Active terrain is a `5 × 5 = 25` chunk window. Each chunk is 128 m and uses a 12 × 12 visible mesh;
  stale chunks are disposed. Landing-region metadata uses deterministic 160 m cells so a normally
  drifting balloon has a physically useful contact window. The canonical 70 m launch area is a
  safe FIELD, matching the task's specified departure condition.
- Standard-atmosphere cross-checks:

  | Altitude | Temperature | Pressure | Density |
  | --- | ---: | ---: | ---: |
  | 0 m | 288.15 K | 101325 Pa | 1.225000 kg/m³ |
  | 1000 m | 281.65 K | 89874.56 Pa | 1.111643 kg/m³ |
  | 5000 m | 255.65 K | 54019.89 Pa | 0.736116 kg/m³ |
  | 11000 m | 216.65 K | 22632.04 Pa | 0.363918 kg/m³ |

- At the browser's pre-AUTO 78.35 m sample, wind was
  `(5.194, -0.002, 1.858) m/s`; changing altitude changes both direction and speed. All drag uses
  `v_body - v_wind`; the zero-relative-speed automated check is within floating-point zero.

## 4. C-100 sources, mass manifest, geometry and state links

### Source labels

- `PRIMARY_SOURCE`: Cameron C-Type gives 16 gores, 100,000 ft³, 65 ft, 57 ft, 2,000 lb certified
  weight, 218 lb standard envelope weight, Nomex lower panels, parachute/deflation line and load-tape
  topology. Cameron burners/tanks pages support the product-family twin-burner/tank form. FAA Balloon
  Flying Handbook supports open-mouth pressure approximation, burner/vent operation, wind-layer
  navigation, landing and recovery structure. U.S. Standard Atmosphere 1976/NASA constants support
  the atmosphere formulas.
- `DERIVED`: `2,831.684659 m³`, `19.812 m`, `17.3736 m`, `907.18474 kg` certified limit, and
  `98.883137 kg` envelope mass are direct SI conversions of those source values.
- `FLY_REFERENCE_CONFIGURATION`: the Cameron C-100 envelope plus same-family lower system. It is not
  claimed to be a certified serial-number aircraft or a verified type-compatible assembly.

### Mass inventory

| Mass | Value | Label |
| --- | ---: | --- |
| Standard envelope | 98.883 kg | `DERIVED` Cameron 218 lb |
| Basket | 145 kg | `ENGINEERING_PROXY` |
| Frame + twin burners | 58 kg | `ENGINEERING_PROXY` |
| Two empty tanks | 52 kg | `ENGINEERING_PROXY` |
| Initial fuel | 76 kg | `ENGINEERING_PROXY` |
| Pilot | 82 kg | `ENGINEERING_PROXY` |
| Initial hardware/fuel/pilot subtotal | 511.883 kg | derived sum; distinct from certified limit |
| Initial internal air | 3420.250 kg | state-derived `pV/(RT)` |
| Initial full physical integration mass | 3932.134 kg | hardware + internal air; not mislabeled as certified gross weight |

The certified 907.185 kg value is retained only as a separate reference-limit field. It is never used
as envelope mass, actual hardware mass, or an artificial force.

### Thermal/force samples

| State | Internal T | Internal density | Buoyancy | Weight | Fuel | Height/vertical speed |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| first fixed step | 291.799 K | 1.20785 kg/m³ | 33.923 kN | 38.561 kN | 76.000 kg | ground contact |
| 28 s main burner | 360.951 K | 0.97543 kg/m³ | 33.895 kN | 32.054 kN | 70.629 kg | 7.52 m / +2.34 m/s |
| +18 s coast | 351.970 K | state-derived | state-derived | state-derived | 70.629 kg | 76.36 m; origin shift 1 |
| +5 s vent | 344.422 K | 1.01144 kg/m³ | state-derived | state-derived | 70.629 kg | continuous upward inertia, but cooling trend established |

This demonstrates the required causal order: burner consumption/energy precede density and net-force
change, the basket leaves through solved force/contact state, fuel stops changing after release, and
vent cools the air without writing vertical velocity.

Visible state links include burner flame ← `heatInputW/burnerValve`, envelope/basket transforms ←
their independent interpolated bodies, load lines ← both attachment positions, basket tilt ← swing,
recovered fabric unload ← `RECOVERED`, cloud opacity ← humidity, ground color/trees/safety/contact ←
the same terrain query, and each sound voice ← its named real-time state.

## 5. Manual journey and automatic recovery evidence

The successful desktop Playwright route used real icon-button pointer holds, not a second control
model. The debug `advance()` only repeats the same `1/120 s` authoritative step to avoid waiting
minutes on SwiftShader.

- Departure: `READY_ON_FIELD / MANUAL`, fuel 76 kg, burner/vent zero, audio unlocked only by the
  actual guide confirmation gesture.
- Burner: 28 s hold reached `FREE_FLIGHT`, 7.69 m AGL, +2.35 m/s, 361.09 K and 70.616 kg fuel;
  release returned both holds to zero.
- Manual drift: 18 s coast reached `(104.64, 80.64, 26.47) m`, 78.35 m AGL, sampled the higher wind
  layer and completed origin shift 1 before AUTO was requested.
- Vent: 5 s hold changed 352.11 K → 344.22 K without consuming fuel; release returned the vent to 0.
- Camera changed PILOT → CHASE without any vehicle-state change. Reopened guide produced exactly
  `0 s` simulation change over the real 260 ms pause and remained fully readable.
- AUTO: the only selected candidate was a safe FIELD and every plan recorded `writesPose:false`.
  It passed continuous samples at 30/60/90/120/150 s, entered `LANDING`, and at 162 s reached
  `RECOVERED` on FIELD with contact true, 3.43 s stable contact, burner 0, and 63.930 kg fuel.
- The trajectory contained 217 one-second samples. First/middle/last logical positions were
  approximately `(0.00,0.68,0.00)`, `(408.01,77.79,149.57)`, and `(889.21,1.46,310.46) m`.
  Maximum adjacent one-second world displacement was 7.37 m, not a teleport. Nine recorded origin
  shifts preserved the same logical curve and the active chunk count stayed 25.
- The final envelope/vent/load-tape group is scaled and laid beside the basket as an explicit
  `ENGINEERING_PROXY` for unloaded recovered fabric; it is not called a cloth simulation.

## 6. Audio and performance

- Before departure FLY has no AudioContext. The confirmed gesture produced `running`, 4 continuous
  voices. Burner, wind, fabric/swing and suspension gains update from state; contact impulses create
  throttled one-shots. Dispose closes the context. SOURCE and FLY audio never existed together in the
  lifecycle evidence.
- FLY browser resource snapshot during the full journey: 1 RAF, 1 physics world/clock, 27 registered
  cleanup entries, 4 audio voices and 25 chunks. Selector snapshot: 1 RAF, 0 physics worlds, 0 voices.
- DPR is capped at 1.5. Terrain is bounded, forest uses instancing, cloud geometry/material is shared,
  and far environment has no rigid-body allocation. Physical correctness remains `1/120 s`; visual
  degradation is limited to shared low-resolution geometry and procedural density proxies.
- Production build is static and has no image/video environment assets, backend, runtime keys or
  network service. Vite reports the expected non-fatal chunk-size warning: the main JS is about
  816.8 kB / 225.0 kB gzip. `FLY-GAP-005` records the initial-load optimization opportunity.

## 7. Verification

### Unified validation — PASS

Final standalone command: `./scripts/run-validation.sh`

| Check | Result |
| --- | --- |
| Dependency check | PASS |
| Build | PASS |
| Tests | PASS — 372/372 |
| Lint | NOT CONFIGURED |
| Type check | NOT CONFIGURED |
| Browser / visual | MANUAL REQUIRED by script; completed with Playwright MCP below |

New Node coverage includes fixed-step/catch-up behavior, official atmosphere values/continuity,
seeded weather, cross-altitude wind, chunk determinism/borders/bounds, origin migration, official
C-100 conversions, certified/mass separation, zero relative-air drag, thermal/fuel/vent causality,
30/60/120 Hz agreement over 120 s, planner pose immutability, unsafe-surface rejection and physical
AUTO contact/recovery. The render-rate comparisons were equal below `1e-8`, well inside the 1% goal.

### Playwright MCP — PASS

Build output was served from `dist/` at `http://source.local/index.html` through
`page.route('**/*')`; only that origin was accepted, decoded `.`/`..`/backslash/NUL segments were
aborted, missing files were aborted, and MIME was preserved by asset extension. No background Vite,
preview or HTTP server was used.

| Evidence | 390×844 | 768×1024 | 1440×900 |
| --- | --- | --- | --- |
| Canvas | 390×844 | 768×1024 | 1440×900 |
| Page overflow X/Y | 0 / 0 | 0 / 0 | 0 / 0 |
| Selector/config visible text | 0 / 0 | 0 / 0 | 0 / 0 |
| Guide box | 370×582; all content fits | 680×417; all content fits | 680×478; all content fits |
| Guide → departure | PASS | PASS | PASS |
| Held burner / release | fuel fell; controls `0/0` | fuel fell; controls `0/0` | full liftoff sequence PASS |
| Held vent / release | 294.29→293.77 K; `0/0` | 294.42→293.88 K; `0/0` | 352.11→344.22 K; `0/0` |
| Recovery | stable FIELD / RECOVERED | stable FIELD / RECOVERED | 162 s trajectory / RECOVERED |
| Console/page errors | 0 | 0 | 0 |

An additional 390×844 touch-typed PointerEvent check produced burner `1→0` through
`pointerdown→pointercancel`, vent `1→0` through `pointerdown→pointerup`, and zero console errors.
The desktop full sequence was
`SITE_SELECT → SOURCE → SITE_SELECT → FLY_CONFIG → GUIDE → MANUAL → origin shift → AUTO →
RECOVERED → SITE_SELECT → SOURCE`; lifecycle hooks and counts were inspected at each return.

Screenshots are in ignored artifacts:

- `.agent/artifacts/fly-evidence/mobile-390x844-guide.png`
- `.agent/artifacts/fly-evidence/tablet-768x1024-guide.png`
- `.agent/artifacts/fly-evidence/desktop-recovered.png`
- `.agent/artifacts/fly-evidence/desktop-source-second.png`

## 8. Failures fixed during this segment

- The first mobile evidence attempt exposed that the canonical launch coordinates inherited hashed
  `FOREST` metadata. AUTO correctly refused to declare that position safe, proving the safety path,
  but it violated the required launch-field premise. The world now reserves a deterministic 70 m
  FIELD and uses 160 m landing cells; Node and all three browser viewports recover on safe FIELD.
- The first recovered render scaled only the fabric mesh, leaving load tapes/vent standing at full
  height. The entire envelope assembly now unloads together beside the basket and the CHASE target
  follows that visual proxy. Final recovered browser recheck: `RECOVERED`, safe/contact true, zero
  console errors.
- Initial browser harness attempts used unavailable VM Node globals. The final route uses Playwright's
  own `route.fulfill({path})` and the strict dist-only checks described above. This was an evidence
  harness issue, never a page/runtime failure.

There are no outstanding configured-check failures.

## 9. Deliberate abstractions and open gaps

- `FLY-GAP-001` — **lower-system source coverage**: basket/frame/burner/tank/fuel/pilot masses,
  burner power/efficiency, heat-transfer coefficients, drag areas/Cd, suspension stiffness/damping
  and maximum-temperature value are dimensioned `ENGINEERING_PROXY` values. The result must remain
  `FLY_REFERENCE_CONFIGURATION`, not a certified C-100 assembly or flight trainer.
- `FLY-GAP-002` — **thermal/structure fidelity**: internal air is one uniform temperature node;
  suspension is a tension spring/damper rather than individual cable/cloth FEA; envelope unload is a
  geometry proxy. There is no fabric tear, fire, cable failure, heat stratification or occupant injury.
- `FLY-GAP-003` — **obstacle/contact fidelity**: terrain height and basket contact/friction are
  authoritative analytic collision proxies, and AUTO uses the same terrain safety metadata. Forest
  instances currently supply visual scale and landing exclusion, but individual tree/building/power
  line rigid colliders and full basket edge/tipping contacts are not yet instantiated. Review whether
  this gap is acceptable for round 1; it is the clearest next physics expansion.
- `FLY-GAP-004` — **weather/optics fidelity**: clear-air gust/thermal fields are deterministic
  engineering fields, not CFD. Clouds are humidity-linked 3D sphere-density clusters, not ray-marched
  microphysics. Terrain is a seeded world proxy, not a real place or spherical Earth.
- `FLY-GAP-005` — **initial bundle/performance**: scenes are construction-lazy but statically imported,
  so the selector downloads the combined ~225 kB gzip module even though it creates neither business
  world. Dynamic code splitting is a future optimization; runtime worlds/resources are already single
  and bounded.
- `FLY-GAP-006` — **audio listening**: node/context creation, voice count, state gains, pause and dispose
  were verified, but actual spatial timbre/loudness on the owner's speakers is unverified.
- `FLY-GAP-007` — **deep SOURCE browser regression**: the complete existing SOURCE Node suite passes and
  browser lifecycle/reset/glass/audio/AUTO first interaction pass. The full MANUAL control chain,
  pulse, glass fracture, underwater camera and underground traversal were not replayed in this FLY
  browser pass because their accepted business code was not changed.

## 10. Exact handoff focus for the next REVIEWER

Review range: `a0f0907b0d42e6bfaed74811457c65a3bc8388ac` → final implementation checkpoint
created by the neutral wrapper.

1. Treat `SITE-HOST-001` as the primary regression boundary: repeat SOURCE → FLY → SOURCE, confirm
   only one renderer/RAF/world/audio scope and verify every old debug hook disappears on dispose.
2. Audit `hotAirBalloon.js` force/mass bookkeeping, especially why certified gross/reference weight,
   hardware subtotal and internal-air physical mass are distinct; confirm burner/vent never write
   velocity and horizontal force only comes from relative-air drag/suspension/contact.
3. Audit floating-origin semantics: logical positions and wind phase must not change; only render/local
   coordinates shift. Check previous/current snapshot interpolation across the first event at ~45 s.
4. Re-run the desktop timeline and inspect the sole recovery plan, continuous trajectory, nine origin
   events, candidate safety, burner/vent ownership, actual contact and 3 s stability gate. Confirm there
   is no planner pose write or return-to-start assumption.
5. Inspect the real C-100 geometry hierarchy and recovered unload proxy: 16 gores, tapes, vent/line,
   suspension, frame, burners, tanks/hoses, basket thickness and independent envelope/basket transforms.
6. Decide severity/next action for `FLY-GAP-003` (individual near-field obstacle colliders and fuller
   basket tipping). This is the most important disclosed acceptance gap, not a hidden claim.
7. Check responsive guide/controls and the touch `pointercancel` path, plus keyboard blur/hidden cleanup,
   guide pause, camera independence and return confirmation.
8. Confirm `SOURCE-LIFE-001` is only an adapter/cleanup and that no protected SOURCE business behavior
   changed. `FLY-GAP-007` lists the deep browser flows not replayed here.

## Automation wrapper result

- Process base commit: `a4785e6f40c0a91d7f454c9f1d49c5cc4f40edcb`
- Round review base commit: `a0f0907b0d42e6bfaed74811457c65a3bc8388ac`
- Implementer runtime: `codex / gpt-5.6-sol / xhigh`
- Agent process: PASS (exit 0)
- Unified validation: PASS (exit 0)
- Checkpoint: reconstructed by the attached GENERAL after isolating the protected README update
