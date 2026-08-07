# Agent Implementation Report

IMPLEMENTATION_STATUS: COMPLETE

VERDICT_ADDRESSED: CHANGES_REQUIRED — repeated Major `R-005` is addressed.

## Metadata

- Task: `fly-foundation-hot-air-balloon-v1-2026-07-31`
- Implementation round: 4 (absolute target for this parent run: 4)
- Implementation segment: 1
- Base commit / current HEAD: `cca4ee410a09d124d1984b042b2ea41a9f456a7a`
- Round review base commit: `fc285a1c81363ea09341712c0fc4fd8db5f9a900`
- Implementer runtime: codex / gpt-5.6-sol / ultra
- Role session: `019fdd63-8404-7b03-9818-59c78c0e3b11` (resume), generation 1
- Run manifest: `.agent/artifacts/runs/implementation-r4-s1-20260807T184744Z-80977.env`
- Scope: the round-three `R-005` configuration-registry switching and keyboard-accessibility
  correction. SOURCE business logic, accepted FLY physics/recovery behavior, protected specifications,
  collaboration controls, dependencies, styles, and validation scripts were preserved.
- Git ownership: no stage, commit, push, deploy, reset, clean, rebase, branch switch, or history write
  was performed. The neutral wrapper owns the checkpoint.

## 1. Outcome and review finding

The FLY configuration controller can now move between mutually exclusive but individually valid
weather/vehicle pairs without a reload. Selecting a new item always accepts a registered ID and
clears only an incompatible selection of the other kind. The resulting incomplete state cannot be
confirmed, but the user can select its compatible counterpart and proceed.

Keyboard selection is no longer a fixed-first shortcut. A registry-derived cursor traverses every
weather and vehicle ID plus the confirmation target; Left/Right, Home/End, and Up/Down move that
cursor, while Enter/Space activates its current target. The focused option has a visible 3D marker,
and the focus ID, ordinal, selection state, instructions, and optional accessible label are reflected
in the canvas accessible name. FLY removes the bootstrap `aria-hidden` attribute when mounted.

During the first browser evidence attempt, adjacent cloned weather previews exposed a second real
integration issue: at `768×1024`, the projected B target could ray-hit A's overlapping geometry.
Pointer resolution now gives a click near a registry slot to the nearest projected slot and retains
the original 3D raycast as fallback outside those target zones. Touch, pointer, and keyboard all
complete `A/A → B/null → B/B → A/A → B/B`, reject confirmation at `B/null`, and launch a real
`createFlyScene` session with the final B/B IDs.

| Review ID | Result | Acceptance evidence |
| --- | --- | --- |
| `R-005` Major | RESOLVED | A mutually exclusive two-weather/two-vehicle fixture switches both directions without rebuilding the controller or scene. Incomplete states reject confirmation. The actual built `createFlyScene` reaches the second pair by touch at `390×844`, pointer at `768×1024`, and keyboard at `1440×900`; every final session snapshot retains `clearFixtureB / balloonFixtureB`. Production still exposes only `clear / hotAirBalloonC100`. |

No Blocker, Minor, or additional valid finding was present in the round-three review.

## 2. Changed component IDs and files

| Component ID | Files | Round-four change |
| --- | --- | --- |
| `FLY-CONFIG-001` | `src/scenes/fly/configPreview.js` | Deadlock-free selection replacement; generic registry keyboard navigator; projected pointer-target resolver; per-entry focus-marker geometry and lifecycle. |
| `FLY-SCENE-001` | `src/scenes/fly/flyScene.js` | Navigator integration, registry-derived accessible names, visible focus synchronization, repeat-safe activation, nearest-slot pointer/touch disambiguation, `aria-hidden` removal, selected-ID/session propagation, and read-only `configKeyboard` debug state. |
| `FLY-REGISTRY-001` | `src/scenes/fly/registry.js` | Optional accessible labels for the two real production entries; no new production choice. |
| `FLY-TEST-001` | `tests/run.mjs` | Mutually exclusive A/A and B/B graph, bidirectional switching, incomplete-confirm rejection, second-entry keyboard traversal, overlap disambiguation/blank rejection, and final session-ID checks. Total is now 403 checks. |
| `PROJECT-FACT-001` | `PROJECT.md` | Current fact records the round-four compatibility, keyboard, and pointer-overlap corrections pending review. |

No SOURCE business file, FLY physics/recovery file, style file, package manifest, lockfile, protected
engineering specification, Agent control script, or collaboration control file changed.

## 3. Sources, geometry, and proxy labels

No aircraft, weather, atmosphere, terrain, material, or certification fact changed. Existing source
and authenticity boundaries remain:

- Cameron C-Type official data remains the source for the C-100 16 gores, 100,000 ft³ volume,
  65 ft height, 57 ft diameter, 2,000 lb certified limit, and 218 lb standard envelope weight
  (`PRIMARY_SOURCE` plus direct `DERIVED` SI conversions).
- Cameron same-family burner/tank material and the FAA Balloon Flying Handbook remain the basis for
  the lower-system reference configuration and control relationships.
- U.S. Standard Atmosphere 1976 remains the clear-weather baseline.
- Lower-system masses, lumped thermal terms, contacts, procedural terrain/obstacles, wind field,
  and recovery forecast remain explicit `ENGINEERING_PROXY` values.
- `SOURCE_VERIFIED` and `SOURCE_ART_DIRECTION` facts were not edited.

Round-four geometry is configuration/accessibility presentation geometry only:

| Geometry / interaction | Representation | Label and consumers |
| --- | --- | --- |
| Vehicle keyboard focus marker | White emissive-independent `THREE.TorusGeometry(11.15, 0.105, 8, 64)` at local `y=-7.74`; one per registry slot, only the focused marker visible | `ART_DIRECTION`; keyboard focus feedback, disposed with its catalog entry |
| Weather keyboard focus marker | White `THREE.TorusGeometry(4.75, 0.105, 8, 64)` at local `y=0`; one per weather slot, only the focused marker visible | `ART_DIRECTION`; keyboard focus feedback, disposed with its catalog entry |
| Projected target zone | Nearest registry slot inside `max(44, min(96, 0.14 × min(canvas width, canvas height)))` CSS px; otherwise the existing 3D raycast result | Deliberate UI interaction abstraction; prevents adjacent preview geometry from stealing another registry slot and has no physical-world meaning |

The focus marker has `raycast = () => {}` and never becomes a selectable geometry itself. C-100
envelope, basket, suspension, burner, collision bodies, camera, terrain, obstacles, and all SOURCE
geometry are unchanged.

## 4. State, geometry, and causality links

### Selection replacement and confirmation

```text
registered weather or vehicle ID
  → select(kind, id) accepts the registered item
  → compare it bidirectionally with the other selected definition
  → keep compatible counterpart OR clear only stale incompatible counterpart
  → incomplete state remains editable and confirm() returns false
  → compatible weatherId + vehicleId can confirm
  → sessionFactory({ selection, registries })
  → immutable session snapshot.selection
```

- Both `weather.compatibleVehicles` and `vehicle.compatibleWeather` must agree.
- Confirmation still requires two non-null compatible IDs.
- Confirmation freezes selection exactly as before.
- No default ID or product-specific branch was introduced into the scene loop.
- Production registry contents remain one real weather and one real vehicle.

### Keyboard and accessible state

```text
Object.keys(weatherRegistry), Object.keys(vehicleRegistry), confirm
  → category order weather → vehicle → confirm
  → per-category cursor index
  → Left/Right or Home/End changes registry item
  → Up/Down changes category
  → Enter/Space activates current {kind, id}
  → focusNext chooses the missing category or confirm
  → catalog.setFocused + canvas aria-label + debugApi.configKeyboard
```

- Arrow/category movement does not mutate selection.
- Repeated Enter/Space keydown is ignored so a held activation key cannot choose several stages.
- The accessible name identifies kind, 1-based ordinal/count, human label/ID, selected state, and
  available keys. The confirm target identifies either the selected IDs or an incomplete state.
- `canvas.removeAttribute("aria-hidden")` makes that name and focus state available after FLY mount.
- The guide still moves focus to the depart control and makes canvas/flight controls inert.

### Pointer and touch targeting

```text
registry entry wrapper world position
  → configTargetPixels.{weatherById, vehicleById, confirm}
  → nearest projected target inside responsive CSS-pixel radius
  → tagged {configKind, configId}
  → selectConfig / confirmConfig
fallback outside target radius
  → existing THREE.Raycaster mesh/line hit
```

- Actual pointer and touch events use the same handler and state controller.
- Blank lower-corner input remains outside the target radius and leaves selection unchanged.
- All target work is registry-derived; adding an entry does not add a new input branch.

## 5. Deliberate abstractions and open gaps

The two-by-two regression/evidence fixture clones the accepted clear-weather and C-100 factories
under test-only IDs and gives them mutually exclusive A/A and B/B compatibility. It proves registry
expansion and interaction without displaying or claiming nonexistent production assets. Its source
and build files live only under ignored `.agent/artifacts/fly-evidence/r4-fixture/`; the final browser
route serves its built output from `dist/r4-fixture/` at the synthetic origin.

The first-slice gap IDs remain open:

- `FLY-GAP-001` — Public product data does not provide a complete serial lower-system mass/inertia
  schedule; manifest proxy values remain explicit.
- `FLY-GAP-002` — Air, suspension, basket, and fabric dynamics remain bounded low-DOF/lumped models;
  no CFD, rope FEM, wicker deformation, or full fabric FEM is claimed.
- `FLY-GAP-003` — Obstacles are deterministic analytic collision proxies without geospatial or
  destructive-response fidelity.
- `FLY-GAP-004` — Sky, clouds, sun, haze, and local wind remain atmospheric/art proxies rather than
  a spectral or mesoscale solve.
- `FLY-GAP-005` — The production JS bundle is `843.95 kB / 234.26 kB gzip`; Vite reports the existing
  non-fatal `>500 kB` warning. Code splitting remains an optimization opportunity.
- `FLY-GAP-006` — WebAudio state/lifecycle is verified, but loudspeaker timbre, spatial mix, and
  loudness remain unverified.
- `FLY-GAP-007` — Full WebGL context loss/restoration was not replayed this round.

## 6. Performance and lifecycle

- The physical clock remains `1/120 s`; no physics, weather, or recovery loop changed.
- Selection compatibility is constant-time registry lookup plus two list membership checks.
- Keyboard navigation is constant-time except a bounded registry-ID lookup when focus is set.
- Pointer resolution is `O(weather + vehicle)` over projected slots. Production evaluates only two
  entries plus confirm; the two-by-two fixture evaluates five targets.
- Only one focus marker is visible, so production adds at most one small 64-segment torus draw to the
  configuration view. Marker geometry/material are disposed with each catalog entry.
- Final production build transforms 45 modules and emits `843.95 kB / 234.26 kB gzip` JS. Relative
  to the prior report (`840.40 / 233.06`), this round adds about `3.55 kB / 1.20 kB gzip`.
- After every recovered production journey, a newly entered FLY reported one RAF, zero physics
  worlds, 30 scoped listeners, zero audio voices, zero chunks, null selection, and null session.
- Fixture scenes were explicitly disposed after each viewport; their real one-second burner input
  reduced fuel from 76 kg to `75.80179`, `75.79859`, and `75.79220` kg respectively.

## 7. Verification

### Standalone validation — PASS

Final standalone command: `./scripts/run-validation.sh`

| Check | Result |
| --- | --- |
| Dependency check | PASS |
| Build | PASS — Vite 8.1.0, 45 modules, `843.95 kB / 234.26 kB gzip`; existing non-blocking chunk warning |
| Tests | PASS — 403/403 |
| Lint | NOT CONFIGURED |
| Type check | NOT CONFIGURED |
| Browser / visual in script | MANUAL REQUIRED; completed with Playwright MCP below |

`git diff --check` is PASS. The logic suite covers mutually exclusive pair switching in both
directions, incomplete confirmation rejection, second-entry keyboard focus, projected overlap
resolution, blank rejection, final selected session IDs, and all prior SOURCE/FLY physics,
determinism, recovery, resource, and authenticity checks.

### Consolidated Playwright MCP pass — PASS

The final built `dist/` was served only through `page.route('**/*')` at
`http://source.local/index.html`. The route accepted only the exact synthetic origin, decoded paths,
rejected `.` / `..` segments, backslashes and NULs, joined only beneath the fixed absolute `dist/`
prefix, returned `index.html` for entry directories, preserved MIME types, and aborted missing files.
No Bash Playwright script, Vite server, preview server, background process, or HTTP server was used.

| Evidence | Result |
| --- | --- |
| Responsive production and fixture | Canvases exactly matched `390×844`, `768×1024`, and `1440×900`; overflow was `0/0` in all six views. Guide boxes were `370×581.531`, `680×417.156`, and `680×478.125`, each contained. |
| Production configuration | Every viewport began null/null/false with `aria-hidden` absent; blank input stayed unchanged. Touch, pointer, and keyboard produced `clear / hotAirBalloonC100 / true`. Production exposed no fixture IDs. |
| Mutually exclusive fixture | At every viewport/input mode: A/A succeeded; selecting weather B produced B/null; confirmation left `confirmed:false` and guide hidden; vehicle B produced B/B; switching back produced A/A; switching again produced B/B. |
| Keyboard accessibility | At desktop, ArrowRight reached `weather option 2 of 2: Fixture weather 2`; arrows reached vehicle B and confirm; incomplete confirm announced the incomplete state; the focus marker followed the cursor. |
| Pointer-overlap regression | At `768×1024`, actual mouse clicks at projected target coordinates now selected weather B despite adjacent A geometry, completed B/B, switched back to A/A, and returned to B/B. |
| Session propagation | All three fixture journeys departed with `snapshot.selection = clearFixtureB / balloonFixtureB`; a real one-second burner hold then consumed fuel. |
| Guide and first activation | Focus was `Confirm selection and begin flight`; canvas and flight controls were inert. Before depart audio was `NONE`, unlocked false, 0 voices; after the depart click it was `running`, unlocked true, 4 voices. |
| Active production controls | A 22 s actual burner hold reduced fuel from 76 kg to `71.77685 / 71.76886 / 71.76726`; a 2 s vent hold reduced internal temperature to `343.221 / 343.251 / 343.429 K`; touch/pointer/keyboard releases ended at burner/vent `0/0` with no active class. |
| Physical recovery | Touch recovered in 291 simulated seconds, pointer in 114, keyboard in 116. All ended RECOVERED with zero unsafe contacts. Plan/first-contact/completion ordering was `285.283 < 312.650 < 315.650`, `105.292 < 136.417 < 139.417`, and `128.025 < 138.825 < 141.825`; landing errors were `30.58`, `40.75`, and `36.37 m`. |
| Session reset | After each recovery and Escape, re-entered FLY had null selection/session, zero physics worlds, voices, and chunks. |
| SOURCE regression | Fresh SOURCE was `NONE / INTERLOCKED_RESET / unlocked:false` with both audio chains `NONE`; first pointer input produced `AUTO / INTERLOCKED_RESET / unlocked:true` with both chains running; return removed state/audio/navigation hooks. |
| Browser console | PASS — 0 page errors, 0 application errors/warnings, and 0 driver warnings in the final exact-build pass. |

Useful ignored screenshots:

- `.agent/artifacts/fly-evidence/r4-390-production-guide.png`
- `.agent/artifacts/fly-evidence/r4-390-fixture-touch-bb-guide.png`
- `.agent/artifacts/fly-evidence/r4-1440-fixture-keyboard-bb.png`
- `.agent/artifacts/fly-evidence/r4-1440-production-recovered.png`

## 8. Failures, unverified areas, and remaining risks

- Configured validation failures: none.
- Final browser flow failures: none.
- Lint: NOT CONFIGURED.
- Type check: NOT CONFIGURED.
- Three Playwright harness setup attempts stopped before loading application content because the MCP
  VM exposes neither dynamic import, `process`, nor `URL`; the final strict route used supported
  `route.fulfill({ path })` plus string-based exact-origin/path validation.
- An intermediate real browser pass found the `768×1024` overlapping-preview pointer defect. That
  pass failed the intended B/B transition, so it was not counted as final evidence. The defect was
  fixed, added to the 403-check suite, rebuilt through standalone validation, and the complete final
  matrix then passed.
- Native screen-reader announcement quality, mobile switch-control behavior, and OS-level focus
  narration remain UNVERIFIED; DOM accessibility state, ordinals, labels, focus, and inert boundaries
  passed browser inspection.
- Actual speaker output/spatial mix remains UNVERIFIED (`FLY-GAP-006`).
- WebGL context loss/restoration remains UNVERIFIED (`FLY-GAP-007`).
- SOURCE deep MANUAL commands, intentional glass fracture/debris, and underwater/underground camera
  traversal were not replayed in this browser pass; protected logic tests remain green and SOURCE's
  first-interaction/lifecycle path passed.
- A real second weather or vehicle asset does not yet exist. The fixture proves architecture and
  interaction only; reviewers must not interpret it as a production-content claim.
- The recovery controller remains an explicit first-slice engineering proxy, not certification
  software; `FLY-GAP-001…004` remain bounded risks.

## 9. Exact handoff focus for the next REVIEWER

1. Recreate the mutually exclusive graph: `weatherA ↔ balloonA` and `weatherB ↔ aircraftB`. Verify
   A/A → select weather B gives B/null; confirm returns false; vehicle B completes B/B; then switch
   B/B → A/A and back without rebuilding the controller.
2. Instantiate the actual `createFlyScene` with that fixture. At `390×844` use touch, at `768×1024`
   use pointer, and at `1440×900` use keyboard. Confirm every path reaches B/B, rejects the incomplete
   state, opens the guide only when compatible, and passes B/B into the real session snapshot.
3. Pay special attention to `768×1024`: click `configTargets.weatherById.clearFixtureB` while the two
   weather previews overlap in projection. It must select B rather than the ray-nearer A. Verify a
   blank lower-corner input still changes nothing.
4. For keyboard, verify every registry item is reachable by arrows/Home/End, the canvas accessible
   name reports the active ID and ordinal, the visible torus follows focus, held Enter does not skip
   stages, and the guide restores the accepted focus/inert boundary.
5. Confirm production exposes only `clear / hotAirBalloonC100`, then repeat one real production
   select/depart/control/recovery/reset path and inspect console/resource counts. Confirm SOURCE still
   starts locked, activates on its first interaction, and removes hooks on return.

Treat `FLY-GAP-001…007` only as the explicitly bounded first-slice risks above. Do not reinterpret
the ignored registry fixture or focus-marker geometry as a new aircraft/weather/source claim.

## Automation wrapper result

- Process base commit: `cca4ee410a09d124d1984b042b2ea41a9f456a7a`
- Round review base commit: `fc285a1c81363ea09341712c0fc4fd8db5f9a900`
- Implementer runtime: `codex / gpt-5.6-sol / ultra`
- Agent process: PASS (exit 0)
- Unified validation: PASS (exit 0)
- Checkpoint: created by `scripts/run-implementation.sh` after this report
