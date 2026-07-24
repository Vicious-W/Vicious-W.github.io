# Agent Implementation Report

IMPLEMENTATION_STATUS: REPORTED

- Task: `source-reactor-pool-physics-2026-07-23`
- Formal-cycle position: owner-directed checkpoint outside the numbered cycle; formal
  review remains round 1 of at most 3 but is paused pending resolution of the manual-versus-
  automatic operation conflict recorded in `PROJECT.md`
- Base commit: `014c287ab5ea10b09acde8f5fb9f3fd469b3b0f5`
- Checkpoint commit: `d139c6e73b9e5c2c3bbc304afa1a6a3cea2e0b6b`
  (`checkpoint: preserve owner-directed SOURCE expansion`)
- Working tree at checkpoint: clean
- Implementer runtime: claude / opus-4.8 / (interactive owner-directed session)

## 1. Context for this round

Earlier owner-directed work unblocked browser verification and fixed three severe defects
(kept in §7 for history). This checkpoint records a further **scope expansion** with four
requirements:

1. The scene was only the reactor pool + glass on a black void. Build a **real reactor
   laboratory** around it, fully modeled in 3-D with realistic physical processes, and add
   a **control area the user can left-click to operate the reactor**.
2. **Right mouse button held → camera orbit.**
3. **Scroll wheel → zoom.**
4. Make the physics modeling and physical processes **finer, more real, more complex**.

No protected-control-plane files were modified.

## 2. Owner decisions this round

Collected explicitly before implementing:

- **Control mode: full manual operation.** The console drives a live reactor model
  (startup → withdraw rods to critical → raise power → fire a pulse → SCRAM). The old
  forced automatic 8-phase program is **removed**, not merely bypassed.
- **Console controls: all four groups** — START/SCRAM, three control rods withdraw/insert,
  pulse fire, coolant pump / mode.
- **Lab scope: all four** — room shell, console area, plant equipment, personnel safety
  fixtures.

## 3. What was built

### 3.1 Live manual reactor model (`sessionController.js`, rewritten)

The scripted `PHASES` sequence is replaced by `MODES = ["SHUTDOWN","OPERATE","PULSE"]` and
an operator command API (`startup`, `scram`, `setMode`, `pumpToggle`, `rodStart`, `rodStop`,
`pulseFire`) called directly by console clicks. Physics now integrated per frame:

- **One-group point kinetics normalized in dollars** (`ρ$ = ρ/β`), integrated at a **fixed
  1/240 s substep** so behaviour is frame-rate independent, with a source term so the
  subcritical reactor sits at a real source-multiplication level rather than exactly zero.
- **S-curve integral rod worth** `rodShape(p) = p − sin(2πp)/(2π)` per rod (SHIM 2.5$,
  REG 1.2$, TRANS 3.0$ against a 3.2$ bias), so rod motion near mid-travel is worth far
  more than near the endpoints — the reason a real startup is slow at the middle.
- **UZrH prompt negative temperature feedback** (`ALPHA_FB`), which is what makes the
  reactor self-limiting and makes a pulse terminate itself.
- **Fuchs–Nordheim pulse**: firing ejects TRANS pneumatically (eject 0.12 s → dwell 0.15 s
  → reinsert 1.1 s); peak height grows with excess², width narrows with excess, and the
  deposited fuel energy feeds straight back as negative reactivity.
- **Two-node thermal model**: fuel → pool conduction, pool → heat sink rejection scaled by
  coolant flow. Flow = pump + natural circulation driven by the fuel-pool ΔT. Turning the
  pump on therefore *rejects* pool heat (cooler pool → cooler fuel → slightly higher power),
  which is the correct causal chain; an earlier version had the pump heating the pool.
- **Interlocks**: pulse only from PULSE mode, only below 0.06 power, only with TRANS seated;
  mode changes and pulses refused while scrammed.

### 3.2 Operator console (`controlConsole.js`, new)

A 3-D console standing on the operating floor at z = +6.9, raycast-picked by left click.
Because the page may contain **no text**, controls are distinguished by colour + shape +
icon only. Hotspots carry `kind: 'button' | 'toggle' | 'hold'` with press/release
semantics, so rod switches drive continuously while held and stop on release — matching how
real rod drives work. Lamps, bar meters and the fuel-temperature indicator are driven from
the live reactor state.

### 3.3 Reactor hall (`labEnvironment.js`, new)

44 × 44 × 12 m hall, all real geometry (no backdrop images, no flat fakes): concrete floor /
ceiling / four walls, a grid of ceiling fixtures plus three point lights, bridge crane
(rails, girder, trolley, cable, hook), cable trays, wall piping, ventilation ducting, a
five-cabinet instrument rack behind the pool, the primary cooling loop (heat exchanger on
saddles, two vertical pumps on skids, loop piping — the physical counterpart of the `K_COOL`
term in §3.1), a shielded transfer cask with waste drums, instanced yellow/black hazard
striping around the pool, and a status beacon whose colour/blink and point light are driven
by reactor state (white flash on pulse, red slow blink when scrammed, amber scaling with
power).

The hall exports `HALL_BOUNDS` (camera clamps) and `HALL_COLLIDERS` (floor/wall collision
surfaces) as a **single source of truth**, so resizing the hall automatically moves both.

### 3.4 Orbit camera (`physicalScene.js`)

Spherical rig (azimuth / elevation / distance): right-drag orbits, wheel zooms. Distance
limits come from a fit-radius solve; elevation is clamped **dynamically against the hall
ceiling** (`asin(headroom / distance)`), and horizontal radius against the wall line. The
practical effect is physically right: the further you pull back, the shallower you can look
down, because you are inside a room.

## 4. Defects found by browser verification this round and fixed

### 4.1 (BLOCKER) Camera stood outside the building

The first render of the lab showed nothing but a flat blue wall. Framing a ~14-unit-wide
subject (pool at z ≈ −5 plus console at z ≈ +6.9) put the camera ~26 units back, while the
hall was only 26 wide — the camera was outside the wall shooting inward at its back face.

Fix: widened FOV 34° → 50° (camera sits closer for the same framing), tightened fit radii
(7.6 → 7.0 / 6.6 → 6.2), raised `minElevation` 12° → 22°, capped zoom-out at
`min(fit·2.2, 19)`, and enlarged the hall to 44 with a 12 m ceiling. Then found the camera
still grazed the ceiling (y = 10.95 against a 11.0 ceiling), so the elevation clamp in §3.4
was added and the ceiling raised to 12. Verified: camera now pins to y = 10.9 at max
elevation and never leaves the room at any zoom.

### 4.2 (MAJOR) Glass dragged over the railing fell forever

The railing is 0.58 m high and the drag plane is at 1.0 m, so the player legitimately *can*
lift a cube over it. There was no collider under the visible concrete floor, so a cube
dropped outside the walkway accelerated indefinitely: measured speed 1.49 → 3.99 → 6.02 m/s
still climbing at +7 s, never sleeping.

Fix: added hall floor and wall colliders backing the **visible** concrete. Deliberately
*not* an infinite `CANNON.Plane` — that would also cut across the pool interior and hold
sinking glass at −0.06, and is exactly the invisible-collision-plane pattern the spec
forbids. Instead the floor is a ring of 32 box segments starting at the walkway outer edge,
with outer radius 1.5× the wall line so the square hall's corners are covered
(1.5 ≥ √2). Verified: the cube now lands at y = 0.44 (slab top + half cube), peaks at
2.51 m/s and decays to 0.48, `below = 0`.

### 4.3 (MINOR) Rod-drive cables read as rendering artifacts

At `0x141414` against the mid-grey hall the cable tubes rendered as hard black lines that
looked like scratches on the screen. Changed to a dark grey rubber-sheath material
(`0x2c3138`, metalness 0.3) so they read as cables at distance.

## 5. Verification performed

Server: `python3 -m http.server 8099` in `dist/`, started with `dangerouslyDisableSandbox`
(see §7). All interactive checks via Playwright MCP with **real mouse events** at
raycast-projected hotspot coordinates — not by calling the command API directly — so the
click → raycast → hotspot → command → physics path is exercised end to end.

Debug hooks (read-only, non-text, all deleted in `dispose()`): `__SOURCE_STATE__`,
`__SOURCE_GLASS__()`, `__SOURCE_CAM__()`, `__SOURCE_CMD__`, `__SOURCE_HOTSPOTS__()`.

| Check | Result |
| --- | --- |
| Right-drag orbits | azimuth 0 → −0.72 rad, elevation 0.59 → 0.38 rad |
| Wheel zooms | in: dist 19 → 9.42; out: clamped at 19, camera stays inside walls |
| Camera never leaves the hall | max elevation pins camera at y = 10.9 (ceiling 12.0); horizontal radius 17.6 < wall 21.1 |
| All 11 hotspots hit-testable | `onScreen: true` for every control at 390×844, 768×1024, 1440×900 |
| START | SHUTDOWN → OPERATE, `scrammed` cleared |
| Pump | `pumpOn` true, flow 0 → 0.6, pool temp falls 0.12 → 0.079 |
| Rod withdraw (hold) | SHIM 0 → 1.0, REG 0 → 0.70 while held; stops on release |
| Approach to critical | ρ −3.20 → −0.22 (subcritical, source level) → +0.24$ |
| Delayed supercritical rise | power 1e-5 → 2e-5 → 4e-5 → 8e-5 → 1.5e-4 on a stable positive period |
| SCRAM | rods dropped to 0, ρ → −3.28, power decays; mode → SHUTDOWN |
| Interlocks | mode toggle and pulse fire while scrammed both correctly refused (`pulseId` stays 0) |
| Pulse (full chain) | mode → PULSE armed; fire → `pulseId` 1, TRANS 0 → 1 → 0, peak pulse power 0.624, fuel temp 0.12 → 0.554 (self-limiting deposit), pool 0.12 → 0.271 as heat transfers, fuel then cools to 0.336 |
| Pulse does not shatter canonical layout | glass stays 21 INTACT, minDurability 1.0 |
| Glass drag still works | drag/drop moves cubes, one taken to MICRO_DAMAGED (0.67) by the drop — expected at that height |
| Glass off the walkway settles | lands at y = 0.44, speed decays to 0.48, `below = 0` (§4.2) |
| Console output | **0 errors, 0 warnings** at 1440×900 after load |

- `npm run build`: **PASS** (exit 0; `physicalScene-*.js` ~690 kB / 183 kB gzip — three.js +
  cannon-es baseline).
- Node harness (`.agent/artifacts/node-check.mjs`, ignored artifact): **PASS**, extended
  this round with the reactor driver rewritten for the manual model (8 reactor groups) plus
  six new hall/camera invariants that pin the two §4 defects — max zoom stays inside the
  walls, the camera limit is inside the wall collider, the floor ring covers the square
  corners, the slab sits below the walkway.

## 6. Unverified / carried-forward

- **Frame rate on owner hardware.** Headless SwiftShader runs this scene at **1.4 fps**
  (1440×900) / 2.5 fps (390×844). Because `dt` is clamped to 0.05 s to keep the solver
  stable, simulated time there advances ~8–15× slower than wall time; every physics result
  in §5 was measured under that slowdown and is directionally correct but slow. On a real
  GPU at 60 fps no clamping occurs and the sim runs at true speed. **The owner should
  confirm smoothness on hardware** — the lab adds substantial geometry and three point
  lights, and the hall is the one thing here that could plausibly cost real frames.
- **Pulse → grating jolt measured at 0.013 deflection / 0.035 cube speed.** The oscillation
  period is ≈0.19 s while frames were 0.4 s apart, so the true peak is almost certainly
  undersampled; the inline estimate of ≈0.03 was not re-measured at a real frame rate.
- **`prefers-reduced-motion: reduce`** still not rendered end-to-end (needs
  `page.emulateMedia`, not exposed by the current MCP tool set). The reduce-motion paths in
  the new console and lab are reasoned + build-covered only.
- **Player-driven fracture** was not forced this round; the damage → fracture path is
  covered by the harness, and a single drag-release is intentionally below threshold.
- REALTIME_PROXY items unchanged: fuel elements are still single cylinders (no cladding /
  active-fuel / end-graphite split, RP-G02), and grating spring constants + pulse impulse
  magnitudes (RP-G04) are tuned for a bounded visible response, not against a measured Pavia
  bridge spectrum. Rod worths, bias and feedback coefficients are likewise normalized
  proxies chosen to make a manual startup take a plausible ~30 s, not Pavia-calibrated.

## 7. For the REVIEWER

- The Playwright MCP path **does work** in this environment — the round-1/2 conclusion that
  the browser was unreachable was wrong. Root cause: each *sandboxed* Bash call runs in its
  own network namespace, so a server started by a normal backgrounded Bash call is
  unreachable from later calls and from the browser process. Start the dist server with
  `dangerouslyDisableSandbox: true`, then `browser_navigate http://127.0.0.1:8099/index.html`.
- Drive the console with **real mouse events at `__SOURCE_HOTSPOTS__()` coordinates**; using
  `__SOURCE_CMD__` skips exactly the raycast layer most likely to break.
- Highest-value re-checks: (a) frame rate and readability on real hardware, since that is
  the one thing this environment cannot measure; (b) the camera cannot be driven outside the
  hall at any azimuth/elevation/zoom combination; (c) glass can never reach a state where it
  falls without landing; (d) the reactor cannot be put into a physically absurd state
  through the console (e.g. pulse while at power, or power rise while scrammed);
  (e) reduced-motion, which remains unrendered.
- Round-2 fixes retained and still passing: glass damage thresholds re-derived to real world
  units; glass seeded only on the grating disc with deck/rail colliders replacing the
  forbidden invisible tile grid; `setScale` removed so physics and visuals share one
  coordinate system; per-body damage debounce.
- Base commit: `014c287ab5ea10b09acde8f5fb9f3fd469b3b0f5`. Implementer runtime:
  claude / opus-4.8.
