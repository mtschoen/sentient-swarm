Status: Shipped on by default 2026-11-14 at the owner's request; calmed 2026-11-15: maximum 1.3, punch-in 0.5, crowd reference 1, smoothing 1.2 s, rate 0.35

# Solo Camera Zoom (lab knobs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let the solo camera zoom with the crowd (punch in when crowded, pull out when the action is elsewhere) behind lab knobs, with the shipped default unchanged (solo zoom fixed at 1, off).

**Architecture:** A pure `SoloZoomController` (new file) turns two preset-invariant pressures (near crowding, far action) and the swarm radius into a target zoom, using log space, asymmetric pressure smoothing, a rate limit and hysteresis. A pure sampler (new file) reads those pressures from `Simulation.densityAt` (the existing CPU density map) at a ring of points, so there is no new GPU pass and no new readback. `Camera.update` gets per-call zoom limits and a zoom smoothing time (defaults equal today's constants, so co-op is untouched). `Game.followCamera` applies the controller only with one live seat, only when enabled, and never under reduced motion. The knobs are bound in the lab like `seekRange` and the Beam group, and a guard test proves the game never enables the feature itself.

**Tech Stack:** Plain JavaScript ES modules, node:test, Playwright (browser check). No dependencies.

**Spec:** `docs/superpowers/specs/2026-11-13-large-world-camera-design.md` sections 4.3, 4.4, 6, 7 (step 2) and 11 items 3, 4, 8. Owner-approved deviation: built as lab knobs with the shipped default off; the owner picks shipped defaults after judging in the lab.

## Global Constraints

- Plain JavaScript ES modules and WGSL. No TypeScript. No runtime dependencies.
- Full-word identifiers (`maximum`, not `max`; `position`, not `pos`).
- No em-dashes (U+2014) anywhere, including comments, docs and this plan.
- Every source file under about 500 lines, or a one-line note at the top saying why. `src/game/game.js` is already 780 lines: add only thin wiring there and put logic in the new modules.
- No hard-coded machine paths. No wall-clock assertions in tests; inject time (`deltaSeconds`).
- No new GPU passes, no new readbacks, no new storage buffers.
- The simulation never reads the camera. Shipped play must be byte-for-byte unchanged: with the feature off (the default) solo zoom is exactly 1 and every co-op number is unchanged.
- Verification: `npm test`; single files with `node --test tests/game/x.test.js` (`node --test <directory>` fails on this machine). Commit after every task, imperative message, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Implementers must prove each new test by mutation: break the implementation (or the one line the test pins), run the test, see it fail, restore, see it pass. Say which mutation in the task report.

## Review Focus

- Reduced motion on with the feature on: zoom stays exactly 1 (spec 11 item 8). Pinned in Task 4.
- Swarm of 256 ships with punch-in strong: the fit cap keeps the whole swarm in view (spec 4.3 hard constraint). Pinned in Task 3.
- Two seats while the solo knob is on: co-op `fitZoom` behavior is identical to today (the knob never applies). Pinned in Task 4.
- A seat going down (two seats to one live seat) or the second seat reviving mid-run while the knob is on: no zoom jump beyond the spring and no stale controller state. Pinned in Task 4.
- Knob values from a shared `#mix=` link or an older mix without the keys: out-of-range rejected, missing keys leave defaults. Pinned in Task 5.

## Design decisions (for the owner to check)

1. **Combination rule.** One live seat: target is the controller's zoom if enabled (and not reduced motion), else 1. Two or more live seats: `fitZoom` exactly as today, controller idle (reset). The camera's zoom range is passed per update: solo-enabled `[soloZoomMinimum, soloZoomMaximum]`, otherwise `[MINIMUM_CAMERA_ZOOM, 1]` (today's clamp), so co-op never sees zoom above 1.
2. **Inputs (CPU only, from `Simulation.densityAt`, 128 by 72 map refreshed every 15 steps).** `near` = mean of `densityAt` over the focus plus 8 points on a circle of radius `ZOOM_NEAR_RADIUS` (3.0 units), normalized by `capacity / DENSITY_REFERENCE_CAPACITY` and by the `soloZoomCrowdReference` knob, then `smoothstep(0.25, 1.0, .)`. `far` = mean `densityAt` over 8 points on a circle just outside the current view (radius = 1.1 times the zoomed view half-diagonal from the focus, points outside the world skipped), same normalization, `smoothstep(0.15, 0.6, .)`. The spec's "disc sum" is replaced by the ring mean because a mean of density is already per-area; the unit of `densityAt` (blurred species density summed per coarse cell) must be calibrated once (Task 2 step 6) to set the default `soloZoomCrowdReference`.
3. **Punch-in versus pull-out when crowded (spec 11 item 4).** `lnZoom* = punchIn * near - pullOut * far * (1 - near)`. `soloZoomPunchIn` ranges over negative values, so a negative punch-in is the opposite convention (pull out when crowded); `soloZoomPullOut` ranges over 0 to 1 (0 turns off the far-action pull-out).
4. **Simplifications versus spec 4.3, flagged:** one zoom smoothing time (`soloZoomSmoothSeconds`, default 1.2, applied by the camera spring) instead of 1.2 in and 0.5 out; no pivot about the focus (the camera center already eases to the focus, as co-op does); attack and release times (0.4 s and 2.0 s), the 0.04 hysteresis, `FIT_FRACTION` 0.7 and `FIT_MARGIN` 1.0 are constants, not knobs.
5. **View dependants in solo zoom.** Stated against what the code does today (co-op already zooms, so these are the same choices):
   - Bomb radius: unzoomed (`bombRadiusForView(this.viewSize...)`), unchanged. A bomb never grows when zoomed out and never shrinks when zoomed in.
   - Spawn safe distance (`pressure.spawnDistanceFraction * viewSize.width`): unzoomed, unchanged.
   - Pickup placement and reach (`pickups.setView` from `setView`): unzoomed, unchanged.
   - Spawn gate ring (`view: this.view`, zoomed today): stays zoomed when zooming out (as co-op). **Check:** zoomed in at 1.6 the ring (1 to 1.4 zoomed half-diagonals, about 3.3 to 4.6 units) would fall inside the safe radius (4 to 8 units) and `SpawnDirector` rejects gates inside it, which could stall waves. Task 4 therefore passes the director a ring view whose zoom is capped at 1 (`ringView`), so punch-in never pulls gates inside the safe radius. Owner may prefer otherwise.
   - Edge indicators and shard pointers: use `Viewport.visibleBounds`, which follows the camera zoom already.
   - Hit contact, projectiles, walls, world bounds: world-space, never read the camera.
6. **Phone minimum.** The knob default minimum is 0.5 on every device (the spec's 0.67 phone floor is a shipped-default decision for later, since the lab is desktop-first). Noted in the knob label.

## File structure

- Create `src/game/zoom-pressure.js`: pure sampler, `sampleZoomPressure`.
- Create `src/game/solo-zoom.js`: `SOLO_ZOOM_DEFAULTS`, `SOLO_ZOOM_RANGES`, `SoloZoomController`.
- Modify `src/game/camera.js`: per-update zoom limits and zoom smoothing time.
- Modify `src/game/game.js` (thin wiring), `src/main.js` (reduced motion hook).
- Modify `src/ui/lab.js`, `src/ui/panelModel.js`, `src/ui/labPresets.js`: the knobs.
- Tests: `tests/game/camera.test.js` (extend), `tests/game/zoom-pressure.test.js`, `tests/game/solo-zoom.test.js`, `tests/game/solo-zoom-game.test.js` (new, Game wiring), `tests/game/solo-zoom-guard.test.js`, `tests/ui/lab.test.js`, `tests/ui/panelModel.test.js`, `tests/ui/labPresets.test.js`, `tests/ui/labPanel.test.js` (extend), `tests/browser/smoke-lab.mjs` (extend).

## Lane map

| Lane | Tasks | Files (disjoint) | Runs |
|---|---|---|---|
| A | 1 | `src/game/camera.js`, `tests/game/camera.test.js` | parallel with B, C, D |
| B | 2 | `src/game/zoom-pressure.js`, `tests/game/zoom-pressure.test.js` | parallel |
| C | 3 | `src/game/solo-zoom.js`, `tests/game/solo-zoom.test.js` | parallel |
| D | 5 | `src/ui/lab.js`, `src/ui/panelModel.js`, `src/ui/labPresets.js`, `tests/ui/*` | parallel (uses a stub of the Task 3 interface, defined below) |
| E | 4 then 6 | `src/game/game.js`, `src/main.js`, `tests/game/solo-zoom-game.test.js`, `tests/game/solo-zoom-guard.test.js` | after A, B, C (Task 6 also after D) |
| F | 7 | `tests/browser/smoke-lab.mjs` | after E and D |
| G | 8 | `AGENTS.md` | last |

Order: run A, B and C in parallel and merge them first (C is small and D imports it), then run D and E in parallel, then Task 6, F and G.

---

### Task 1: Camera zoom limits and smoothing per update (lane A)

**Files:**
- Modify: `src/game/camera.js` (`update`, `cut`, `sample`, the file header)
- Test: `tests/game/camera.test.js`

**Interfaces:**
- Produces: `Camera.update(deltaSeconds, { ..., targetZoom = 1, zoomMinimum = MINIMUM_CAMERA_ZOOM, zoomMaximum = 1, zoomSmoothSeconds = CAMERA_ZOOM_SMOOTH_SECONDS })`; `Camera.cut(focusX, focusY, { ..., zoom = 1, zoomMinimum = MINIMUM_CAMERA_ZOOM, zoomMaximum = 1 })`. The camera remembers the last limits (`this.zoomMinimum`, `this.zoomMaximum`, initially the old constants and 1) so `sample` clamps with them.

- [x] **Step 1: Write failing tests** in `tests/game/camera.test.js`:
  - `defaults keep the zoom inside [MINIMUM_CAMERA_ZOOM, 1]`: update with `targetZoom: 3` for 10 s, `camera.zoom === 1` (exactly); with `targetZoom: 0.1`, `camera.zoom` converges to `MINIMUM_CAMERA_ZOOM`.
  - `zoomMaximum raises the ceiling`: update with `targetZoom: 1.6, zoomMaximum: 1.6` for 10 s, `camera.zoom` within 1e-6 of 1.6; the view extents read `viewWidth / camera.zoom`.
  - `zoomMinimum lowers the floor`: `targetZoom: 0.3, zoomMinimum: 0.3` converges to 0.3.
  - `zoomSmoothSeconds sets the zoom rise`: with `zoomSmoothSeconds: 2`, after 0.5 s from zoom 1 toward 1.6, the zoom has covered less than half of what the default 0.5 s covers (compare two cameras).
  - `cut honors the limits`: `cut(16, 9, { ...VIEW, zoom: 1.5, zoomMaximum: 1.6 })` gives `camera.zoom === 1.5`; without `zoomMaximum`, 1.
  - `sample clamps with the last limits`: after the zoomMaximum 1.6 update at zoom 1.59 with positive `zoomVelocity`, `sample(1).zoom <= 1.6`.
  - `an omitted option is today's behavior`: an update sequence without the new options equals one that passes the defaults explicitly (deepEqual on `zoom`, `centerX`, `centerY`).
- [x] **Step 2: Run** `node --test tests/game/camera.test.js`. Expected: the new tests FAIL.
- [x] **Step 3: Implement** the options in `update`, `cut` and `sample` (store `zoomMinimum` and `zoomMaximum` on the camera in both `update` and `cut`; replace the three `clamp(..., MINIMUM_CAMERA_ZOOM, 1)` calls; replace the literal `2 / CAMERA_ZOOM_SMOOTH_SECONDS` with `2 / zoomSmoothSeconds`). Update the header comment (it says "the solo game never passes a target"): the solo game passes one only when the lab knob is on.
- [x] **Step 4: Run** `node --test tests/game/camera.test.js` then `npm test`. Expected: all PASS.
- [x] **Step 5: Mutation proof**: change the ceiling back to a literal 1 in `update`; the `zoomMaximum raises the ceiling` test must fail. Restore.
- [x] **Step 6: Commit** `Let the camera take per-update zoom limits and smoothing`.

---

### Task 2: Zoom pressure sampler (lane B)

**Files:**
- Create: `src/game/zoom-pressure.js`
- Test: `tests/game/zoom-pressure.test.js`

**Interfaces:**
- Produces:
  - `export const ZOOM_NEAR_RADIUS = 3.0;`
  - `export const ZOOM_FAR_VIEW_FACTOR = 1.1;`
  - `export const ZOOM_SAMPLE_POINTS = 8;`
  - `export function smoothstep(lower, upper, value): number` (0..1, clamped).
  - `export function sampleZoomPressure({ densityAt, focusX, focusY, viewWidth, viewHeight, bounds, capacityScale, crowdReference }): { near: number, far: number }` where `densityAt(x, y) -> number` is `Game.densityAt`, `viewWidth` and `viewHeight` are the current zoomed view extents, `bounds` is `{ minX, minY, maxX, maxY }`, `capacityScale` is `capacity / DENSITY_REFERENCE_CAPACITY`, `crowdReference` is the normalized density that reads as full crowding (the knob). Returns `near` and `far` in 0..1.
- Consumes: nothing from other tasks.

- [x] **Step 1: Write failing tests** (`tests/game/zoom-pressure.test.js`), using a synthetic `densityAt`:
  - `an empty map gives zero pressure`: `densityAt = () => 0` gives `{ near: 0, far: 0 }`.
  - `near ignores a crowd outside the near circle but far sees it`: density 5 only at points farther than 5 units from the focus and outside the view gives `near === 0`, `far > 0`.
  - `near sees a crowd at the focus`: density high within 3 units gives `near > 0.9`, `far === 0`.
  - `pressure is preset invariant`: the same field scaled by `capacityScale` (field times 0.25 with `capacityScale: 0.25`) gives the same `near` as scale 1 (within 1e-9).
  - `crowdReference scales the response`: doubling `crowdReference` lowers `near` for a mid-level field.
  - `far points outside the world are skipped, and an all-outside ring gives far 0`: focus at the world corner with a huge view; the count of `densityAt` calls for far is below 8 and `far` is finite.
  - `smoothstep` edges: `smoothstep(0.25, 1, 0.25) === 0`, `(…, 1) === 1`, midpoint 0.5 at the center of the interval's cubic (0.5 at t = 0.5).
- [x] **Step 2: Run** `node --test tests/game/zoom-pressure.test.js`. Expected: FAIL (module missing).
- [x] **Step 3: Implement** with the formulas in Design decision 2: near = `smoothstep(0.25, 1.0, mean(densityAt over focus + 8 ring points at ZOOM_NEAR_RADIUS) / (capacityScale * crowdReference))`; far = `smoothstep(0.15, 0.6, mean over the in-bounds points of the 8-point ring at radius ZOOM_FAR_VIEW_FACTOR * hypot(viewWidth, viewHeight) / 2 / (capacityScale * crowdReference))`; ring points evenly spaced by angle, starting at angle 0. Guard `capacityScale * crowdReference > 0` with a `RangeError`.
- [x] **Step 4: Run** the test file. Expected: PASS.
- [x] **Step 5: Mutation proof**: drop the `capacityScale` divisor; the preset invariance test must fail. Restore.
- [x] **Step 6: Calibrate the default (one time).** Write a throwaway script in `.claude/scripts/` (delete it after) or use the lab in a browser to read `game.simulation.densityAt` at the swarm in a ramped play run, near a heavy crowd, at capacity 524288 (so `capacityScale` is 1); pick `ZOOM_DEFAULT_CROWD_REFERENCE` so a fully crowded spot reads near 1. Record the measured numbers (count and reproduction command, not raw output) in the commit body and export the constant from this file: `export const ZOOM_DEFAULT_CROWD_REFERENCE = <measured>;` with a comment naming it a lab-tuned placeholder. Task 3 imports it.
- [x] **Step 7: Commit** `Add the zoom pressure sampler`.

---

### Task 3: Solo zoom controller (lane C)

**Files:**
- Create: `src/game/solo-zoom.js`
- Test: `tests/game/solo-zoom.test.js`

**Interfaces:**
- Consumes: `ZOOM_DEFAULT_CROWD_REFERENCE` from Task 2 (`src/game/zoom-pressure.js`). If lane B has not landed, export a literal placeholder `1` in a clearly marked import and switch when B merges.
- Produces:
  - `export const SOLO_ZOOM_DEFAULTS = Object.freeze({ enabled: false, minimum: 0.5, maximum: 1.6, punchIn: Math.log(1.4), pullOut: Math.log(1 / 0.6), smoothSeconds: 1.2, rateLimit: 0.35, crowdReference: ZOOM_DEFAULT_CROWD_REFERENCE })`.
  - `export const SOLO_ZOOM_RANGES = Object.freeze({ minimum: [0.3, 1], maximum: [1, 2.5], punchIn: [-0.7, 1], pullOut: [0, 1], smoothSeconds: [0.2, 4], rateLimit: [0.05, 2], crowdReference: [<default / 100>, <default * 100>] })` (`enabled` is boolean).
  - `export const ZOOM_PRESSURE_ATTACK_SECONDS = 0.4; ZOOM_PRESSURE_RELEASE_SECONDS = 2.0; ZOOM_HYSTERESIS = 0.04; ZOOM_FIT_FRACTION = 0.7; ZOOM_FIT_MARGIN = 1.0;`
  - `class SoloZoomController` with: `get settings()` (a copy), `set(name, value)` (throws `RangeError` naming the key for an unknown key, a non-boolean `enabled`, or a number outside `SOLO_ZOOM_RANGES`; also throws when `minimum > maximum` after the change), `reset()` (pressures and log target to 0, last zoom 1), `hold()` returns the last zoom with no state change, `update(deltaSeconds, { near, far, swarmRadius, viewWidth, viewHeight }) -> number` the target zoom, and `get lastZoom()`.
  - `export function zoomFit(swarmRadius, viewWidth, viewHeight): number` = `0.5 * min(viewWidth, viewHeight) * ZOOM_FIT_FRACTION / (swarmRadius + ZOOM_FIT_MARGIN)`.

- [x] **Step 1: Write failing tests** (deltas injected, 1/60 s steps):
  - `defaults are off and match the spec candidates`: `enabled === false`, `maximum === 1.6`, `minimum === 0.5`, `punchIn` close to `Math.log(1.4)`, `pullOut` close to `Math.log(1 / 0.6)`.
  - `set validates`: out-of-range, unknown key, `enabled: 1`, and `minimum` above `maximum` each throw `RangeError`; a valid value is stored and visible in `settings`; `settings` returns a copy (mutating it changes nothing).
  - `no pressure gives zoom 1`: 5 s of `near: 0, far: 0, swarmRadius: 1` gives exactly 1 (fit is 1.575 so no cap).
  - `crowded punches in`: `near: 1` for 10 s with radius 0.5 reaches `exp(punchIn)` within 1e-3 (fit is 2.1 so it does not cap).
  - `a negative punchIn pulls out when crowded`: `punchIn: -0.5`, `near: 1` converges to `exp(-0.5)`.
  - `far action pulls out only when quiet nearby`: `far: 1, near: 0` converges to `exp(-pullOut)`; `far: 1, near: 1` converges to `exp(punchIn)` (the `(1 - near)` factor).
  - `rate limit`: from rest with a step of `near: 1`, the log of the output never changes by more than `rateLimit * deltaSeconds + 1e-9` per update.
  - `attack is faster than release`: after `near: 1` for 1 s the smoothed pressure is above 0.9 of its limit; after then `near: 0` for 1 s it is still above 0.5 (assert through the zoom output, since the pressures are private).
  - `hysteresis`: a desired log change under 0.04 from the current target leaves the output unchanged.
  - `fit cap`: `swarmRadius: 8` (256-ship scale), `near: 1`, `punchIn: 1` gives an output at or below `zoomFit(8, 16, 9)` (0.35) lifted to `minimum` (0.5): the output is exactly `max(minimum, min(maximum, fit))`, so 0.5.
  - `output stays inside [minimum, maximum]` over a randomized-by-fixed-sequence set of inputs (use a fixed array of 200 input triples, no `Math.random`).
  - `hold returns the last zoom and does not advance state`: after updates, `hold()` equals the last output; a following `update` continues as if `hold` never ran (compare to a twin controller).
  - `reset returns to 1`.
- [x] **Step 2: Run** `node --test tests/game/solo-zoom.test.js`. Expected: FAIL (module missing).
- [x] **Step 3: Implement.** Per update: smooth `near` and `far` toward their inputs with `alpha = 1 - exp(-dt / tau)`, tau attack when rising and release when falling; `wish = punchIn * nearSmooth - pullOut * farSmooth * (1 - nearSmooth)`; move `logTarget` toward `wish` by at most `rateLimit * dt`, but only when `abs(wish - logTarget) >= ZOOM_HYSTERESIS`; output `clamp(exp(logTarget), minimum, max(minimum, min(maximum, zoomFit(...))))`; store as `lastZoom`. Header comment states: pure, no clock, no `Math.random`; the camera spring applies `smoothSeconds`.
- [x] **Step 4: Run** the test file. Expected: PASS.
- [x] **Step 5: Mutation proof**: remove the `(1 - nearSmooth)` factor (far/near test fails); remove the fit cap (fit test fails); remove the rate limit (rate test fails). Restore each.
- [x] **Step 6: Commit** `Add the solo zoom controller`.

---

### Task 4: Game wiring (lane E, after A, B, C)

**Files:**
- Modify: `src/game/game.js` (`followCamera`, a new `setReducedMotion`, `setSoloZoomSetting`, the `spawnCounts` view argument, the constructor; keep the added lines under about 60)
- Modify: `src/main.js` (`applySettings`: one line calling `game.setReducedMotion(Boolean(current.reducedMotion))`)
- Test: `tests/game/solo-zoom-game.test.js` (new; copy the fakes and `createGame` style from `tests/game/game.test.js`)

**Interfaces:**
- Consumes: `Camera.update` limits (Task 1), `sampleZoomPressure` (Task 2), `SoloZoomController` and `zoomFit` (Task 3).
- Produces: `game.soloZoom` (a `SoloZoomController`), `game.setSoloZoomSetting(name, value)` (delegates to `soloZoom.set`), `game.setReducedMotion(flag: boolean)`, and `game.reducedMotion` (boolean, default false). Lab and tests use these names.

Behavior of `followCamera` (the non-cut update path), pinned by the tests below:
1. `focuses = framedFocuses(seats)` as today; solo mode applies when `liveSeats(this.seats).length === 1` and `this.soloZoom.settings.enabled` and `!this.reducedMotion` and the phase is Playing and `!this.watching`.
2. Solo mode: `{ near, far } = sampleZoomPressure({ densityAt: this.densityAt, focusX, focusY, viewWidth: this.view.width, viewHeight: this.view.height, bounds: this.worldBounds, capacityScale: this.simulation.capacity / DENSITY_REFERENCE_CAPACITY, crowdReference })`; `swarmRadius` is the largest distance from the seat's `cameraFocus` to a ship in `seat.swarm.ships` (alive only; up to 256, once per update); `targetZoom = this.soloZoom.update(deltaSeconds, {...})`; the camera is passed `zoomMinimum` and `zoomMaximum` from the settings and `zoomSmoothSeconds` from `smoothSeconds`.
3. Hold (call `this.soloZoom.hold()` instead of `update`) when a bomb was accepted this update, or the time warp is easing (read `src/game/time-warp.js` for the accessor that tells the eased scale differs from its target), or the run phase is not Playing.
4. Otherwise (feature off, reduced motion, two or more live seats, Ready, watch): `this.soloZoom.reset()` and today's code path exactly (`targetZoom = fitZoom(...)`, no new options), so the arguments to `camera.update` are today's.
5. `cut` (start, quit, respawn): `soloZoom.reset()`, zoom 1 (solo) or `fitZoom` (co-op) as today.
6. `spawnCounts`: pass `view: this.ringView` where `ringView` is `this.view` with `width` and `height` set to `viewSize.width / Math.min(1, camera.zoom)` and `viewSize.height / Math.min(1, camera.zoom)` (Design decision 5). With zoom at or below 1 it equals `this.view` exactly, so co-op and the default are unchanged.

- [x] **Step 1: Write failing tests** (`tests/game/solo-zoom-game.test.js`; a stubbed `simulation.densityAt` returning a constant, fixed `deltaSeconds`):
  - `the default game never leaves zoom 1 in solo, whatever the density`: 600 updates in Playing with `densityAt = () => 1e9`; `camera.zoom === 1` exactly and `camera.update` was always called without `zoomMaximum` (spy).
  - `enabled and crowded zooms in past 1`: `setSoloZoomSetting('enabled', true)`, `crowdReference` at its minimum, 600 updates; `camera.zoom > 1.05` and `<= 1.6`.
  - `enabled, far action only, zooms out`: density high only at the far ring (stub by distance from the focus), `punchIn` default; `camera.zoom < 0.95` and `>= 0.5`.
  - `reduced motion keeps zoom 1`: same crowded setup with `setReducedMotion(true)`; `camera.zoom === 1` after 600 updates; turning it off lets the zoom move again.
  - `two live seats ignore the knob`: two seats, enabled, crowded; `camera.update` receives no `zoomMaximum` above 1 (spy) and the zoom equals the zoom of an identical game with the knob off (deepEqual over 300 updates).
  - `a down seat hands over without a jump`: two seats framing, then seat 2 down, enabled; the zoom after one update differs from before by no more than the spring allows (below 0.1), and the controller `lastZoom` is 1 on the first solo-mode update.
  - `bomb and death hold the target`: after zooming in, accept a bomb; the controller `update` is not called that step (spy) and `hold` is.
  - `the start cut resets the controller`: after zooming in, `quitToTitle` then `start`; `camera.zoom === 1` and `soloZoom.lastZoom === 1`.
  - `the bomb radius ignores the zoom`: zoom in to 1.4, bomb; `requestRadialKill` radius equals `bombRadiusForView(viewSize.width, viewSize.height)`.
  - `the spawn ring view caps its zoom at 1`: zoom in to 1.4; the `view` given to `spawnDirector.update` has width `viewSize.width`; zoomed out to 0.6 it has width `viewSize.width / 0.6`.
  - `setSoloZoomSetting rejects bad values` (RangeError passes through).
- [x] **Step 2: Run** `node --test tests/game/solo-zoom-game.test.js`. Expected: FAIL.
- [x] **Step 3: Implement** per the behavior list. Put the solo branch in a small helper module if `game.js` growth exceeds the budget: `src/game/solo-zoom-step.js` exporting `soloZoomTarget(game, deltaSeconds)` (taking the `Game` as context, like `seats.js`); `followCamera` calls it.
- [x] **Step 4: Run** the new test file, then `npm test`. Expected: PASS everywhere, including the existing co-op camera tests.
- [x] **Step 5: Mutation proof**: delete the reduced-motion condition (the reduced motion test fails); delete the live-seat-count condition (two-seat test fails); make `ringView` equal `view` (ring test fails). Restore each.
- [x] **Step 6: Commit** `Wire the solo zoom into the follow camera`.

---

### Task 5: Lab knobs (lane D, after C; parallel with E)

**Files:**
- Modify: `src/ui/lab.js` (`LAB_KNOB_BINDINGS`, `LAB_KNOB_DEFAULTS`)
- Modify: `src/ui/panelModel.js` (a `Camera` group in `LAB_KNOB_GROUPS`, after `Beam`)
- Modify: `src/ui/labPresets.js` (`KNOB_RANGES`)
- Test: `tests/ui/lab.test.js`, `tests/ui/panelModel.test.js`, `tests/ui/labPresets.test.js`, `tests/ui/labPanel.test.js`

**Interfaces:**
- Consumes: `SOLO_ZOOM_DEFAULTS`, `SOLO_ZOOM_RANGES`, `SoloZoomController` (Task 3); the `Game` names from Task 4 (`game.soloZoom.settings`, `game.setSoloZoomSetting`). In `tests/ui/lab.test.js`'s `createContext()` fake game add `soloZoom: new SoloZoomController()` and `setSoloZoomSetting(name, value) { this.soloZoom.set(name, value); }`.
- Produces: eight knobs, with these keys, labels, specs and bindings (setting name in brackets):
  - `soloZoomEnabled` [enabled], label `solo zoom (0 off, 1 on)`, min 0, max 1, step 1, integer; read `settings.enabled ? 1 : 0`; write `value >= 0.5`; default 0.
  - `soloZoomMinimum` [minimum], label `zoom minimum (phones want 0.67)`, 0.3 to 1, step 0.01, default 0.5.
  - `soloZoomMaximum` [maximum], label `zoom maximum`, 1 to 2.5, step 0.01, default 1.6.
  - `soloZoomPunchIn` [punchIn], label `punch in when crowded (ln, negative pulls out)`, -0.7 to 1, step 0.01, default `Math.log(1.4)`.
  - `soloZoomPullOut` [pullOut], label `pull out when action is elsewhere (ln)`, 0 to 1, step 0.01, default `Math.log(1 / 0.6)`.
  - `soloZoomSmoothSeconds` [smoothSeconds], label `zoom smoothing seconds`, 0.2 to 4, step 0.05, default 1.2.
  - `soloZoomRateLimit` [rateLimit], label `zoom rate limit (ln per second)`, 0.05 to 2, step 0.05, default 0.35.
  - `soloZoomCrowdReference` [crowdReference], label `crowd reference (density that reads as full)`, the `SOLO_ZOOM_RANGES.crowdReference` range, a step of one hundredth of the default.
  All written through `game.setSoloZoomSetting`. Each key also in `KNOB_RANGES` and `LAB_KNOB_DEFAULTS`.

Because `captureLabState` and `restoreLabState` iterate `MIX_KNOB_SPECS`, leaving the lab restores every one of these with no extra code; the tests below prove it.

- [x] **Step 1: Write failing tests**, following `tests/ui/lab.test.js`'s beam knob tests (commit e10655e is the template):
  - `the solo zoom knobs have the specified ranges, steps and shipped defaults` (loop like the beam test; also `assert.deepEqual(KNOB_RANGES[key], [spec.minimum, spec.maximum])` and equality with `SOLO_ZOOM_DEFAULTS` and `SOLO_ZOOM_RANGES`; `LAB_KNOB_DEFAULTS.soloZoomEnabled === 0`).
  - `the solo zoom knobs read and write the game and round-trip through a shared mix` (write each, `captureMix`, `decodeMix(encodeMix(...))`, `applyMix` onto a fresh context).
  - `leaving the lab restores the solo zoom knobs` (enable and change two knobs, `captureLabState` before and `restoreLabState` after; `game.soloZoom.settings` equals the defaults).
  - `crossing minimum and maximum never throws from the lab`: with maximum 1.0, `writeKnob` of `soloZoomMinimum` 1 succeeds; writing `soloZoomMinimum` above the current maximum raises the maximum to match; writing `soloZoomMaximum` below the current minimum lowers the minimum to match.
  - `an older mix without the keys leaves the defaults` and `a mix with soloZoomMaximum 9 is rejected by decodeMix` (`labPresets.test.js`).
  - `the Camera group appears once in the panel with eight sliders` (`panelModel.test.js`, `labPanel.test.js`: the panel renders eight inputs with `data-knob` for these keys, DOM faked as the existing tests do).
- [x] **Step 2: Run** `node --test tests/ui/lab.test.js tests/ui/panelModel.test.js tests/ui/labPresets.test.js tests/ui/labPanel.test.js`. Expected: new tests FAIL.
- [x] **Step 3: Implement** the bindings, specs, ranges and defaults. In `lab.js` add a small helper `soloZoomValue(key, setting)` like `simulationValue`. The `minimum`/`maximum` ordering rule: the binding for either key, when the new value would cross the other, also sets the other to the new value so `SoloZoomController.set` never throws from the lab.
- [x] **Step 4: Run** the four files, then `npm test`. Expected: PASS.
- [x] **Step 5: Mutation proof**: remove `soloZoomEnabled` from `KNOB_RANGES` (round-trip and range tests fail); make the enabled write always `true` (the restore test fails). Restore.
- [x] **Step 6: Commit** `Add the solo zoom lab knobs`.

---

### Task 6: Guard test that the game never enables solo zoom (lane E, after 4 and 5)

**Files:**
- Test: `tests/game/solo-zoom-guard.test.js`

**Interfaces:** model on `tests/game/seek-range-guard.test.js` (reuse its `sourceFiles` walker, copy it; it is a test-local helper).

- [x] **Step 1: Write the tests:**
  - `setSoloZoomSetting appears only in the Game (definition) and the lab binding`: `assert.deepEqual(files.sort(), ['src/game/game.js', 'src/ui/lab.js'])`.
  - `the shipped Game starts with solo zoom off`: create a game the way `tests/game/game.test.js` does (or import `SOLO_ZOOM_DEFAULTS`): `SOLO_ZOOM_DEFAULTS.enabled === false` and `new SoloZoomController().settings.enabled === false`.
  - `nothing but the lab calls soloZoom.set`: the same file scan for `soloZoom.set(` returns only `src/game/game.js`.
- [x] **Step 2: Run** `node --test tests/game/solo-zoom-guard.test.js`. Expected: PASS (it guards the finished wiring, so it cannot fail before).
- [x] **Step 3: Mutation proof (required here instead of red-first):** temporarily add `game.setSoloZoomSetting('enabled', true)` to `src/main.js`; the first test must fail. Remove it.
- [x] **Step 4: Commit** `Guard that only the lab enables the solo zoom`.

---

### Task 7: Browser check (lane F, after D and E)

**Files:**
- Modify: `tests/browser/smoke-lab.mjs` (add `checkSoloZoom(baseUrl)` and call it from the main sequence; or, if the file would pass about 500 lines, create `tests/browser/smoke-solo-zoom.mjs` with the same launch helpers and register it in `tests/browser/browser-launchers.test.js` expectations by fixed spelling, tearing the server down through `server.stop()`)

**Interfaces:** reuses `setSlider`, `waitFrames`, `open`, `expect`, `expectNoErrors` from the file. Time is counted in animation frames (`waitFrames`), never wall-clock assertions. The page runs with `probe=off` and a pinned capacity as the existing lab checks do.

- [x] **Step 1: Write the check:**
  1. Open the lab, press Play (read how the existing checks start a run: `lab.play()`/the Play button), wait `SETTLE_FRAMES`.
  2. With the knob off (default): hold 120 frames in Playing; assert `game.camera.zoom === 1`.
  3. `setSlider(page, 'soloZoomEnabled', 1)`, `setSlider(page, 'soloZoomCrowdReference', <the range minimum>)` and `setSlider(page, 'soloZoomPunchIn', 0.6)`; wait 300 frames; assert `game.camera.zoom > 1.05` and `<= 1.6`, and `game.view.width < game.viewSize.width`.
  4. `setSlider(page, 'soloZoomPunchIn', -0.5)`; wait 300 frames; assert `game.camera.zoom < 1` (the opposite convention).
  5. Reduced motion: call `game.setReducedMotion(true)` through `page.evaluate`; wait 300 frames; assert `camera.zoom` within 1e-3 of 1 (the spring eases back, so use a settle of 600 frames).
  6. Leave the lab to the title; assert `game.soloZoom.settings.enabled === false` and every other setting equals `SOLO_ZOOM_DEFAULTS` (read through `lab.capture()` is not needed; read `game.soloZoom.settings`), then start a normal run and assert zoom stays 1 for 120 frames.
  7. `expectNoErrors(page, 'solo zoom')`.
- [x] **Step 2: Run** `node tests/browser/smoke-lab.mjs` (or the new file). Expected: passes with a GPU adapter, prints a `smoke-lab: solo zoom ...` line; exit 2 means no adapter (then report it as not exercised, with `WEBGPU_ADAPTER=fallback` as the software attempt).
- [x] **Step 3: Mutation proof**: with the knob on, comment out the `camera.update` zoom option in the solo helper (Task 4); the check must fail at step 3. Restore.
- [x] **Step 4: Run** `npm test` (the launcher spelling test) and commit `Check the solo zoom in the lab browser run`.

---

### Task 8: Documentation (lane G, last)

**Files:**
- Modify: `AGENTS.md`

- [x] **Step 1: Run the docs-update check** and update, with exact wording drawn from the new code: the Global constraints camera paragraph ("at zoom 1 in solo" gains "unless the lab's solo zoom is on, default off; `soloZoom*` knobs"); the Co-op "Camera" bullet (co-op unchanged, the solo controller idle with two live seats); Frame order step 2 (`Game.followCamera` solo branch, hold rules, reduced motion forces 1); the view dependants list from Design decision 5 (bomb, safe distance and pickups unzoomed, gate ring zoomed but capped at zoom 1); File map entries for `solo-zoom.js`, `zoom-pressure.js`, `solo-zoom-step.js` (if created) and the new tests; the browser check entry; and a sentence pointing to `tests/game/solo-zoom-guard.test.js` like the seek range one.
- [x] **Step 2: Verify** no em-dashes: `rg -n "\x{2014}" AGENTS.md docs/superpowers/plans` finds nothing in the lines you touched; run `npm test`.
- [x] **Step 3: Commit** `Document the solo camera zoom lab knobs`.

---

## Self-review notes

- Spec coverage: 4.3 inputs (Task 2), log space, rate limit, hysteresis, attack/release, fit cap (Task 3), camera application (Tasks 1, 4), reduced motion (Task 4), rendering already built for co-op (no task; the browser check confirms zoom above 1 renders without errors; trails and ship size follow `Camera.sample` zoom as in co-op), item 4 convention (negative punch-in), item 3 range (knobs). Deviations are listed under Design decisions.
- Rendering at zoom above 1 is new to the renderer (co-op only goes to 0.5 to 1). Task 7 only checks for errors, not visuals. The implementer of Task 7 should also take one screenshot at zoom near 1.6 into `artifacts/` for the owner's taste pass (not committed).
- Type consistency: setting names `enabled, minimum, maximum, punchIn, pullOut, smoothSeconds, rateLimit, crowdReference` are used the same in Tasks 3, 4 and 5; knob keys are `soloZoom` plus the capitalized setting name.
