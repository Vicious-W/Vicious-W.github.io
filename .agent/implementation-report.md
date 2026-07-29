# Agent Implementation Report

IMPLEMENTATION_STATUS: PARTIAL_BROWSER_EVIDENCE_BLOCKED

- Task: `source-lab-optics-free-camera-2026-07-28`
- Implementation round: 1 of 2
- Base commit: `a8cfcae65cd0ace0a412300ca818e537838bf9b0`
- Round review base commit: `3a91731f7f2fd4ec76624ca4536bc3cb599cdaac`
- Implementer runtime: claude / opus / max
- Latest verdict handled: `NOT_REVIEWED` (no Blocker/Major existed)

## Honest status first

All configured checks pass: `npx vite build` **PASS**, `node tests/run.mjs` **185/185**,
`./scripts/run-validation.sh` **PASS**. The six stale assertions reported by the previous
slice are fixed and the code is stable.

**The Playwright MCP evidence pass did not run.** It is not a code problem: the page needs an
HTTP origin the browser can reach, and in this environment no server process survives past the
Bash call that started it (`ps aux | grep vite` → 0 after `run_in_background`), the `file:`
protocol is blocked by the MCP client, and the one sandbox-network override I attempted was
denied by the permission gate. Consequently **every appearance and in-browser behaviour claim
below is code-level only** — see "Not verified at all". Nothing in this report should be read
as "looks right in a browser".

## Implemented this round

### LAB-001 / LAB-002 / LAB-004 — ground floor (`labEnvironment.js`, +495 lines)

This was the item the previous slice left untouched. New geometry, all real 3D, no textures
faking structure, every item state-linked or explicitly static:

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
| `LAB-V01/V02/V03` | `TRIGA_ANALOGUE` / `REALTIME_PROXY` | supply + exhaust air units, wheels, duct risers into the existing ceiling duct | site → `LAB-V03` → stack |
| `LAB-A01` | `TRIGA_ANALOGUE` | TRANS air riser continuation, regulator panel, gauge, line to the bridge | `UG-A03` → bridge |
| `LAB-T01` | `REALTIME_PROXY` | poolside long-handled tool rack (5 instanced tools) | hall → pool |
| `LAB-P01` | `SOURCE_ART_DIRECTION` | maintenance platform, straight stair, instanced railing posts/rails | hall → `LAB-M01` |

**Topology defect found and fixed.** The ground floor carried a horizontal *heat exchanger* at
`(-9.4, ·, -1.5)`. `REACTOR_POOL_SYSTEM.md` locks "three loops, two heat exchangers", and both
of those now live underground as `UG-H01`/`UG-H02` — the ground unit was a third, sourceless
one. It is replaced by the makeup-water skid above. A regression test asserts exactly two heat
exchangers exist and that they are both underground.

**Second defect fixed.** The old ground loop pipe `runX` terminated in mid-air at `x ≈ -5.6`,
violating "no pipe ends in mid-air". Every new run is drawn point-to-point by a `pipeRun()`
helper and lands on a flange, vessel, sleeve or wall penetration.

**Cross-layer mating is real, not implied.** Two new stubs were added in `undergroundPlant.js`
so the two layers meet at the same XZ: the sample riser at `(7.6, ·, 3.0)` (tapped off the
purification return at its true interpolated height `floorY+0.87`) and the gravity drain at
`(-6.2, ·, -7.6)` routed along the pit ceiling into the sump `UG-D02`. Both get concrete floor
sleeves on each side.

**State links (LAB-004), all read from the single `sessionController` state:**

- rod-drive cabinets: lamp colour/intensity = `rodDriveEnabled[name]`; the indicator bar's
  **geometry** (`scale.y` + re-based `position.y`) = `rod[name].pos`, not an animation;
- annunciator: `scrammed` (red, slow blink), `unlocked` (white), `pulseReady`/`autoAvailable`
  (amber), `controlOwner` (blue for AUTO, dim amber for MANUAL); the point light follows;
- poolside sensors: level = powered, temperature = `poolTemperatureProxy`, conductivity =
  `coolantFlowProxy`, radiation = `powerProxy` + `pulsePowerProxy`;
- sampling cabinet screen: colour lerps on flow, reddens on pulse;
- ventilation: wheels are **stopped** until `unlocked`, then spin at `0.35 + poolT*0.9`
  through a first-order lag; `reduceMotion` cuts the rate to 1.2 rad/s·unit;
- makeup skid: an explicit state machine — tank level falls with `poolTemperatureProxy`
  (evaporation), pump A starts below 0.35 and stops above 0.92, pump B only joins above
  `poolT > 0.45`; the level gauge is scaled geometry. Nothing loops without a cause.

`labEnvironment` now exports `LAB_COMPONENTS` and returns `snapshot()` for machine checking.

### CAM-001/002/003 — `freeCamera.js` (unchanged this slice, tests corrected)

One rig, one state (`pivot` + `yaw` + `pitch` + `distance`); orbit/pan/zoom/fly are input paths
into it. World box `CAM_LIMITS` (±40 XZ, y −11.5…15.6) is clamped **on the camera position**,
then the pivot is re-derived in front of it — that is what lets a 14 m orbit radius still reach
underwater and the −9.2 underground floor. Near/far 0.04/320. `Home`/`F` → `goHome()`. The rig
writes only `camera.position/quaternion`, so it cannot push glass, equipment or water (CAM-002).
CAM-003 underwater detection is `water.isUnderwater(camPos)`; crossing swaps `scene.fog` to a
blue `FogExp2` and the clear colour, creates no session, does not touch `controlOwner`, emits no
audio.

Test corrections (these were the previous slice's stale assertions, not source defects):
`orbit()` is `pitch -= dy*speed`, so the drag directions in the two pitch-limit assertions were
swapped; and `UNDERGROUND_BOUNDS.ceiling` does not exist — the field is `ceilingY`.

### WTR-001/002/003 — `waterSystem.js` (unchanged this slice)

`MeshPhysicalMaterial` `transmission 1, ior 1.333` with `WATER_ATTENUATION`/7.5 — real
refraction, so core, rods, reflector and pool floor are visible from the deck. Surface normals
are central differences of the same height field. The opaque volume cylinder that hid the pool
interior is deleted; depth cues are transmission attenuation above water, `FogExp2` underwater,
and a `REALTIME_PROXY` gradient plate at the pool floor. Caustics are a shader plane sampling
the height field as a `DataTexture`, brightness = surface Laplacian × `exp(-depth*0.16)`,
1.35× underwater. Thermal plume drives surface roughness. `stepWave`, `addImpulse`, `heightAt`,
damping, buoyancy coupling and pulse impulses are **unchanged** — the optics only read state.

### CHR-001/002/003 — `cherenkov.js` (unchanged this slice)

Attached to `reactor.group` at the active fuel volume (`coreBounds`: `topY −1.9, height 1.72,
radius 1.15`): core volume glow, three scattering shells (×1.75/×2.9/×4.6), `TUNED_PRESENTATION`
point-sprite particles seeded by a fixed-seed mulberry32 PRNG and killed at the nominal surface,
and a soft-saturating `exposureGain()` (asymptote 1.5) with asymmetric attack/release plus an
additive bloom-proxy sprite. `NoToneMapping` unchanged. Tests confirm: dark at shutdown, full at
250 kW, historic pulse lights the water through the independent millisecond channel, compression
is monotonic, and the glow volume sits inside the fuel section below the surface.

### CTL-002/CTL-003 — `autoConsole.js` (unchanged this slice)

Physically separate vertical bay at `[4.9, 0, 6.2]` with exactly two hotspots
(`session.requestAuto`, `session.scram`) — no second reactor state. Both consoles' hotspots merge
into one pick list; ownership is arbitrated solely by `sessionController`. The AUTO square button
was moved off the MANUAL desk per spec §CTL-002; all MANUAL commands, ownership lamps and phase
bar are untouched.

### GLA-001/002/003 + GLA-CTRL-001/002/003 — `physicalScene.js` (unchanged this slice)

Dynamic floor bricks are real cannon boxes (mass = 1.5 × volume) created asleep at the canonical
layout, rendered as one `InstancedMesh`; damaged bricks are promoted to their own mesh with the
full crack texture so floor and grating glass share mass, friction, durability, cracks, fracture,
audio and session reset. Tier: 15 m dynamic radius desktop (~96 dynamic / 204 fixed), 10.5 m
mobile (~36) — never one immovable plane. The old `hallFloor` ring collider was replaced by the
collider of the **visible** transparent support layer (`supportInnerR 5.6 → supportOuterR 31.5`,
top −0.32), which serves floor bricks only and does not reach the pool grating (5.6 > 3.4).
Grab is a bounded servo in `world "preStep"` (velocity target `clamp((target−pos)*9, 7 m/s)`,
impulse ≤ 26 N·s at the COM): mouse sets horizontal `tx/tz`, `W/S` moves height at 2.4 m/s
clamped −10.6…11.0, `A/D` integrates yaw at 2.0 rad/s with the quaternion set from world Y only —
pitch and roll locked, no random spin, no angular velocity injected on release. While grabbing,
`W/S/A/D` are consumed by the glass and only `Q/E` reach the camera. `blur`, `visibilitychange`,
`pointercancel` and fracture all call `releaseGrab()`. Wall/ceiling glass is never in
`pickTargets()`, so it cannot be grabbed.

### Debug hooks (non-text, dispose-cleaned)

`__SOURCE_STATE__`, `__SOURCE_CMD__`, `__SOURCE_HOTSPOTS__`, `__SOURCE_ADVANCE__`,
`__SOURCE_WATER__`, `__SOURCE_CAM__`, `__SOURCE_NAV__`, `__SOURCE_CHR__`, `__SOURCE_FLOOR__`,
`__SOURCE_GLASS__`, `__SOURCE_PERF__`. These are what the next browser pass should read.

## Verification

| Check | Result |
| --- | --- |
| `./scripts/run-validation.sh` | **PASS** (configured-check status) |
| Dependency check | PASS |
| `npx vite build` | PASS — `physicalScene` chunk 751.87 kB / 201.61 kB gzip (>500 kB warning) |
| `node tests/run.mjs` | **185/185** (was 169/169 before this slice's +16 LAB checks) |
| Lint | **NOT CONFIGURED** |
| Type check | **NOT CONFIGURED** |
| Playwright MCP, 390×844 / 768×1024 / 1440×900 | **BLOCKED — NOT RUN** (see below) |

New logic checks added this slice (all passing):

- every `LAB_COMPONENTS` entry resolves upstream **and** downstream to a same-layer part, an
  underground `UG-*` part, or a declared external interface — nothing ends in mid-air;
- every ground component carries one of the four allowed source tags;
- exactly two heat exchangers exist and both are underground; the ground list contains none;
- `LAB-D01 → UG-D02` and `LAB-Q02 → UG-F03` really resolve to underground IDs;
- before unlock: ventilation speed and wheel rotation are exactly 0, rod bars at the bottom,
  scram lamp lit and power lamp dark;
- after unlock + startup + SHIM withdrawal: ventilation spins up, **rod bar height equals the
  real `rod.SHIM.pos` to 0.01**, power lamp lit, scram lamp dark, ownership lamp lit, makeup
  tank level has fallen or the makeup pump has started;
- after SCRAM: scram lamp returns immediately and all three rod bars fall back to the bottom.

### Why the browser pass is blocked

1. `npx vite preview` / `npm run preview` started with `run_in_background` do not survive the
   Bash call — a later call finds `ps aux | grep vite` = 0 and `curl` returns 000, so there is
   no origin for the browser. (Within a single call the same server answers 200, so the build
   itself serves fine.)
2. `file:///…/dist/index.html` is refused by the MCP client: *"Access to 'file:' protocol is
   blocked"*.
3. Running the server outside the sandbox (`dangerouslyDisableSandbox`) was **denied** by the
   permission gate in don't-ask mode, twice. I did not attempt to work around it.

## Not verified at all

- **All three viewports** (390×844, 768×1024, 1440×900), responsive layout and the browser
  console — never opened.
- Session reset on refresh, first-interaction activation, audio activation and audio audibility.
- Reactor-pool operation, pulse, water response and the water/Cherenkov appearance at shutdown,
  low power, 250 kW and historic pulse — verified only as numbers in Node, never rendered.
- Camera navigation in a real browser: underwater crossing, near-core approach, below-floor and
  behind-equipment viewing.
- Glass interaction feel: grating vs floor grab, mouse/`W/S`/`A/D` ownership, release physics,
  damage, fracture, refresh reset.
- **Frame rate, draw calls, triangles, awake bodies, particle counts, DPR** — `__SOURCE_PERF__`
  exists but has never been read in a browser.
- **Transparent sort order** between wall/ceiling glass, floor bricks, water transmission,
  caustics and additive Cherenkov — the highest visual risk, still unrendered.
- Underwater `FogExp2` does not affect `ShaderMaterial` layers (caustics, plume, Cherenkov);
  accepted as a deliberate abstraction, appearance unchecked.
- The new ground equipment has **no colliders** (consistent with the pre-existing crane, ducts
  and cabinets). Grabbed glass passes through it.

## Deliberate abstractions

- Ground equipment stands on plinths through the glass floor: the floor bricks read as removable
  access panels, so a brick can be taken out from under a cabinet without the cabinet moving.
- The makeup tank/pump state machine is a plausible-but-invented operating rule
  (`TRIGA_ANALOGUE`); no Pavia source fixes those setpoints.
- Cherenkov particles are a `TUNED_PRESENTATION` light-transport proxy, not per-particle physics.
- The transparent floor support layer, the glass-brick building and the free traversing camera
  are `SOURCE_ART_DIRECTION`, not Pavia building facts.

## Open gaps

- `LAB-G01` — per-unit underground coordinates remain `REALTIME_PROXY`; no Pavia as-built
  drawings exist. Unchanged.
- `LAB-G02` — ground-floor equipment carries no collision geometry.
- `LAB-G03` *(new)* — makeup/ventilation setpoints are invented operating rules, not sourced.
- `WTR-G01` — no volumetric light transport; absorption is transmission thickness above water
  and `FogExp2` below, caustics are a curvature proxy.
- `CHR-G01` — handled by the `TUNED_PRESENTATION` particle system.
- `CAM-G01`, `GLA-G01` — instancing, tiering and sleep are in place but **unmeasured**.
- `PERF-G01` *(new)* — the `physicalScene` chunk is 751.87 kB (201.61 kB gzip); no code
  splitting attempted.

## Handoff focus for the next REVIEWER

1. **The browser pass is the entire remaining risk.** Please establish an origin the MCP browser
   can reach (a preview server started outside the agent's sandbox, or an MCP config that allows
   `file:`), then drive `__SOURCE_NAV__`, `__SOURCE_CMD__`, `__SOURCE_ADVANCE__`,
   `__SOURCE_PERF__`, `__SOURCE_FLOOR__` and `__SOURCE_GLASS__` in one pass across the three
   viewports. Everything visual in this report is unconfirmed until then.
2. Highest visual risk: transparent render order and over-draw — glass walls + ceiling + floor
   bricks + water transmission + additive Cherenkov have never been composited on screen.
3. Second risk: ~96 dynamic floor-brick bodies plus the grab servo in `preStep`; confirm bricks
   stay asleep at rest and the servo cannot tunnel or fling.
4. The ground-floor heat exchanger → makeup-skid substitution is a **topology correction**, not a
   feature swap; check it against `REACTOR_POOL_SYSTEM.md`'s locked two-heat-exchanger rule
   before judging it as scope drift.
5. Housekeeping: a stray zero-byte file `.agent/&1` (an errant shell redirect from an earlier
   round) is committed. `.agent/` is protected for me, so I left it — it needs an owner-side
   `git rm`.
