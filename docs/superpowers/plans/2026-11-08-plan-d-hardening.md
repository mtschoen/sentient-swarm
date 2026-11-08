# Plan D: Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden Sentient Swarm v1 (owner ruling R24: "sweep for code quality, get coverage back to 100% and set up CI") without changing how it plays: a behavior-neutral simplification sweep, every deferred Minor from Plans A, B and C fixed with a regression test or dropped with a reason, the tests skipped under R23, a diagnosed quality.mjs carry gate, a coverage gate, and GitHub Actions checks.

**Architecture:** Three disjoint simplification lanes (sim and gpu, render, game and ui) land first, guarded by the existing suite and browser checks. Bug-fix lanes follow by area, each fix carrying a test that fails before it. Coverage uses Node's built-in test coverage (no new dependency) scoped to the modules node can import. CI is a new check workflow on every push and pull request (unit tests, coverage gate, build) plus a software-GPU job for the small GPU page checks; the full browser suite runs on a self-hosted GPU runner the owner registers, and stays local until then.

**Tech Stack:** As Plans A to C: plain JavaScript ES modules, WGSL, node:test, Vite and Playwright (dev only), GitHub Actions with SHA-pinned actions.

**Spec:** `docs/superpowers/specs/2026-11-06-murmuration-design.md` (governs; this plan adds no features).

## Global Constraints

- Everything in AGENTS.md "Global constraints (binding)" binds every task, verbatim.
- No behavior or feel change except the bug fixes listed in the triage below. Difficulty is count not toughness; one-hit kills; every projectile kind pierces; no clumps; no tuning-constant changes.
- Plain JavaScript and WGSL; no runtime dependencies; no new dev dependency (coverage is `node --test --experimental-test-coverage`, Node 22 and later).
- Full-word identifiers; no em-dashes (U+2014) anywhere; no hard-coded machine paths; tests inject time (no wall-clock assertions); files under about 500 lines or a one-line note at the top.
- Mobile WebGPU limits from AGENTS.md (8 storage buffers per stage, 16-byte aligned structs, no `vec3` in storage, workgroup size at most 256, workgroup memory at most 16 KB).
- Workflow actions are pinned by full commit SHA with the version in a trailing comment, reusing the pins already in `.github/workflows/pages.yml`; no new third-party action.
- Commit after every task, imperative message, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Lane rules

- AGENTS.md is binding: read it fully (constraints, pass order, frame order, file map).
- Work ONLY in the worktree your dispatch names. The primary checkout C:/Users/mtsch/murmuration is read-only. Never push (no remote, owner ruling R5).
- FIRST ACTION: confirm `git rev-parse HEAD` equals the base SHA your dispatch names, else STOP with BLOCKED.
- Edit only the files your task lists. A needed edit outside the list stops the lane with NEEDS_CONTEXT.
- Stage files by name; never `git add -A` or `git add .`. Multi-line messages use `git commit -F - <<'EOF'`.
- Browser checks: export `SMOKE_PORT=<your port>` (ports below; 5174 and 5180 are never yours). Run long commands in the foreground with a generous timeout, teed to `artifacts/` (gitignored). Never use `run_in_background`.
- A fix is RED then GREEN: run the new test before the fix and paste the failing line, then after. If the test passes before the fix, the item is already fixed: record "already fixed, test kept" and move on.
- Simplification deletes only with reference evidence (Grep for every caller, export and shader entry point; use the simplifying-a-codebase skill). Unsure means keep.
- Never commit logs, PNGs, coverage output or raw tool output.
- You do not dispatch subagents.
- Report INSIDE your worktree at `.superpowers/sdd/2026-11-08-plan-d-hardening/task-<id>-report.md`: what changed, files, RED and GREEN lines, browser check result lines, assumptions, concerns. Reply with ONLY: Status (DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT), commits, one-line test summary, concerns, report path. Under 15 lines.

## Review Focus

1. A "dead" export that a WGSL entry point, a test page under `tests/browser/pages/`, or `window.__murmuration` reads: deleting it must not break a browser check (review D1 to D3 against `git grep` of each removed name).
2. Shader constant substitution (D1): a constant now injected into WGSL must produce byte-identical behavior; projectiles.mjs, player.mjs, grid.mjs and simulation.mjs must pass unchanged.
3. A capacity swap that never settles (D4): stepping resumes on the old simulation after the timeout and the HUD, score and stats keep working.
4. Out-of-order staging readbacks (D5): kills are never scored twice or negative when an older slot maps late.
5. CI on a runner without a GPU (D10, D11): the software job reports "no adapter" as a failure with a clear message, never as a silent pass.

## Triage of deferred Minors (binding)

Sources: the Plan C controller report, final-review-game.md, final-review-render.md, final-review-audio.md, the Plan B summary and the Plan A progress ledger (all under C:/Users/mtsch/murmuration/.superpowers/sdd/archive/). Each fix-now item names its task; the lane verifies the item is still open (Lane rules, RED step).

**Fix now (each with a regression test):**

| Item | Task |
| --- | --- |
| A: CapacitySwap has no timeout, so stepping stays paused if a recreate never settles; a rejected recreate is unhandled | D4 |
| A: FrameLoop start() after stop() with a pending frame runs two tick chains | D4 |
| B4: unbounded fire loop on a huge deltaSeconds; zero aim while firing leaves the accumulator | D4 |
| B5: rotationSeconds <= 0 loops forever; the placement fallback can land a pickup near the player at corners | D4 |
| B1: start() does not reset respawnSequence; recordHit leaves a pending milestone flag | D4 |
| B2: more than capacity minus one queueSpawn calls in a frame share a slot silently | D4 |
| C2: QualityController.apply persists the preset when setCapacity resolves false | D4 |
| A and B6: pointercancel and window blur leave primaryDown and secondaryDown stuck | D5 |
| B8: touch Play again can restart twice (pointerdown then click); hud.js restart guard uses wall-clock `performance.now()` | D5 |
| C final wave: Settings opened while paused only by the rotate overlay shows the pause menu under it | D5 |
| C final wave: settings sliders lose keyboard focus after each arrow step | D5 |
| C1: SettingsStore.load does not range-check numbers | D5 |
| C6b: decodeMix admits rule values outside RULE_RANGES | D5 |
| A Task 15: backquote toggles the lab while typing in a lab number field | D5 |
| C3: rumble play() has no guard for a synchronous playEffect throw | D5 |
| C5: a melodic stab queued before a death dropout plays after it (pendingHit not cleared) | D5 |
| A: NaN shares propagate through normalizeShares | D6 |
| A: StagingRing.tryRead returns a newer ready slot while an older one is still mapping | D6 |
| A, B, C2: BindGroupCache keeps entries for destroyed particle buffers after a resize | D6 |
| A: Viewport.setCanvasSize(0, 0) divides by zero | D6 |
| B7: the ship heading eases on simulation.time, which a capacity swap resets | D4 |
| B2: the pulse orb's final travel segment is not capsule-collided on its conversion step | D6 |
| C render Minor 1: bloom medium and low take one tap per output texel and shimmer | D7 |
| C P42: quality.mjs alive-carry gate fails (diagnosis first) | D8 |
| A Task 2 and 11w: smoke readiness cannot tell its Vite child from a foreign server; bad `--frames` throws before try; non-secure SMOKE_URL misreported as exit 2; child.kill() not awaited; "stats:" message spacing | D9 |
| A Task 4: pages.yml top-level `name` uses an expression | D11 |

**Simplification (no behavior change), by task:** D1: AtomicAgent and the particle-claim loop duplicated in kill_debug.wgsl and projectiles_collide.wgsl; kind and flag constants duplicated across JS, WGSL and the test page; projectiles.js BEAM_KIND; DebugKillPass and KillAllPass buffer lists; DEFAULT_PLAYER_RADIUS twice; five per-step hue copies into one write on setSpecies; steer.wgsl hard-coded `2u` for VECTORS_PER_CELL; density-readback.js inline WGSL into `shaders/density_sum.wgsl`; IMPULSE_CAPACITY and IMPULSE_DURATION_SECONDS by comment only; simulation-check.js WALL_MARGIN mirror; the unwritten SimParams aliveTarget (mark reserved, do not move offsets); comment drift (particle cursor wrap, one-sided edge gradients, spawner.js header against DEFAULT_RAMP, long lines in common.wgsl, spawn-director.js:20, stats.wgsl header). D2: quad, feather and unused pixelScale duplicated across three render shaders; per-frame Float32Array allocations in the ship, pickup and projectile renderers; ParticleRenderer's redundant pool constructor argument; sampleField recomputing the density sum per vertex. D3: appendShot public; removeProjectilePass unused; controlsFrom outside Playing; main.js per-frame merged stats object; the dead `.hud-bands` class; the quality.js dead resize branch; the densityAt closure per update and the per-step arpeggio array; RunState header on action draining; Game header length; long lines in settings.js, main.js and menu.js; `g` in layout.test.js; the garbled comment in params.test.js.

**Dropped, with reason:** B4 taps shorter than the fire interval never shoot (feel, P21; owner tuning). A separation divisor, pressure safeNormalize, wall push after the speed clamp, Lattice breathing (steering feel; the swarm session R20, R27). C render Minor 4 half-rate glyph lag and C2 30 Hz half-rate updates (documented phoneLow tradeoff). C render Minor 5 beam fan fill cost (needs a phone measurement; owner device). B9 ring impulse stamped at read time and pickup impulse at the ship (a few frames, invisible). B9 no automated displacement check, A grid layer not bloomed (visual). A capture() not re-entrant and FrameCapture.request without timeout (test hook; every smoke evaluate is bounded). A canvas sized from clientWidth (index.html sizes it), resize observer never disconnected (page lifetime). A Task 15 lastStats stale a few frames after a swap; C2 kills in flight at install scored at the new capacity (bounded). A floor sums off by one, spawn give-back units unspent (bounded, band tolerates). B3 kill_all killAllRequested guard (defensive, cheap). C2 failing apply retries every 3 s; C6b radius swap pending at leave; C0b2 gateCount 1 stall; C6a loadMix index; C7 haptics Proxy identity; C7 full-strip HUD zones; C4 focusFromPointer; C5 resume after interruption; C1 save without merge (load tolerates). C2 upward swaps to 2M unmeasured and the README measured table (measurement, local only). Resolved earlier (verify only): B2 ring thread cost, B4 beam expired flag, B6 mid-run restart credit, B10 README wording, C0 slider cap, C0b2 count floor, C6b watch note, C7 bombHeld, C6a share cap.

## Phase 1: Baseline and simplification (parallel)

D0 to D3 touch disjoint files and run in parallel from the plan base. Integration order D0, D1, D2, D3.

### Task D0: Coverage gate (about 1 hour, port none)

**Files:** Modify `package.json`. Create `tests/coverage.test.js`.

**Interfaces:** Produces `npm run coverage` (D12 raises its thresholds).

- [ ] **Step 1:** Add the script `"coverage": "node --test --experimental-test-coverage --test-coverage-include=\"src/**/*.js\" <exclusions> --test-coverage-lines=<N> --test-coverage-functions=<N> \"tests/**/*.test.js\""`. Exclusions are the modules whose bodies need a GPU device or a DOM (for example `src/main.js`, `src/gpu/device.js`, renderer and pass classes); decide each by running coverage once and reading which files node cannot reach, and list every excluded file with a one-line reason in the report.
- [ ] **Step 2:** Set each threshold to the measured value rounded down to a whole percent. Run `npm run coverage`; expect exit 0 and the summary table. Lower a threshold by one and confirm a deliberately deleted test makes it exit non-zero, then restore.
- [ ] **Step 3:** `tests/coverage.test.js`: `test('coverage script excludes only listed files', ...)` reads package.json and asserts every `--test-coverage-exclude` glob matches at least one existing file (no stale exclusions).
- [ ] **Step 4:** Commit `Add a coverage gate on the node-reachable modules`.

Verify: `npm test`, `npm run coverage`. Review focus: no excluded file that node could import with a fake.

### Task D1: Simplify the simulation and GPU layers (about 3 hours, port 5184)

**Files:** `src/sim/**`, `src/gpu/**`, `src/game/projectiles.js` (constants only), `tests/sim/**`, `tests/gpu/**`, `tests/browser/pages/projectiles-check.js`, `tests/browser/pages/simulation-check.js` (imports only).

**Interfaces:** Kind and flag constants have one JS source (`src/game/weaponTypes.js` PROJECTILE_KINDS or `src/sim/layout.js`, whichever already owns most of them) and reach WGSL through `src/gpu/shaders.js` constant substitution; shared WGSL helpers live in `common.wgsl` or a new shader prepended the way `ships.wgsl` is.

- [ ] **Step 1:** List each D1 item from the triage with its file:line and the evidence (callers found). Keep the list in the report.
- [ ] **Step 2:** One item at a time: change, run `npm test` and the browser check that exercises it (projectiles.mjs for kinds and the claim loop, player.mjs for kill passes, simulation.mjs for hues and spawn, grid.mjs for VECTORS_PER_CELL). A failing check reverts that item.
- [ ] **Step 3:** Add `test('every projectile kind constant substituted into WGSL equals PROJECTILE_KINDS', ...)` in `tests/gpu/shaders.test.js` asserting the substituted source contains each kind's value under its constant name.
- [ ] **Step 4:** Commit `Remove duplicated simulation helpers and constants`.

Verify: `npm test`, `npm run smoke`, `node tests/browser/projectiles.mjs`, `player.mjs`, `simulation.mjs`, `grid.mjs`, `steer.mjs`. Review focus: Review Focus 1 and 2; the 8-binding limit in collide and kill passes.

### Task D2: Simplify the render layer (about 2 hours, port 5185)

**Files:** `src/render/**`, `tests/render/**`.

- [ ] **Step 1:** Move the shared quad and feather helpers into one WGSL header prepended by `render-shaders.js`; drop the unused pixelScale after grepping all three shaders.
- [ ] **Step 2:** Replace per-frame Float32Array allocations with one buffer per renderer, reused; drop ParticleRenderer's constructor pool argument (encode receives it); hoist the density sum in sampleField.
- [ ] **Step 3:** Capture a before PNG and an after PNG with `node tests/browser/capture-weapons.mjs before` and `after`; compare `npm run smoke` luminance lines (must match within 0.002).
- [ ] **Step 4:** Commit `Share render shader helpers and reuse view buffers`.

Verify: `npm test`, `npm run smoke`, `node tests/browser/smoke.mjs --play 600`. Review focus: identical luminance, no new allocation per frame (grep `new Float32Array` in encode paths).

### Task D3: Simplify game, ui, input, audio and settings (about 3 hours, port 5186)

**Files:** `src/game/**` except `projectiles.js`, `src/ui/**`, `src/input/**`, `src/audio/**`, `src/settings/**`, `src/main.js`, `tests/game/**`, `tests/ui/**`, `tests/input/**`, `tests/audio/**`, `tests/settings/**`, `tests/sim/layout.test.js` and `tests/sim/params.test.js` (identifier and comment only).

- [ ] **Step 1:** Apply the D3 items from the triage, one per change, `npm test` after each. `appendShot` becomes a `#private` method; `controlsFrom` returns the idle controls outside Playing only if a test proves the output is unused there, else keep.
- [ ] **Step 2:** Extract main.js's preset-settle wiring (Plan C fix item 10: apply the live settings after a swap settles, compare against `quality.current`) into `src/game/quality.js` as `settleApply({ quality, liveSettings, applySettings })` or a small sibling module, and add the node test the final wave skipped: `test('a preset swap settling applies the live settings, not the snapshot', ...)`.
- [ ] **Step 3:** Commit `Remove residue from the game, ui and audio layers`.

Verify: `npm test`, `npm run smoke`, `smoke.mjs --play 600`, `smoke-menu.mjs`, `smoke-lab.mjs`, `mobile-smoke.mjs`. Review focus: main.js wiring unchanged in effect; the hud and menu CSS still render the same (menu PNGs).

## Phase 2: Fixes and diagnosis (parallel after Phase 1)

D4 to D10 run in parallel from the Phase 1 tip; their files are disjoint (D10 integrates after D6, which owns the projectiles-check tolerance its fallback run needs). Integration order D4, D5, D6, D7, D8, D9, D10.

### Task D4: Game core fixes (about 3 hours, port 5187)

**Files:** `src/game/capacity-swap.js`, `loop.js`, `weapons.js`, `pickups.js`, `run.js`, `score.js`, `projectiles.js`, `quality.js`, `game.js`, `src/render/ship.js`, matching `tests/game/*.test.js` and `tests/render/ship.test.js`.

**Interfaces:** `new CapacitySwap({ ..., clock, timeoutSeconds = 10 })`: when pending longer than timeoutSeconds by the injected clock, abandon the swap, keep the old simulation and resume stepping; a rejected recreate does the same and logs one `console.warn`.

- [ ] **Step 1:** Write the failing tests, one per row of D4 in the triage:
  - `capacity swap that never settles resumes stepping after the timeout` (fake recreate returns a never-resolving promise; advance the clock 10.1 s; `swap.pending === false`, game steps again).
  - `capacity swap whose recreate rejects keeps the old simulation`.
  - `start after stop with a pending frame runs one tick chain` (fake scheduler counts live callbacks; expect 1).
  - `fire on a huge delta spawns at most MAXIMUM_SHOTS_PER_UPDATE volleys` and `zero aim while firing resets the accumulator`.
  - `rotationSeconds at or below zero throws`; `fallback placement keeps at least the minimum distance from a corner player` (injected random that fails every attempt).
  - `start resets respawnSequence`; `recordHit clears a pending milestone`.
  - `queueSpawn beyond capacity drops and counts overflow instead of sharing a slot` (`projectiles.overflowCount`).
  - `apply does not persist when setCapacity resolves false`.
  - `ship heading eases across a simulation time reset` (Game.scene and packShipView use accumulated step time, not `simulation.time`).
- [ ] **Step 2:** Run `node --test tests/game/`; paste the failing lines.
- [ ] **Step 3:** Implement the smallest fix per test.
- [ ] **Step 4:** Run `node --test tests/game/` then `npm test`; all pass.
- [ ] **Step 5:** Commit `Fix game core edge cases from the deferred minors`.

Verify: plus `npm run smoke`, `smoke.mjs --play 600`, `node tests/browser/quality.mjs` (the carry gate may still fail; D8 owns it). Review focus: Review Focus 3; MAXIMUM_SHOTS_PER_UPDATE must exceed any real step's volley count so play is unchanged.

### Task D5: Input, ui, settings and audio fixes (about 3 hours, port 5188)

**Files:** `src/input/pointer.js`, `touch.js`, `rumble.js`, `src/ui/hud.js`, `settings.js`, `rotateOverlay.js`, `menuRouting.js`, `labPanel.js`, `labPresets.js`, `src/settings/storage.js`, `src/audio/music.js`, `src/main.js` (wiring only), matching tests, `tests/browser/smoke-menu.mjs`.

- [ ] **Step 1:** Failing tests, one per D5 row:
  - `pointercancel and window blur release primary and secondary buttons` (fake window dispatch).
  - `touch Play again restarts once for pointerdown then click`; `restart guard uses the injected game clock` (hud.js takes `now` from the game, not `performance.now()`).
  - `settings opened while the rotate overlay pauses shows no pause menu under it`.
  - `arrow keys on a focused slider keep its focus` (blur only on pointer-driven change; Escape and O still close the panel through the one action path).
  - `load clamps out-of-range numbers to the defaults' ranges`.
  - `decodeMix clamps rules into RULE_RANGES`.
  - `backquote in a lab number field does not toggle the lab`.
  - `rumble survives a synchronous playEffect throw`.
  - `death dropout clears a pending melodic hit` (fake audio context: no `hit` note after the dropout).
- [ ] **Step 2:** Run the new tests; paste the failing lines. Step 3: fix. Step 4: `npm test` green.
- [ ] **Step 5:** smoke-menu.mjs: after an arrow step on a settings slider, Escape still closes the panel (elementFromPoint check as today).
- [ ] **Step 6:** Commit `Fix input, settings and audio edge cases from the deferred minors`.

Verify: `npm test`, `smoke-menu.mjs` three times, `smoke-lab.mjs`, `mobile-smoke.mjs`. Review focus: the Plan C fix-wave contract (one close path, closing returns to what was under it) still holds.

### Task D6: Simulation, GPU and render fixes (about 3 hours, port 5189)

**Files:** `src/sim/species.js`, `src/gpu/buffers.js`, `src/gpu/bind-group-cache.js`, `src/sim/particles.js`, `src/render/viewport.js`, `src/sim/shaders/projectiles_step.wgsl`, matching tests, `tests/browser/pages/projectiles-check.js` (D6 is its only Phase 2 owner: case (j), the verdict and the tolerance below).

- [ ] **Step 1:** Failing tests:
  - `normalizeShares replaces NaN and non-finite shares with zero and falls back to equal shares when all are zero`.
  - `tryRead delivers slots in sequence order when an older slot maps late` (fake buffers resolving out of order; the newer slot is held until the older resolves).
  - `particle pool resize evicts its bind group cache entries`.
  - `setCanvasSize with a zero size keeps the previous scale`.
  - projectiles-check case (j): `pulse orb kills agents on its final segment` (an agent placed on the conversion step's segment dies).
- [ ] **Step 2:** Run; paste failing lines. Step 3: fix.
- [ ] **Step 4:** projectiles-check: the `[true, ...]` verdict becomes an explicit `every((entry) => entry.pass)` (B2), and case (e) "sidewinder speed kept" compares within a relative 0.5 percent (the SwiftShader adapter measured 1.9975 against 2.0000; hardware gives 2.0000). `npm test` and `node tests/browser/projectiles.mjs` pass.
- [ ] **Step 5:** Commit `Fix simulation, readback and render edge cases from the deferred minors`.

Verify: plus `npm run smoke`, `smoke.mjs --play 600`, `player.mjs`, `simulation.mjs`. Review focus: Review Focus 4.

### Task D7: Bloom shimmer on medium and low (about 2 hours, port 5190)

**Files:** `src/render/shaders/bloom_downsample.wgsl`, `src/render/bloom.js`, `tests/render/bloom.test.js` (new), `tests/browser/pages/bloom.html` and `bloom-check.js` (new), `tests/browser/bloom.mjs` (new).

- [ ] **Step 1:** Unit tests for `bloomTextureSize` and `Renderer.setBloomQuality` (divisors 2, 3, 4; unknown quality throws; unchanged quality returns early) and for `packGateView` against gates.wgsl's documented layout (render review Minor 6).
- [ ] **Step 2:** GPU check (fails first): render a one-pixel bright line at 16 subpixel offsets through the downsample at divisor 4 and assert the bloom energy varies by under 10 percent across offsets (today it drops to near zero between taps).
- [ ] **Step 3:** Take four bilinear taps at plus or minus a quarter output texel; fix the header comment. Step 4: check passes; `npm run smoke` luminance within 0.002 of before at the high preset.
- [ ] **Step 5:** Commit `Sample a box in the bloom downsample at the lower qualities`.

Review focus: high quality output unchanged; tap count stays within the mobile budget.

### Task D8: Diagnose the quality.mjs carry gate (about 2 hours, port 5191)

**Files:** `tests/browser/quality.mjs`; read-only first: `src/sim/compact.js`, `src/sim/simulation.js`, `src/game/capacity-swap.js`. Use superpowers:systematic-debugging.

- [ ] **Step 1 (decisive experiment):** Instrument the check (test-side only) to record three numbers per swap: alive in the last stats before install, the compacted count the new simulation starts with (from the compaction's own count or the first stats frame whose frameSequence follows install, before any spawn step), and alive 10 frames later. Run 5 times as is, then 5 times with spawning held at zero from 30 steps before to 30 after the swap (`SpawnPressure.setRamp` floor and ceiling 0, the lab path).
- [ ] **Step 2:** Decide. Hypothesis T (test timing, P42): the carried count equals the before count within 1 percent in all 10 runs, and the held-spawn runs show no rise. Then change the gate to compare the carried count at install, keep a separate bound that alive 10 frames later is under 1.05 times the alive target, and record the evidence in the check's header. Hypothesis C (carry bug): the carried count exceeds the before count, or the held-spawn runs still rise. Then STOP and report DONE_WITH_CONCERNS with the numbers; the controller opens a fix task in compact.js with this experiment as its regression test.
- [ ] **Step 3:** Commit `Measure the carried agents at install in the quality check` (Hypothesis T only).

Verify: `node tests/browser/quality.mjs` five times, all pass. Review focus: the gate still fails on a real loss (temporarily drop half the compacted agents in a scratch edit and see it fail; revert).

### Task D9: Browser harness hygiene (about 2 hours, port 5192)

**Files:** `tests/browser/server.mjs`, `smoke.mjs`, `tests/browser/pages/grid-check.js`, `player-check.js`, `tests/browser/audio-render.mjs`, `tests/browser/pages/audio-render-check.js`, `tests/browser/smoke-lab.mjs`.

- [ ] **Step 1:** server.mjs: confirm readiness by the Vite child having printed its own URL (the child's stdout), not only an HTTP 200, and `stop()` awaits the child's exit; smoke.mjs validates `--frames` inside its try, names magic numbers, reports a non-secure SMOKE_URL as exit 1 with its own message, fixes "stats:" spacing and the "aliveTotal at capture" wording.
- [ ] **Step 2:** Test vacuities: grid-check seeds cell counts 1 to 64 instead of equal counts; player-check asserts overlap per frame.
- [ ] **Step 3:** smoke-lab: one Play run with the probe on (no `probe=off`) for 300 frames, no console errors, the stored preset unchanged afterwards (Plan C fix item 4). audio-render: one worst-case render (bomb, death and 50 kills at intensity 0.9) with peak at or below 0 dBFS.
- [ ] **Step 4:** Commit `Tighten the browser harness and remove vacuous checks`.

Verify: every changed script once; grid.mjs must fail if the scatter offset is broken by one (scratch edit, revert). Review focus: no check got weaker.

### Task D10: Platform-aware launch flags and a GPU checks runner (about 2 hours, port 5193)

**Files:** `tests/browser/launch.mjs`, `tests/browser/webgpu-probe.mjs` (new), `tests/browser/gpu-checks.mjs` (new), `tests/browser/launch.test.js` (new; `npm test` picks it up), `package.json` (scripts only).

**Interfaces:** `webGpuFlagsFor({ platform, measuring })` returns the flag list: win32 keeps today's list; linux uses `--headless=new`, `--enable-unsafe-webgpu`, `--enable-features=Vulkan`, `--mute-audio`. `WEBGPU_ADAPTER=fallback` makes `launchWebGpuBrowser` add an init script that calls `navigator.gpu.requestAdapter({ ...options, forceFallbackAdapter: true })` (test-side only; no shipped-code change). `npm run check:gpu` runs `webgpu-probe.mjs` then grid, player, simulation and projectiles in sequence; exit 2 if the probe finds no adapter, 1 on any failure.

- [ ] **Step 1:** Node tests for `webGpuFlagsFor` per platform and for the init script being added only with `WEBGPU_ADAPTER=fallback`.
- [ ] **Step 2:** webgpu-probe.mjs prints the adapter's vendor and architecture and runs one compute dispatch (doubling 1M u32 values) and checks the readback.
- [ ] **Step 3:** Run `npm run check:gpu` on hardware, then `WEBGPU_ADAPTER=fallback npm run check:gpu`; both exit 0, except that the fallback run's projectiles case (e) may fail until D6's tolerance lands (record it; the controller reruns after integration); paste the probe's architecture lines (expect nvidia, then swiftshader) and each check's duration.
- [ ] **Step 4:** Commit `Choose WebGPU flags by platform and add a software adapter path`.

Review focus: win32 flags byte-identical to today; the fallback path is never the default.

## Phase 3: Coverage and CI (parallel after Phase 2)

D11 and the two test lanes run in parallel. Integration order D11, D12a, D12b, then D13.

### Task D11: Check workflow and the self-hosted browser workflow (about 2 hours, port none)

**Files:** `.github/workflows/check.yml` (new), `.github/workflows/browser.yml` (new), `.github/workflows/pages.yml` (name only), `tests/workflows.test.js` (new).

Decision: keep pages-check.yml (assembly) and pages.yml (deploy, which runs `npm test` only for trusted main and same-repository builds under `pull_request_target`). Add check.yml for every push and pull_request with `permissions: contents: read`, so untrusted pull request code is tested without a write token; the duplicate `npm test` on main is deliberate (deploy gate versus check). Do not add GPU work to pages.yml.

- [ ] **Step 1:** `tests/workflows.test.js`: every `uses:` line in `.github/workflows/*.yml` pins a 40-hex SHA followed by `# v`; check.yml triggers on `push` and `pull_request`; browser.yml never triggers on `pull_request` or `pull_request_target` (self-hosted runners must not run fork code).
- [ ] **Step 2:** check.yml jobs: `test` (ubuntu-latest, checkout and setup-node pins from pages.yml, node 24, `npm ci`, `npm test`, `npm run coverage`, `npm run build`); `gpu-software` (ubuntu-latest, `npx playwright install --with-deps chromium`, `WEBGPU_ADAPTER=fallback npm run check:gpu`, timeout 20 minutes). The software job is a normal job: a missing adapter fails it with the probe's message.
- [ ] **Step 3:** browser.yml: `runs-on: [self-hosted, gpu]`, triggers `workflow_dispatch` and `push` to main, runs `npm run smoke`, `smoke.mjs --play 600`, `smoke-menu.mjs`, `smoke-lab.mjs`, `mobile-smoke.mjs`, `quality.mjs`, `npm run check:gpu`, `steer.mjs`, each with `SMOKE_PORT` from the job.
- [ ] **Step 4:** pages.yml: `name: Publish Pages` and `run-name: Publish ${{ github.event.repository.name }}` (Plan A Task 4 minor).
- [ ] **Step 5:** Validate: `npm test`; `actionlint` if installed, else `python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/*.yml`; state which ran.
- [ ] **Step 6:** Commit `Add check and self-hosted browser workflows`.

Review focus: Review Focus 5; permissions minimal; no secret or write token in check.yml.

### Task D12a: CPU tests skipped under R23 and Plans A and B (about 3 hours, port none)

**Files:** `tests/game/*.test.js`, `tests/sim/*.test.js`, `tests/settings/probe.test.js`, `tests/ui/labPresets.test.js`, `tests/ui/hud.test.js`, `tests/render/ship.test.js`, `tests/render/canvas-size.test.js`, `tests/sim/params.test.js`. No `src/` change; a test that exposes a bug stops the lane with DONE_WITH_CONCERNS and the failing test name.

- [ ] **Step 1:** Write, run, and keep green:
  - C0b, C0b2: spawn director gate selection favors dense coarse cells and the far side (injected density and random); pin each DEFAULT_RAMP and gate default by value.
  - C0e: pin every weapon table entry by exact value (replaces the range checks).
  - R29: `turret-only player on the base gun counts as onBaseGun for the pickup director` (game level).
  - C1: probe cooldown with `windowFrames * frameSeconds < minimumSecondsBetweenSteps`.
  - C6a: the non-finite test with valid-length rules and matrix.
  - C0c: ship ease mid-turn lag.
  - B1: useBomb rejected outside Playing. B4: unknown type throws, beam expiry, diagonal aim, swap mid-fire. B5: frozen ageing outside play, milestone restarting the pity timer, nearest of two collected, rotation not retyping existing pickups. B6: Game.scene per phase and onArmWeapon wiring; the zero-charge drain loop gets a frame cap and uses the director's API. B8: charge bar and top-mode classes. A Task 5: every default species row finite. A Task 7: every params.js offset pinned by value. A Task 11: touchcancel, second touch in the same half, the injected scheduler receiver with a call-count assertion, dispose removing its window listener. A Task 13: the resize observer's zero-size, unchanged-size and last-entry branches.
- [ ] **Step 2:** `npm test` and `npm run coverage` pass; report the coverage before and after per file.
- [ ] **Step 3:** Commit `Cover the logic skipped during prototyping`.

### Task D12b: GPU cases skipped under R23 (about 2 hours, port 5194)

**Files:** `tests/browser/pages/projectiles-check.js`, `tests/browser/smoke.mjs` (one sweep assertion), `tests/browser/pages/steer-check.js` (none unless needed).

- [ ] **Step 1:** Case (k): a 180 degree single-step beam reversal kills both half-sectors with no empty bin and nothing beyond the padding. Case (l): two non-identical overlapping bullets (different radii and speeds) kill the union. smoke.mjs `--sweep` with the lab sweep budget on: the drawn beam's reach matches the shortened kill reach within one coarse cell on the capture.
- [ ] **Step 2:** `node tests/browser/projectiles.mjs`, `smoke.mjs --sweep`, `npm run check:gpu` and `WEBGPU_ADAPTER=fallback npm run check:gpu` pass.
- [ ] **Step 3:** Commit `Cover beam reversal, mixed bullets and the shortened beam on the GPU`.

## Phase 4: Close

### Task D13: Raise the gate, update docs, final verification (about 2 hours, port 5184)

**Files:** `package.json` (thresholds), `README.md`, `SMOKE.md`, `AGENTS.md`.

- [ ] **Step 1:** Run `npm run coverage`; set the line and function thresholds to the measured values rounded down. For every in-scope file under 100 percent lines, list the uncovered ranges and the reason in the report (owner R24 asks for 100 percent; the report says how far each file is).
- [ ] **Step 2:** Docs (docs-update skill): README Commands gains `npm run coverage` and `npm run check:gpu`; a CI section says what check.yml runs, what browser.yml runs on a self-hosted GPU runner, and what stays local. SMOKE.md's automated list gains the same split. AGENTS.md Commands and file map gain the new scripts and files. Grep every changed doc for U+2014.
- [ ] **Step 3:** Full run, sequential, teed to `artifacts/final-checks.txt`: `npm test`, `npm run coverage`, `npm run build`, `npm run smoke`, `smoke.mjs --play 600`, `smoke-menu.mjs`, `smoke-lab.mjs`, `mobile-smoke.mjs`, `quality.mjs`, `npm run check:gpu`, `WEBGPU_ADAPTER=fallback npm run check:gpu`, `steer.mjs`, `python tests/pages_assembly_test.py` (skips without rsync on Windows; say so).
- [ ] **Step 4:** Commit `Raise the coverage gate and document CI`.

## Acceptance for the whole plan

- Every fix-now triage row has a test that failed before its fix (or is recorded as already fixed), and every dropped row is unchanged.
- `npm test`, `npm run coverage` and `npm run build` pass; these, plus the four small GPU page checks on the SwiftShader fallback adapter, are what GitHub-hosted runners can run (check.yml).
- Local only until the owner registers a self-hosted GPU runner (browser.yml): smoke, `--play`, smoke-menu, smoke-lab, mobile-smoke, quality, steer, audio-render and capture-weapons. Measured on the owner's desktop (Chromium headless shell 1254, forced fallback adapter): the game runs at about 1.1 frames per second at 65,536 agents and 0.5 at 262,144, so a 120-frame smoke takes minutes and `--play 600` and the quality probe's frame-time gates are meaningless on a CPU rasterizer.
- No file over about 500 lines without its note; no em-dash anywhere; no new dependency.

## CI research (decision and sources)

- Chrome's guidance for headless WebGPU on Linux uses `--headless=new --use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface --enable-unsafe-webgpu` and was verified on a GPU instance, not a CPU runner ([Chrome for Developers](https://developer.chrome.com/blog/supercharge-web-ai-testing)).
- Emscripten's CI ran WebGPU tests in Chrome with `--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader --enable-features=Vulkan` ([emscripten commit](https://chromium.googlesource.com/external/github.com/emscripten-core/emscripten/+/refs/heads/webgpu_testing%5E%21/)). A third-party tool documents the SwiftShader Vulkan preset and notes that `requestAdapter()` returns null without `libvulkan1` and Mesa, and that SwiftShader drops heavy scenes to single-digit frames per second ([agent-browser](https://agent-browser.dev/webgpu)). Standard GitHub runners have no GPU; GPU larger runners need a Team or Enterprise plan and are billed per minute even for public repositories ([GitHub runner pricing](https://docs.github.com/en/enterprise-cloud@latest/billing/reference/actions-runner-pricing)).
- Local spike on this machine (2026-11-07): the `--use-webgpu-adapter=swiftshader` flag sets returned a null adapter on Windows; today's flags plus `forceFallbackAdapter: true` returned a SwiftShader adapter (vendor google, 10 storage buffers per stage) that ran a 1M-element compute dispatch correctly. On it, grid, player and simulation passed, and projectiles passed every case but the sidewinder speed equality (1.9975 against 2.0000).
- Decision: GitHub-hosted runners run unit, coverage, build and the four small GPU page checks through the fallback adapter; the Linux fallback path is unverified until check.yml first runs after publication. The realistic answer for the full browser suite is a self-hosted runner on the owner's GPU machine (browser.yml, never on pull requests).

## Parked for the owner (not Plan D tasks)

- Publishing the public GitHub repo and enabling Pages (R5; the repo has no remote). check.yml, browser.yml and pages.yml first run then.
- Registering a self-hosted GPU runner labeled `gpu` for browser.yml (owner machine and account).
- The mtschoen.com/games/sentient-swarm/ deploy through the site's `ci/deploy-game.sh` (needs the public repo).
- The beam sweep budget default (R25).
- The swarm-shape tuning session (R20, R27: "the swarm should read as sentient"), including the steering-feel minors dropped above.
- Renaming the repo directory and package from murmuration.
- Whether a tap shorter than the fire interval should fire one shot (B4, P21 feel).
