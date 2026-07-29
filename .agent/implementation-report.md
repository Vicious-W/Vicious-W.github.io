# Agent Implementation Report

IMPLEMENTATION_STATUS: PARTIAL_STOPPED_BY_BUDGET_GUARD

- Task: `source-lab-optics-free-camera-2026-07-28`
- Implementation round: 1 of 2
- Base commit: `35d889967462bfd981a99b2e276890e190b6b3e4`
- Round review base commit: `3a91731f7f2fd4ec76624ca4536bc3cb599cdaac`
- Implementer runtime: claude / opus / max
- Latest verdict handled: `NOT_REVIEWED` (no Blocker/Major existed)

## Honest status first

The neutral USD budget guard consumed the slice during the read + design phase of a very
large scope. Feature work stopped early **on purpose** to leave a coherent, building
filesystem state. Two of the required subsystems are implemented and wired; the rest is
**not started**. Nothing in this report claims work that was not done.

`./scripts/run-validation.sh` → **PASS** (Dependency PASS, Build PASS, Tests PASS
132/132, Lint NOT CONFIGURED, Type check NOT CONFIGURED).
Browser verification: **NOT RUN** — no Playwright MCP pass was performed this round.

## What was actually implemented

### LAB-003 / LAB-004 — `src/scenes/reactor/undergroundPlant.js` (new, wired)

Full three-dimensional underground equipment vault (`UNDERGROUND_BOUNDS`:
ceiling −0.45, floor −9.2, half 19.5, shield clearance 5.35). 25 components are
declared in the exported `PLANT_COMPONENTS` table with source tag and explicit
upstream/downstream, so no pipe ends in mid-air:

- `UG-P01/V01/H01/P02` primary pool suction → isolation valve → HX1 → pool return,
  penetrating the shield at y ≈ −6.0 with sleeves and bolted flanges;
- `UG-K01/K02/T01/H02` intermediate closed loop: two pumps on concrete plinths,
  surge tank, HX1 and HX2 with saddles/heads;
- `UG-V02/X01` tertiary interface: insulated run, valve, wall sleeve + flange,
  flow and temperature gauges with state-driven needles;
- `UG-F01…F03/S01/S02` purification: filter, two ion-exchange columns, sample line,
  sample cabinet with water-quality proxy screen;
- `UG-D01…D03` drain trench with grating, sump pit, leak-collection funnels,
  sump pump driven by an explicable level state machine;
- `UG-A01…A03` TRANS air receiver, regulator/valve manifold, riser through the slab;
- `UG-E01/E02` cable galleries (rigid conduit vs. flexible cable, different sections),
  copper grounding bar and straps;
- `UG-R01/R02` rabbit / hot-cell pneumatic transfer run (LENA `SOURCE_VERIFIED` fact,
  routing `REALTIME_PROXY`).

State links (LAB-004): pump shaft/fan rotation and run lamps from `coolantFlowProxy`
(flow 0 ⇒ geometry actually stops), valve stems/handwheels from flow and pool ΔT,
HX shell emissive from loop ΔT, flow beads phase-advance only when flow > 0,
air-receiver gauge from `rod.TRANS.pos`, sump pump from an integrated level state,
underground lighting from `state.unlocked`. `snapshot()` exposes a read-only probe.

Source tags: `SOURCE_VERIFIED` (three-loop / two exchangers / underground pneumatic
transfer), `TRIGA_ANALOGUE` (purification columns, sump, receiver),
`REALTIME_PROXY` (every coordinate and enclosure shape — LAB-G01 stays open).

### GLA-001 / GLA-002 / GLA-003 — `src/scenes/reactor/glassArchitecture.js` (new, wired)

`SOURCE_ART_DIRECTION`. Exports `GLASS_ARCH` constants and `floorBrickLayout()`.

- Walls: 4 × 128 instanced `RoundedBoxGeometry` glass bricks (2.75 × 1.5 × 0.32) with
  real thickness, inner/outer faces, transmission (ior 1.52) and separate instanced
  joint beams — joints are geometry, not a texture;
- Ceiling: 256 instanced bricks (2.75 × 2.75 × 0.30) plus a joint grid;
- Transparent structural support layer: continuous, untextured, ring from r 5.6 to 31.5
  at y −0.32, with rim — serves floor bricks only;
- Floor brick layout: canonical grid (cell 2.4, brick 2.26 × 0.26 × 2.26), pool
  clearance r < 6.2 removed; `dynamicFloorRadius` splits grabbable bricks from
  instanced fixed bricks as the GLA-003 performance tier (13 m on viewports < 820 px).

`labEnvironment.js` no longer draws the opaque concrete floor, walls or ceiling —
those are now the glass-brick building.

## What is NOT implemented (all still open for round 2)

- **CAM-001/002/003** — free camera untouched; the orbit rig still clamps azimuth-free
  but elevation ≥ 22°, distance ≤ 19, and to hall headroom. No fly, no pan, no
  underwater/underground traversal, no home-framing reset.
- **GLA-002 dynamic floor bodies** — the layout exists but **no cannon bodies are
  created**; floor bricks are not yet rendered or grabbable, and the old `hallFloor`
  ring collider at y −0.06 is still the floor. The support-layer collider is not added.
- **GLA-CTRL-001/002/003** — grabbing is still the old point-to-point drag at a fixed
  lift plane with random rotation allowed; no W/S, A/D, pitch/roll lock or input
  ownership.
- **WTR-001/002/003** — `waterSystem.js` unchanged (opaque-ish shader surface, no
  depth absorption, caustics, underwater fog or plume refraction).
- **CHR-001/002/003** — no particle proxy, no core-attached volume rework, no exposure
  control; still the two additive discs.
- **CTL-002** — no AUTO console; MANUAL console unchanged (CTL-001 preserved).
- **LAB-001/002 refinement** — hall interior beyond the glass shell is unchanged.
- No new regression tests were added; `tests/run.mjs` is untouched and still asserts the
  **old** camera constants (`CAM_MAX_DISTANCE 19`, `CAM_MIN_ELEVATION 22°`,
  `FLOOR_RING_FACTOR 1.5`). Round 2 must update that block when the free camera lands.

## Known consequences of stopping here

1. The glass ceiling and walls now exist but the camera is still clamped inside the hall,
   so the default framing looks through wall/ceiling glass — appearance is unverified.
2. The underground vault is built but, with no floor gap and no free camera, it is
   effectively unreachable and largely unseen at runtime.
3. Transparent-object sorting between architectural glass, water and pool structures is
   completely unverified; over-draw and z-order regressions are plausible.
4. Frame rate, draw calls, triangles, active bodies and particle counts were **not**
   measured at any viewport.

## Verification

| Check | Result |
| --- | --- |
| `npm run build` | PASS |
| `npm test` | PASS — 132/132 logic checks |
| Lint / Type check | NOT CONFIGURED |
| Playwright MCP 390×844 / 768×1024 / 1440×900 | NOT RUN |
| Browser console | UNVERIFIED |
| Audio, camera, water, glass, dual console flows | UNVERIFIED |

## Open gaps

`LAB-G01` (no Pavia as-built drawings — layout kept `REALTIME_PROXY`, topology real),
`LAB-G02` (glass building is `SOURCE_ART_DIRECTION`) are handled as designed.
`WTR-G01`, `CHR-G01`, `CAM-G01`, `GLA-G01` are **untouched** because their subsystems
were not started.

## Handoff focus for the next REVIEWER

1. Confirm the two new modules are structurally sound and that
   `PLANT_COMPONENTS` upstream/downstream really matches the built geometry.
2. Confirm `labEnvironment.js` losing its floor/walls/ceiling did not orphan colliders
   or leave the hall visually broken — this is the highest-risk change of the round.
3. Do **not** treat any `CAM-*`, `WTR-*`, `CHR-*`, `CTL-002`, `GLA-CTRL-*` item as
   attempted; report them as not implemented rather than as defects.
4. The round-2 implementer must be given the full remaining list above as mandatory work.
