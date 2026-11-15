# Seek range lab trial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner try an enemy aggro range (seek range) in the lab, with no change to the shipped game or to any existing lab mix.

**Architecture:** One new `SimParams` field (`seekRange`, f32, world units, 0 means unlimited) read by `steer.wgsl`, which multiplies the seek desired velocity by a distance fade from the nearest seek point. One lab knob (`seekRange`, slider and mix field) set through a `Simulation.setSeekRange` setter, exactly like `comfortRadius`. The game never calls the setter, so the shipped game stays on the default.

**Tech Stack:** Plain JavaScript ES modules, WGSL, node:test, the Playwright GPU check page `tests/browser/pages/steer-check.js`.

**Spec:** `docs/superpowers/specs/2026-11-13-large-world-camera-design.md` (section 7 Step 3 first bullet only, section 11 item 2: "try the aggro range in the lab before committing").

## Global Constraints

- Plain JavaScript ES modules and WGSL. No TypeScript. No runtime dependencies.
- Full-word identifiers (`maximum`, not `max`; `position`, not `pos`).
- No em-dashes (U+2014) anywhere, including comments, docs and commit messages.
- Every source file under about 500 lines or carrying a one-line note at the top saying why.
- No hard-coded machine paths. No wall-clock assertions in tests.
- Mobile limits: at most 8 storage buffers per shader stage (unchanged: this plan adds none), 16-byte aligned structs, no `vec3` in storage layouts.
- Commit after every task with a message in the imperative.
- Scope: no hordes, no near and far spawn budgets, no spawn director or spawn pressure change, no dynamic zoom, no bigger worlds, no minimap. One SimParams field, one lab knob, one mix field, nothing more.

## Facts the tasks rely on (verified by reading the code)

- `SimParams` is exactly 256 bytes with no spare room: `worldBounds` (vec4f) occupies 240 to 255 (`src/sim/params.js` `WORLD_BOUNDS_OFFSET = 240`; `common.wgsl` layout comment). The field therefore goes at byte 256 and `SIM_PARAMS_BYTES` becomes 272 (a WGSL struct whose last member is an f32 at 256 has size 260 rounded up to its 16-byte alignment, 272). Every shader that declares `SimParams` gets it from `common.wgsl` and every binding uses the one `sim-params` buffer (`Simulation`, `src/sim/simulation.js:129`), so the larger struct needs no other shader edit.
- Two seek points are reached only through `nearestPlayerPosition` and `nearestPlayerDistance` in `common.wgsl` (a test, `tests/sim/nearest-player-shaders.test.js`, forbids `params.playerPosition` in `steer.wgsl`). The range uses `nearestPlayerDistance`, so it works for solo and for two seats unchanged.
- `smoothstep(low, high, x)` in WGSL has an indeterminate result when `low >= high`, and `steer.wgsl` already warns that equal edges are undefined. The spec's `smoothstep(seekRange, seekRange * 0.6, distance)` has `low > high`: do NOT use it. Use `1.0 - smoothstep(seekRange * 0.6, seekRange, distance)`: it is 1 (full seek) at or below 0.6 of the range, 0 (no seek) at or beyond the range, smooth between.
- `comfortRadius` is the template: `params.js` constant, validator and offset; `Simulation` field, setter, `writeParams` entry and `carryStateInto` line; `lab.js` `simulationValue` binding and `LAB_KNOB_DEFAULTS`; `labPresets.js` `KNOB_RANGES`; `panelModel.js` `LAB_KNOB_GROUPS` entry.
- `captureMix` writes every `MIX_KNOB_SPECS` knob, `applyMix` fills missing knobs from `LAB_KNOB_DEFAULTS`, so old shared links and bundled mixes load with `seekRange` at its default (unlimited) and the mix `version` stays 1.

## Encoding of "unlimited"

`seekRange = 0` means unlimited (same convention as `comfortRadius` 0 turning its fade off). `DEFAULT_SEEK_RANGE = 0`. The packed default is zero bytes, and the shader returns exactly `1.0` for `seekRange <= 0.0`, so the default multiplies seek by exactly 1 and every existing path is bit-identical. Slider range 0 to `MAXIMUM_SEEK_RANGE = 40` (the world diagonal is about 36.7), step 0.5; label `seek range (0 = unlimited)`.

## Review Focus

- Default 0 must be exactly today's behavior (no float drift): Task 2 shader text test, Task 4 fingerprint test, Task 5 control run.
- Range smaller than the comfort radius or tiny (for example 0.5): seek fades to zero everywhere near the player; no NaN, no divide by zero (the fade has no division). Task 5 includes a tiny-range validity run.
- Two seek points: an enemy far from both must not seek, an enemy near only the second point must seek it. Task 5 second scenario.
- A mix saved before this change (no `seekRange` key) loads at unlimited, and an out-of-range `seekRange` in a link is rejected. Task 3 tests.
- A capacity swap keeps the range (`carryStateInto`). Task 1 test.

---

### Task 1: SimParams field, validator, Simulation setter

**Files:**
- Modify: `src/sim/params.js`, `src/sim/simulation.js`, `src/sim/shaders/common.wgsl`
- Test: `tests/sim/params.test.js`, create `tests/sim/simulation-seek-range.test.js`

**Interfaces:**
- Produces: `DEFAULT_SEEK_RANGE` (0), `MAXIMUM_SEEK_RANGE` (40), `validatedSeekRange(range): number` (throws `RangeError` outside [0, 40] or NaN) exported from `src/sim/params.js`; `packSimParams({ seekRange })` writes f32 at byte 256, default 0; `SIM_PARAMS_BYTES === 272`; `Simulation#seekRange` (number) and `Simulation#setSeekRange(range)`; WGSL `params.seekRange: f32`.

- [ ] **Step 1: Write the failing tests.** In `tests/sim/params.test.js`: change the `256` assertions to 272 (test names too: "272-byte uniform layout"; the "tail past 256" test becomes "tail past 272", `byteLength` 272, `getUint32(272)` throws); add `seekRange: 5.5` to the "every field lands at its pinned offset" call with `256: 5.5` in the `floats` table; add `assert.equal(view.getFloat32(256, true), 0, 'seekRange is unlimited')` to "the packed defaults ..." test; add a validator test: `validatedSeekRange(0) === 0`, `validatedSeekRange(MAXIMUM_SEEK_RANGE) === 40`, and `-0.01`, `40.01`, `NaN` throw `RangeError`; `DEFAULT_SEEK_RANGE === 0`. The "defaults missing fields to zero" loop needs no new branch (offset 256 is zero by default). Create `tests/sim/simulation-seek-range.test.js` using `fakeSimulation()` (as `simulation-second-player.test.js` does): default `simulation.seekRange === 0` and the last `writeParams` write has `getFloat32(256, true) === 0`; after `setSeekRange(12)` the next write has 12; `setSeekRange(41)` throws and leaves 12; `carryStateInto(target)` gives `target.seekRange === 12`.
- [ ] **Step 2: Run to verify failure.** `node --test tests/sim/params.test.js tests/sim/simulation-seek-range.test.js`. Expected: FAIL (missing exports, 256 vs 272).
- [ ] **Step 3: Implement.** In `params.js`: the three exports, a `SEEK_RANGE_OFFSET = 256` constant with a comment (zero means unlimited), `SIM_PARAMS_BYTES = 272` with a comment that the extra 16 bytes are the f32 plus struct padding, one `view.setFloat32(SEEK_RANGE_OFFSET, values.seekRange ?? DEFAULT_SEEK_RANGE, true)` line in `packSimParams`; reuse the existing `validatedRange` helper. In `simulation.js`: import the constants, `this.seekRange = DEFAULT_SEEK_RANGE` beside `comfortRadius`, `setSeekRange(range)` beside `setComfortRadius`, `seekRange: this.seekRange` in the params object (next to `comfortRadius`, line ~468), `next.setSeekRange(this.seekRange)` in `carryStateInto`. In `common.wgsl`: add `seekRange: f32` as the last `SimParams` member (after `worldBounds`) and the layout comment line `// 256 seekRange f32 (seek fades to zero at this distance from the nearest seek point; 0 is unlimited)`, and change "total 256 bytes" to "total 272 bytes".
- [ ] **Step 4: Run to verify pass.** Same command, then `npm test`. Expected: PASS. If another test or a page under `tests/browser/pages/` hard-codes 256 for the params buffer, change it to `SIM_PARAMS_BYTES` (search `256` in `tests/` and `src/` outside the unrelated workgroup and ship-count uses; this is an inference, not yet checked beyond `params.test.js`).
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Add the seekRange SimParams field and Simulation setter"`

### Task 2: The range fade in steer.wgsl

**Files:**
- Modify: `src/sim/shaders/steer.wgsl`
- Test: `tests/sim/steer-seek-range-shader.test.js` (create; same fixed-spelling style as `tests/sim/nearest-player-shaders.test.js`)

**Interfaces:**
- Consumes: `params.seekRange` (Task 1), `nearestPlayerDistance(position, params)` from `common.wgsl`.
- Produces: WGSL `fn seekRangeFactor(distance: f32) -> f32` and `const SEEK_RANGE_FULL_FRACTION: f32 = 0.6`.

- [ ] **Step 1: Write the failing test.** Read `steer.wgsl` and assert by fixed spelling: exactly one `fn seekRangeFactor(`; it contains `params.seekRange <= 0.0` and the exact text `1.0 - smoothstep(params.seekRange * SEEK_RANGE_FULL_FRACTION, params.seekRange, distance)`; the file does not contain the spec's reversed form `smoothstep(params.seekRange, params.seekRange *`; `SEEK_RANGE_FULL_FRACTION: f32 = 0.6` appears once; `main` multiplies the seek term (the line starting `var desired = seek * speciesField(species, FIELD_SEEK) * params.seekScale`) by `seekRangeFactor(nearestPlayerDistance(agent.position, params))`.
- [ ] **Step 2: Run to verify failure.** `node --test tests/sim/steer-seek-range-shader.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** in `steer.wgsl`: the constant and `seekRangeFactor` (returns `1.0` when `params.seekRange <= 0.0`, otherwise the fade above) near `seekVelocity`, with a comment saying the range fades the whole seek term (straight and orbit), that edges are ordered low to high because WGSL `smoothstep` is indeterminate otherwise, and that 0 is unlimited; apply it in `main` on the `desired` seek line. Update the file header comment's seek sentence. Beyond the range the agent keeps every other term (separation, alignment, cohesion, matrix, flee, pressure) and the steering clamp, unchanged.
- [ ] **Step 4: Run to verify pass.** `node --test tests/sim/steer-seek-range-shader.test.js tests/sim/nearest-player-shaders.test.js tests/gpu/shaders.test.js`. Expected: PASS. (The WGSL itself is compiled only by the GPU check in Task 5; do not run it while other work uses the GPU.)
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Fade enemy seek with distance from the nearest seek point"`

### Task 3: Lab knob and mix field

**Files:**
- Modify: `src/ui/panelModel.js` (a `seekRange` entry in the `Steering and walls` group, after `comfortRadius`: `{ key: 'seekRange', label: 'seek range (0 = unlimited)', minimum: 0, maximum: 40, step: 0.5 }`), `src/ui/lab.js` (`seekRange: simulationValue('seekRange', 'setSeekRange')` in `LAB_KNOB_BINDINGS`, `seekRange: DEFAULT_SEEK_RANGE` in `LAB_KNOB_DEFAULTS`, import), `src/ui/labPresets.js` (`seekRange: [0, 40]` in `KNOB_RANGES`; add "seek range (0 unlimited)" to the schema comment list of Simulation setters)
- Test: `tests/ui/lab.test.js`, `tests/ui/labPanel.test.js`, `tests/ui/labPresets.test.js`

**Interfaces:**
- Consumes: `Simulation#seekRange`, `setSeekRange`, `DEFAULT_SEEK_RANGE` (Task 1).
- Produces: knob key `seekRange` in `MIX_KNOB_SPECS`, `LAB_KNOB_BINDINGS`, `LAB_KNOB_DEFAULTS`, `KNOB_RANGES`.

- [ ] **Step 1: Write the failing tests.** In the fake simulations of `tests/ui/lab.test.js` (near `comfortRadius: 1`) and `tests/ui/labPanel.test.js` (near line 71) add `seekRange: 0` and `setSeekRange(value) { this.seekRange = value; }`. In `lab.test.js`: extend the "shipped default" assertion list with `seekRange` expecting `0`; add `writeKnob(source, specFor('seekRange'), 18.5)` to the round-trip test (or a sibling test) and assert `target.game.simulation.seekRange === 18.5` after `applyMix(target, decodeMix(encodeMix(captureMix(source))))`; add a test that applying `BUNDLED_MIXES.default` after setting 18.5 resets `seekRange` to 0 (the existing "without a knobs map" test already loops every spec, so it covers this once the spec exists); add a test that a mix whose `knobs` omit `seekRange` (an old shared link) loads with `seekRange` 0. In `labPresets.test.js` add `knobRange: { ...good, knobs: { seekRange: 41 } }` and `{ seekRange: -1 }` to the rejected cases. The existing "every mix knob has a binding and a whitelist range" test covers panel and whitelist agreement.
- [ ] **Step 2: Run to verify failure.** `node --test tests/ui/lab.test.js tests/ui/labPanel.test.js tests/ui/labPresets.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the four source edits listed under Files.
- [ ] **Step 4: Run to verify pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Add the seek range lab knob and mix field"`

### Task 4: Prove the shipped game is unchanged

**Files:**
- Test: `tests/game/coop.test.js` (the solo fingerprint lives here: `SOLO_CALL_LOG_HASH`, `soloCallLog`)

**Interfaces:**
- Consumes: `soloCallLog()` and `createFakeSimulation` (`tests/game/game-harness.js`).

- [ ] **Step 1: Write the test** `the solo game never sets the seek range and the fingerprint is unchanged`: run `soloCallLog()`, assert no entry name is `simulation.setSeekRange`, and assert the hash still equals `SOLO_CALL_LOG_HASH` (do not edit the hash constant). Add `src/game/` grep guard in the same test file: read every file under `src/game/` and assert none contains `setSeekRange` (the game must not own the knob).
- [ ] **Step 2: Run.** `node --test tests/game/coop.test.js`. Expected: PASS immediately (the guard is a regression net, not a fix; if the existing hash test fails, Task 1 or 2 changed a game call and must be corrected, never the hash).
- [ ] **Step 3: Commit.** `git add -A && git commit -m "Guard that the shipped game never sets the seek range"`

### Task 5: GPU check scenarios in steer-check.js

**Files:**
- Modify: `tests/browser/pages/steer-check.js` (already over 500 lines and carries the note; update its top comment list with scenario (h))

**Interfaces:**
- Consumes: `packSimParams({ seekRange })` (Task 1), `Harness` (add `this.seekRange = 0` beside `secondPlayerPosition`, passed in `initialize()` as `seekRange: this.seekRange`).
- Produces: `checkSeekRange(gpu, common)` added to the `runCheck` list after `checkNearestPlayer`.

- [ ] **Step 1: Write the check.** A helper `groupDistances({ seekRange, secondPoint, groups })` builds a `Harness` over Chasers placed in unit-style discs (seeded `randomSource`, as `checkNearestPlayer` does), runs 60 steps, and returns each group's mean distance to its nearest seek point after the run. Scenario one (one point, player at `PLAYER` = (8, 4.5), `seekRange` 6): near group, 200 Chasers in a disc of radius 0.5 around (11, 4.5) (distance 3, inside the full-seek band 3.6); far group, 200 around (1.5, 7.5) (distance 7.16, nearest member 6.66, beyond the range). Run it twice, control `seekRange` 0 and ranged `seekRange` 6, and require: the control far group closes by at least 0.5 units (the check can see seek); the ranged near group closes within 20 percent of the control near group's closure; the ranged far group closes by at most 25 percent of the control far group's closure. Scenario two (two points): player moved to (3, 4.5) with `secondPlayerPosition` (13, 4.5) and `seekRange` 3.5; groups at (5, 4.5) and (11, 4.5) (each 2 from its nearest point, inside 2.1) and a third at (8, 8.3) (6.3 from both, outside): require both near groups to close on their nearest point and the third to close by at most 25 percent of its control (`seekRange` 0) closure. Scenario three: `seekRange` 0.5 with the near-group layout, assert `validityFailure(agents)` is null (no NaN, nothing out of bounds). The numeric thresholds are the author's inference: on first run print the measured closures in `detail`, and tighten or loosen only the relative fractions, never the control-closure sensitivity guard.
- [ ] **Step 2: Run** (only when the GPU is free): `node tests/browser/steer.mjs`. Expected: all verdicts PASS including the new `seek range` line. Without a GPU the runner exits 2; then record in the commit message that the check was not run.
- [ ] **Step 3: Commit.** `git add -A && git commit -m "Check the seek range fade on the GPU for one and two seek points"`

### Task 6: Documentation

**Files:**
- Modify: `AGENTS.md`, the schema comment in `src/ui/labPresets.js` (done in Task 3, confirm)

- [ ] **Step 1: Update AGENTS.md.** In the "Neutral swarm" bullet of the Co-op section append one sentence: the lab-only `seekRange` (`SimParams` byte 256, f32 world units, 0 unlimited and the default, `Simulation.setSeekRange`, the `seekRange` lab knob and mix field, slider 0 to 40) fades every species' seek by `1 - smoothstep(0.6 * range, range, distance)` to the nearest live seek point in `steer.wgsl`, the game never sets it, so shipped play is unchanged. In "Global constraints" or wherever `SimParams` is described, state the uniform is now 272 bytes (`SIM_PARAMS_BYTES`). Mention scenario (h) in the `steer.mjs` check list in the File map if it lists scenarios.
- [ ] **Step 2: Run** `npm test` and `npm run coverage` (coverage floors 92 and 86 must hold). Expected: PASS. Run the docs-update check over README and `docs/`.
- [ ] **Step 3: Commit.** `git add -A && git commit -m "Document the seek range lab knob"`

## Risks for the owner's trial

- Spawn gates open 1 to 1.4 view half-diagonals (about 9 to 13 units) from the view center. A range below about 14 means a freshly spawned wave starts outside it and does not converge until it drifts in; judge ranges of roughly 14 to 24 for the "aggro range" feel and treat smaller values as a stress test.
- With no hordes and no near and far spawn budgets, enemies beyond the range only flock and idle toward walls and dense clumps (the existing pressure and cohesion terms), so the world can feel emptier near the player and the alive count the player meets drops. Whether that reads as "elsewhere exists" or as "fewer enemies" needs the far budget, which is out of scope here; this trial cannot answer the hordes question.
- Spawn pressure and the ramp's `seekScale` still scale seek globally and are unaware of the range, so spawn refill pours enemies that may never engage.
- In co-op the fade uses the nearer of the two seek points, so a far seat is simply a second aggro source; no change to either seat's difficulty beyond that.
- World size is still 32 by 18 and the view 16 by 9, so a range above about 18 hardly differs from unlimited for most positions.

## Needs owner consent

None. The plan uses exactly one SimParams field, one lab knob and one mix field. One consequence to note: the SimParams uniform grows from 256 to 272 bytes because it had no spare bytes; that is the same layout change the spec's risk list already anticipates, not a new mechanism.

## Self-review notes

- Spec coverage: seek range with smoothstep fade (Tasks 1 and 2, order corrected), both seek points (Task 2 uses `nearestPlayerDistance`, Task 5 scenario two), lab knob (Task 3), `params.playerPosition` to `targets[N]` is not planned (out of scope; the existing two-point helpers suffice).
- Spec text corrected: the spec's `smoothstep(seekRange, seekRange * 0.6, d)` passes edges in descending order, which WGSL leaves indeterminate; the plan uses `1.0 - smoothstep(0.6 * range, range, d)`.
