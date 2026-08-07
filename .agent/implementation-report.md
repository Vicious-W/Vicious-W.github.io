# Agent Implementation Report

IMPLEMENTATION_STATUS: COMPLETE

VERDICT_ADDRESSED: CHANGES_REQUIRED — valid Major findings `R-001` and `R-005` are addressed.

## Metadata

- Task: `fly-foundation-hot-air-balloon-v1-2026-07-31`
- Implementation round: 3 (absolute target for this parent run: 4)
- Implementation segment: 1
- Base commit / current HEAD: `28a10b0b378876458808dcf7d57c5e3b29fe63e9`
- Round review base commit: `8e7f656714b173e89356da5b06c7c663780830ec`
- Implementer runtime: codex / gpt-5.6-sol / ultra
- Role session: pending (new), generation 1
- Run manifest: `.agent/artifacts/runs/implementation-r3-s1-20260807T180154Z-26985.env`
- Scope: remaining round-two FLY review corrections only. SOURCE business logic, completed scenes,
  protected specifications, collaboration control files, and validation scripts were preserved.
- Git ownership: no stage, commit, push, deploy, reset, clean, rebase, branch switch, or history write
  was performed. The neutral wrapper owns the checkpoint.

## 1. Outcome and review findings

The configuration space now enumerates injected registries into keyed 3D preview collections and
propagates the confirmed IDs into the authoritative session. AUTO_RECOVERY no longer replaces a
missed plan after landing: plans have stable IDs, low final-approach mismatches are replanned before
contact using a physical contact horizon, contact episodes bind to the responsible pre-contact plan,
and only that plan can receive `actualLanding` after three seconds of stable safe contact.

| Review ID | Result | Acceptance evidence |
| --- | --- | --- |
| `R-001` Major | RESOLVED | `SAFE_CONTACT_LOCK` and its post-contact plan constructor were deleted. Every installed plan has a monotonic ID; contact records bind that ID; completion resolves the bound history entry. Seed `0x1234` recovers in 96 simulated seconds with plan `recovery-plan-8`, plan time `103.300 s`, first final contact `120.575 s`, stable completion `123.575 s`, error `25.675 m`, matching region `2,0`, and no post-contact lock. Four deterministic journeys remain safe and bounded. |
| `R-005` Major | RESOLVED | `createFlyScene` accepts injected registries, enumerates every definition into keyed vehicle/weather preview maps, lays out all slots, tags all raycast targets by registry ID, synchronizes selection across every preview, and supplies the same registries and selected IDs to session construction. A two-weather/two-vehicle fixture generates four independently placed, ray-hittable entries, switches all compatible IDs, confirms the second pair, and creates a session whose snapshot retains that pair. Production still registers only real `clear` / `hotAirBalloonC100` options. |

## 2. Changed component IDs and files

| Component ID | Files | Round-three change |
| --- | --- | --- |
| `FLY-CONFIG-001` | `src/scenes/fly/configPreview.js`, `flyScene.js`, `registry.js` | Generic preview catalog, wrapper slots, keyed collections, generic layout/update/dispose, bidirectional compatibility controller, injected scene registries/session factory, per-ID debug targets, and default registry bundle. |
| `FLY-SESSION-001` | `src/scenes/fly/flySession.js` | Injected registry lookup, bidirectional compatibility validation, immutable selected IDs in state/snapshot, and selected-definition factory construction. |
| `FLY-REC-001` | `src/scenes/fly/flySession.js`, `recovery/recoveryPlanner.js` | Monotonic plan IDs, contact-attempt binding, pre-contact `APPROACH_MISMATCH` replans, mismatch takeoff command through the real burner, stable-contact completion against the bound plan, and removal of post-contact plan replacement. |
| `FLY-TEST-001` | `tests/run.mjs` | Two-by-two registry fixture with enumeration/layout/raycast/switch/session checks, explicit rejection of `SAFE_CONTACT_LOCK`, plan-ID/first-contact timing checks, and fixed seed `0x1234` regression. Total is now 400 checks. |
| `PROJECT-FACT-001` | `PROJECT.md` | Current fact now records that round three addressed the recovery-attribution and registry-expansion findings and is awaiting review. |

No SOURCE business file, style file, package manifest, dependency lockfile, protected engineering
specification, Agent control script, or collaboration control file was changed.

## 3. Sources, geometry, and proxy labels

No new aircraft, weather, terrain, or material fact was introduced. Existing sources and labels remain:

- Cameron C-Type official data for the 16 gores, 100,000 ft³ volume, 65 ft height, 57 ft diameter,
  2,000 lb certified limit, and 218 lb standard envelope weight (`PRIMARY_SOURCE` plus direct
  `DERIVED` SI conversions).
- Cameron same-product-family burner/tank pages and the FAA Balloon Flying Handbook for the
  `FLY_REFERENCE_CONFIGURATION` lower system and operating relationships.
- U.S. Standard Atmosphere 1976 for the clear-weather atmospheric baseline.
- `ENGINEERING_PROXY` remains the label for lower-system masses, lumped thermal coefficients,
  suspension/contact coefficients, procedural world/obstacles, wind field, and recovery forecast.
- `SOURCE_VERIFIED` / `SOURCE_ART_DIRECTION` facts were not altered.

Round-three geometry is configuration-space presentation geometry, not aircraft geometry:

| Geometry / layout | Representation | Label and consumers |
| --- | --- | --- |
| Preview slot | One neutral `THREE.Group` per registry definition; child preview keeps its own geometry and tagged meshes/lines | `ART_DIRECTION`; scene enumeration, layout, raycast, selected visual, disposal |
| Single production vehicle slot | `(0, 0, 0)`, scale `1` | Preserves the accepted C-100 preview position |
| Single production weather slot | portrait `x=-12.5`, other `x=-18`, `y=8.5`, `z=-1.5`, scale `1` | Preserves the accepted clear-weather preview position |
| Multiple vehicle slots | centered spacing `12 m` portrait / `15 m` other, scale `0.62 / 0.70` | `ART_DIRECTION` generic expansion rule; no physical-world meaning |
| Multiple weather slots | centered spacing `6 m` portrait / `8 m` other, scale `0.78` | `ART_DIRECTION` generic expansion rule; no physical-world meaning |

The C-100 envelope, basket, suspension, obstacles, terrain collision, camera, and SOURCE geometry were
not changed in this round.

## 4. State and causality links

### Registry selection

```text
registry key / definition.id
  → previewFactory for every entry
  → wrapper slot + mesh/line userData { configKind, configId }
  → shared raycast selectable collection
  → bidirectional compatibility controller
  → selected weatherId / vehicleId
  → model-specific guideDefinition
  → sessionFactory({ selection, registries })
  → selected weatherFactory + vehicleFactory
  → immutable session snapshot.selection
```

- Blank canvas hits still leave `null / null / false`.
- Both weather-to-vehicle and vehicle-to-weather compatibility lists must agree.
- The main scene contains no lookup of `DEFAULT_FLY_SELECTION`; the default remains only for direct
  session construction/tests.
- The debug target API retains legacy first-entry targets and adds `weatherById` / `vehicleById`, so
  real pointer evidence can address every registered preview.
- Preview catalog disposal removes each wrapper and calls every preview's existing dispose exactly
  within the scene lifecycle.

### Recovery attribution

```text
planBalloonRecovery (writesPose:false)
  → recovery-plan-N + history entry
  → low descending mismatch check before contact
  → optional APPROACH_MISMATCH plan using 12–40 s contact horizon
  → recoveryControls burner / vent only
  → physical basket contact episode binds current plan ID
  → 3 s safe stable contact + region/tolerance match
  → actualLanding written to that bound history entry
  → RECOVERED
```

- `actualLanding.approachPlanId`, `firstContactAt`, and `landedAt` make ordering auditable.
- A nonmatching physical contact cannot complete recovery. While that contact persists,
  `recoveryControls` commands burner `0.72` and vent `0`; it must physically lift and continue.
- Replanning is disabled while the basket reports contact. Normal periodic replans occur airborne;
  final low-altitude mismatch replans require `!contact`, AGL below `18 m`, vertical velocity below
  `0.35 m/s`, an unmatched region/tolerance, and at least `2 s` since the previous plan.
- The forced approach time budget is derived from current AGL and descent speed, clamped to
  `12…40 s`; it replaces the stale long-range deadline only for this final-approach case.
- Position, velocity, attitude, terrain, wind, and collision state remain owned by the authoritative
  `1/120 s` vehicle/world step. Every plan still records `writesPose:false`.

The `18 m`, `0.35 m/s`, `2 s`, `12…40 s`, and `0.72` command values are calibrated
`ENGINEERING_PROXY` control parameters, not Cameron certification data.

## 5. Deliberate abstractions and open gaps

The first-slice gap IDs remain open and unchanged:

- `FLY-GAP-001` — Public product data does not provide a complete serial lower-system mass/inertia
  schedule; manifest proxy values remain explicit.
- `FLY-GAP-002` — Internal air remains lumped and suspension/basket dynamics are bounded low-DOF;
  there is no CFD, rope FEM, wicker deformation, or full fabric FEM.
- `FLY-GAP-003` — Obstacles remain deterministic analytic collision proxies; there is no geospatial
  fidelity, destructive response, or distributed canopy-to-obstacle cloth contact.
- `FLY-GAP-004` — Clear sky, clouds, sun, and haze remain atmospheric/art proxies rather than a
  spectral or mesoscale weather solve.
- `FLY-GAP-005` — The production bundle is `840.40 kB / 233.06 kB gzip`; Vite reports the existing
  non-fatal `>500 kB` warning. Code splitting remains an optimization opportunity.
- `FLY-GAP-006` — WebAudio lifecycle/state is verified; actual loudspeaker timbre, spatial mix, and
  loudness remain unverified.
- `FLY-GAP-007` — Full WebGL context loss/restoration was not replayed in this round.

The two-by-two registry fixture deliberately clones the existing clear/C-100 factories under test IDs.
It proves automatic expansion and ID propagation without presenting nonexistent production choices or
claiming a second implemented weather/vehicle.

## 6. Performance and lifecycle

- Fixed physical step remains `1/120 s`; no second clock or physical world was added.
- Preview work remains one vehicle plus one weather in production. Catalog work is linear in registered
  entries and uses existing preview update/dispose functions.
- Recovery plan history and contact-attempt evidence are each bounded at 64 records; plan lookup is
  bounded by that history during contact.
- The final build still transforms 45 modules. The JS bundle is `840.40 kB / 233.06 kB gzip`.
- All three browser journeys performed 8 origin shifts and used 7 final-run recovery plans, with zero
  unsafe contacts and no pose teleport.
- After each recovered FLY was disposed and a fresh FLY was entered, the active config reported one
  RAF, zero physics worlds, 30 scoped listeners, zero audio voices, zero chunks, null selection, and
  no session. Counts were `created={SITE_SELECT:2,FLY:2}` /
  `disposed={SITE_SELECT:2,FLY:1}` with only the fresh FLY active.
- The final desktop lifecycle returned to SITE_SELECT after fresh SOURCE disposal; SOURCE debug/audio
  hooks were absent and created/disposed counts paired for the completed sessions.

## 7. Verification

### Standalone validation — PASS

Final standalone command: `./scripts/run-validation.sh`

| Check | Result |
| --- | --- |
| Dependency check | PASS |
| Build | PASS — Vite 8.1.0, 45 modules, `840.40 kB / 233.06 kB gzip`; existing non-blocking chunk warning |
| Tests | PASS — 400/400 |
| Lint | NOT CONFIGURED |
| Type check | NOT CONFIGURED |
| Browser / visual in script | MANUAL REQUIRED; completed with Playwright MCP below |

`git diff --check` is PASS. Focused logic evidence includes the two-by-two registry fixture, per-entry
raycasts, compatibility switching, selected-session IDs, all previous fixed-step/atmosphere/world/
thermal/contact tests, four deterministic recovery journeys, plan pose immutability, and explicit
plan-ID contact ordering.

Deterministic recovery results:

| Journey | Recovery time | Result |
| --- | ---: | --- |
| seed `0xc1002026` | 204 s | safe FIELD, error `42.09 m`, no unsafe contact |
| seed `0x1234` | 96 s | region `2,0`, error `25.675 m`; plan `103.300 s` < first final contact `120.575 s` < completion `123.575 s` |
| seed `0x7788` | 346 s | safe FIELD, same landing region, error `51.76 m`, no unsafe contact |
| seed `0x5eedc0de`, three-origin high journey | 330 s | safe FIELD, error `35.62 m`, no unsafe contact |

### Consolidated Playwright MCP pass — PASS with platform-warning caveat

The final built `dist/` was served only by `page.route('**/*')` at
`http://source.local/index.html`. The route accepted only that synthetic origin, decoded path
segments, rejected empty/`.`/`..`/backslash/NUL traversal, used files strictly below `dist/`,
preserved MIME types, and aborted missing files. No Vite, preview, or HTTP server was started.

The MCP initially lacked its configured Chromium binary. Its prescribed
`npx @playwright/mcp install-browser chrome-for-testing` command installed Chromium v1237 in the
writable Playwright cache without changing project dependencies; the consolidated pass then ran.

| Evidence | Result |
| --- | --- |
| Responsive | `390×844`, `768×1024`, and `1440×900` canvases exactly matched their viewports; overflow was `0/0`. Guide boxes were `370×581.531`, `680×417.156`, and `680×478.125`, all fully contained. |
| Actual configuration hits | Each viewport began null/null/false; a blank click stayed null/null/false. Pointer clicks at the per-ID projected weather, vehicle, and confirm targets produced `clear / hotAirBalloonC100 / true`, opened the guide, and created a session with those IDs. |
| Guide boundary | Guide focus was on the depart action; canvas and flight controls were inert at all three sizes. Mobile screenshots show readable, contained content. |
| First gesture/audio | Before departure: `contextState:NONE`, 0 voices. Depart gesture: `running`, 4 voices. |
| Mobile/tablet touch | A 28 s touch burner hold changed fuel `76 → 70.61637 / 70.60997 kg`, raised AGL to `11.40 / 11.47 m`, and released to `0/0`. A 3 s touch vent hold changed `361.046 → 355.544 K` / `361.109 → 355.519 K` with fuel exactly unchanged and release at `0/0`. |
| Desktop keyboard | Space burn changed fuel `76 → 70.60038 kg` and AGL to `11.66 m`; V vent changed `361.248 → 355.535 K` with fuel unchanged; both released to `0/0`. |
| Physical recovery | Touch runs reached RECOVERED after `170 s`; desktop after `164 s`. All three had safe contact, `≥3.95 s` stable contact at snapshot, zero unsafe contacts, 8 origin shifts, no post-contact lock, and landing errors `29.79 / 37.43 / 30.25 m` bound to pre-contact plan IDs. |
| Session reset | Escape after recovery disposed the journey; re-entering FLY produced null/null/false, no session, no physical world, no voices, and no chunks. |
| SOURCE regression | Fresh SOURCE began `NONE / INTERLOCKED_RESET / unlocked:false`; first pointer interaction produced `AUTO / INTERLOCKED_RESET / unlocked:true` and both audio chains `running`; returning removed SOURCE state/audio hooks. |
| Browser console | 0 page errors and 0 application console errors/warnings. Chromium emitted four non-fatal WebGL driver performance warnings (`GPU stall due to ReadPixels`) while screenshots were captured; no shader, scene, or application failure occurred. |

Useful ignored screenshots:

- `.agent/artifacts/fly-evidence/r3-390-guide.png`
- `.agent/artifacts/fly-evidence/r3-768-guide.png`
- `.agent/artifacts/fly-evidence/r3-1440-recovered.png`

## 8. Failures, unverified areas, and remaining risks

- Configured validation failures: none.
- Final browser flow failures: none.
- Lint: NOT CONFIGURED.
- Type check: NOT CONFIGURED.
- The first browser launch attempt was UNVERIFIED because Chromium v1237 was absent; this
  environment issue was resolved with the MCP-prescribed cache install before the successful pass.
- Actual speaker output/spatial mix remains UNVERIFIED (`FLY-GAP-006`).
- WebGL context loss/restoration remains UNVERIFIED (`FLY-GAP-007`).
- SOURCE deep MANUAL commands, intentional glass fracture/debris, and underwater/underground camera
  traversal were not replayed in the browser; protected SOURCE logic tests remain green and its
  first-interaction/lifecycle path passed.
- Chromium's screenshot-related `ReadPixels` performance warnings remain an environment caveat, not
  an application console error. A reviewer using another GPU/backend may not reproduce them.
- The recovery controller is an explicit first-slice engineering proxy, not certification software;
  the bounded physical/model gaps in `FLY-GAP-001…004` remain.

## 9. Exact handoff focus for the next REVIEWER

1. Reproduce `R-001` with seed `0x1234` and `0.25 s` advances. Confirm no history reason is
   `SAFE_CONTACT_LOCK`; locate the history entry with `actualLanding`; verify its ID equals
   `approachPlanId`, its plan time precedes `firstContactAt`, stable completion is at least three
   seconds later, and actual region/tolerance matches. Force or inspect a mismatched contact and
   confirm AUTO_RECOVERY remains active and commands a physical burner lift rather than rewriting a
   plan.
2. Reproduce `R-005` with two weather and two vehicle fixture definitions. Without changing
   `flyScene.js`, verify four catalog slots/selectable ID sets, distinct layout, raycast hits,
   compatible switching, confirmation, and session `snapshot.selection` for the chosen second pair.
   Confirm production still exposes only `clear` and `hotAirBalloonC100`.
3. In the real built page, use `configTargets.weatherById` / `vehicleById` for actual pointer hits,
   then verify blank-hit rejection, guide focus/inert state, selected IDs, first-gesture audio, touch
   and keyboard control release, and safe recovery at all three required viewports.
4. Confirm recovered FLY disposal resets selection/session/resources and SOURCE still starts locked,
   unlocks on first interaction, and removes all debug/audio hooks on return.
5. Distinguish any Chromium GPU-driver `ReadPixels` performance warning from application console or
   shader failures; report both categories exactly.

Treat `FLY-GAP-001…007` only as the explicitly bounded first-slice risks above. Do not reinterpret
the fixture as a claim that a second production weather or vehicle exists.

## Automation wrapper result

- Process base commit: `28a10b0b378876458808dcf7d57c5e3b29fe63e9`
- Round review base commit: `8e7f656714b173e89356da5b06c7c663780830ec`
- Implementer runtime: `codex / gpt-5.6-sol / ultra`
- Agent process: PASS (exit 0)
- Unified validation: PASS (exit 0)
- Checkpoint: created by `scripts/run-implementation.sh` after this report
