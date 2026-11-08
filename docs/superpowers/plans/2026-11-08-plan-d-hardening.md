# Plan D: Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden Sentient Swarm v1 (owner ruling R24: "sweep for code quality, get coverage back to 100% and set up CI") without changing how it plays: a behavior-neutral simplification sweep, every deferred Minor from Plans A, B and C fixed with a regression test or dropped with a reason, the tests skipped under R23, a diagnosed quality.mjs carry gate, a coverage gate, and GitHub Actions checks.

**Architecture:** Disjoint simplification lanes land first, guarded by the existing suite, the browser checks and a deterministic render capture. Bug-fix lanes follow by area, each fix carrying a test that fails before it. Coverage uses Node's built-in test coverage (no new dependency) scoped to the modules node can import. CI is a new check workflow on every push and pull request (unit tests, coverage gate, build) plus an advisory software-GPU job for the small GPU page checks; the full browser suite runs on a self-hosted GPU runner the owner registers, and stays local until then.

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
- Simplification deletes only with reference evidence (Grep for every caller, export and shader entry point; use the simplifying-a-codebase skill). Unsure means keep. After rebasing onto the integrated tip, run `npm run coverage` once and report whether D0's thresholds still hold (lanes do not edit them; D13 re-measures).
- Never commit logs, PNGs, coverage output or raw tool output.
- You do not dispatch subagents.
- Report INSIDE your worktree at `.superpowers/sdd/2026-11-08-plan-d-hardening/task-<id>-report.md`: what changed, files, RED and GREEN lines, browser check result lines, assumptions, concerns. Reply with ONLY: Status (DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT), commits, one-line test summary, concerns, report path. Under 15 lines.

## Review Focus

1. A "dead" export that a WGSL entry point, a test page under `tests/browser/pages/`, or `window.__murmuration` reads: deleting it must not break a browser check (review D1a to D3b against `git grep` of each removed name).
2. Shader constant substitution (D1a): a constant now injected into WGSL must produce identical behavior; projectiles.mjs, player.mjs, grid.mjs and simulation.mjs must pass unchanged.
3. A capacity swap that never settles, or settles after its timeout (D4a): the probe and later swaps work again, the late result is discarded (no second simulation leaks), and the UI still sees the failure.
4. Bloom at the lower qualities (D7): thin moving features keep a steady glow, and the high quality capture is unchanged.
5. CI on a runner without a GPU (D10, D11): the advisory software job reports "no adapter" as a visible failure with the probe's message, never as a silent pass.

## Triage of deferred Minors (binding)

Sources: the Plan C controller report, final-review-game.md, final-review-render.md, final-review-audio.md, the Plan B summary and the Plan A progress ledger (all under C:/Users/mtsch/murmuration/.superpowers/sdd/archive/). Each fix-now row names its task; the lane still runs the RED step (Lane rules).

**Fix now (each with a regression test):**

| Item | Task |
| --- | --- |
| A: a CapacitySwap prepare that never settles keeps `pending` true forever, so the probe (`acceptsProbeFrames`) and every later swap stay blocked (the old simulation keeps stepping) | D4a |
| B7: the ship heading eases on `simulation.time` (Game.scene, game.js:571), which a capacity swap resets | D4a |
| C2: QualityController.apply persists the preset when setCapacity resolves false | D4a |
| B4: unbounded fire loop on a huge deltaSeconds; zero aim while firing leaves the accumulator | D4b |
| B5: rotationSeconds <= 0 loops forever; the placement fallback can land a pickup near a corner player | D4b |
| B1: RunState.start() does not reset respawnSequence; recordHit leaves a pending milestone flag | D4b |
| B8: touch Play again can restart twice (pointerdown then click) | D5 |
| C final wave: Settings opened while paused only by the rotate overlay shows the pause menu under it | D5 |
| C final wave: settings sliders lose keyboard focus after each arrow step | D5 |
| C1: SettingsStore.load does not range-check numbers | D5 |
| C6b: decodeMix admits rule values outside RULE_RANGES | D5 |
| A Task 15: backquote toggles the lab while typing in a lab number field | D5 |
| C3: rumble play() has no guard for a synchronous playEffect throw | D5 |
| C5: a melodic stab queued before a death dropout plays after it (pendingHit not cleared) | D5 |
| A: NaN shares propagate through normalizeShares | D6 |
| A, B, C2: BindGroupCache keeps entries for destroyed particle buffers after a resize | D6 |
| B2: the pulse orb's final travel segment is not capsule-collided on its conversion step | D6 |
| C render Minor 1: bloom medium and low take one tap per output texel and shimmer | D7 |
| C P42: quality.mjs alive-carry gate fails (diagnosis first) | D8 |
| A Task 2 and 11w: smoke readiness cannot tell its Vite child from a foreign server; bad `--frames` throws before try; non-secure SMOKE_URL misreported as exit 2; child.kill() not awaited; "stats:" spacing | D9 |
| A Task 4: pages.yml top-level `name` uses an expression | D11 |

**Simplification (no behavior change), by task:** D1a: AtomicAgent and the particle-claim loop duplicated in kill_debug.wgsl and projectiles_collide.wgsl; kind and flag constants written by hand into WGSL and the test page instead of substituted from PROJECTILE_KINDS; projectiles.js BEAM_KIND; steer.wgsl hard-coded `2u` for VECTORS_PER_CELL; density-readback.js inline WGSL into `shaders/density_sum.wgsl`; WGSL comment drift (one-sided edge gradients, long lines in common.wgsl, the stats.wgsl header wrap from B3). D1b: DebugKillPass and KillAllPass buffer lists; DEFAULT_PLAYER_RADIUS in simulation.js and player-check.js (PlayerShip's default stays); five per-step hue copies into one write on setSpecies; simulation-check.js WALL_MARGIN mirror; the unwritten SimParams aliveTarget marked reserved in params.js (offsets unchanged); JS comment drift (particle cursor wrap, the spawner.js header against DEFAULT_RAMP, spawn-director.js:20); `g` in layout.test.js; the garbled comment in params.test.js. D2: quad and feather helpers duplicated across three render shaders; per-frame Float32Array allocations in the ship, pickup and projectile renderers; sampleField recomputing the density sum per vertex; IMPULSE_CAPACITY and IMPULSE_DURATION_SECONDS kept in sync by comment only. D3a: appendShot public; removeProjectilePass unused; controlsFrom outside Playing; main.js per-frame merged stats object; the quality.js dead resize branch; the densityAt closure per update; RunState header on action draining; Game header length; long lines in main.js. D3b: the dead `.hud-bands` class; the per-step arpeggio array; long lines in settings.js and menu.js.

**Already resolved (verify in the report, no change):** StagingRing order (`readAll`, buffers.js:65-79, stops at the first older slot still mapping); FrameLoop start, stop, start (loop.js generation counter); pointer release on pointercancel, lostpointercapture and window blur (pointer.js `release` clears primaryDown and secondaryDown); Viewport.setCanvasSize(0, 0) (clamps to 1 device pixel, viewport.js:18); ParticleRenderer pool argument (constructor takes `{ viewport, common }`); B1 Awards reset (game.js:267 builds a new Awards per run); B2 ring thread cost (32 shared workgroups); B4 beam expired flag; B6 mid-run restart credit; B10 README wording; B8 restart guard clock (createHud's injectable `now` defaults to the monotonic `performance.now`, hud.js:55, main.js passes no other clock, and the tests inject it); C0 slider cap; C0b2 count floor; C6b watch note; C7 bombHeld; C6a share cap.

**Dropped, with reason:** B2 queueSpawn slot sharing beyond capacity minus one spawns in one frame (unreachable: a frame spawns under 100 projectiles against 8191 slots, and replacing a still-alive slot is the documented round-robin contract, projectiles.js:12). A Task 3 FXC flag (`--disable-dawn-features=use_dxc` stays on win32 because this host's dxcompiler.dll fails to load; launch.mjs already names the failure; Linux CI compiles through Vulkan, not DXC). C0d sweep origin ignores ship motion within a step (bounded by one step of ship travel, 6 units per second at 60 Hz = 0.1 world units, and the next step's sector starts at the new origin). B4 taps shorter than the fire interval never shoot (feel, P21; parked for the owner). A separation divisor, pressure safeNormalize, wall push after the speed clamp, Lattice breathing (steering feel; the swarm session R20, R27). C render Minor 4 half-rate glyph lag and C2 30 Hz half-rate updates (documented phoneLow tradeoff). C render Minor 5 beam fan fill cost (needs a phone measurement; owner device). B9 ring impulse stamped at read time and pickup impulse at the ship (a few frames, invisible). B9 no automated displacement check, A grid layer not bloomed (visual). A capture() not re-entrant and FrameCapture.request without timeout (test hook; every smoke evaluate is bounded). A canvas sized from clientWidth (index.html sizes it), resize observer never disconnected (page lifetime). A Task 15 lastStats stale a few frames after a swap; C2 kills in flight at install scored at the new capacity (bounded). A floor sums off by one, spawn give-back units unspent (bounded). B3 kill_all killAllRequested guard (defensive, cheap). C2 failing apply retries every 3 s; C6b radius swap pending at leave; C0b2 gateCount 1 stall; C6a loadMix index; C7 haptics Proxy identity; C7 full-strip HUD zones; C4 focusFromPointer; C5 resume after interruption; C1 save without merge (load tolerates). C2 upward swaps to 2M unmeasured and the README measured table (measurement, local only).

## Phase 1: Baseline and simplification (parallel)

D0, D1a, D1b, D2, D3a and D3b touch disjoint files and run in parallel from the plan base. Integration order D0, D1a, D1b, D2, D3a, D3b.

### Task D0: Coverage gate (about 1 hour, port none)

**Files:** Modify `package.json`. Create `tests/coverage.test.js`.

**Interfaces:** Produces `npm run coverage`. The thresholds are a Phase 1 floor; D13 re-measures and raises them after every lane lands.

- [ ] **Step 1:** Add `"coverage": "node --test --experimental-test-coverage --test-coverage-include=\"src/**/*.js\" <exclusions> --test-coverage-lines=<N> --test-coverage-functions=<N> \"tests/**/*.test.js\""`. Exclusions are modules whose bodies need a GPU device or a DOM (for example `src/main.js`, `src/gpu/device.js`, renderer and pass classes); decide each by running coverage once, and list every excluded file with a one-line reason in the report.
- [ ] **Step 2:** Set each threshold to the measured value rounded down to a whole percent, minus 2 points of headroom for Phase 1 moves. Run `npm run coverage`; expect exit 0. Delete one test file in a scratch edit, confirm a non-zero exit, restore.
- [ ] **Step 3:** `tests/coverage.test.js`: `test('coverage exclusions name existing files', ...)` asserts every `--test-coverage-exclude` glob in package.json matches at least one file (a lane that deletes an excluded file updates nothing here; D13 owns the list, so the test names the stale glob in its message).
- [ ] **Step 4:** Commit `Add a coverage gate on the node-reachable modules`.

Verify: `npm test`, `npm run coverage`. Review focus: no excluded file that node could import with a fake.

### Task D1a: Simplify the simulation shaders and their constants (about 3 hours, port 5184)

**Files:** `src/sim/shaders/**`, `src/gpu/shaders.js`, `src/sim/layout.js`, `src/sim/density-readback.js`, `src/game/weaponTypes.js`, `src/game/projectiles.js` (constants only), `tests/gpu/shaders.test.js`, `tests/browser/pages/projectiles-check.js` (constant imports only).

**Interfaces:** PROJECTILE_KINDS stays in `src/game/weaponTypes.js` as the single JS source (src/render/projectiles.js keeps importing it) and reaches WGSL through `substituteConstants` in `src/gpu/shaders.js`; the shared AtomicAgent and claim helpers live in `common.wgsl`. D1a may add exports to `src/sim/layout.js` but must not rename or remove any (D1b owns `tests/sim/layout.test.js`, which pins them).

- [ ] **Step 1:** List each D1a item with file:line and the callers found; keep the list in the report.
- [ ] **Step 2:** One item at a time: change, run `npm test` and the check that exercises it (projectiles.mjs for kinds and the claim loop, player.mjs for kill passes, grid.mjs and steer.mjs for VECTORS_PER_CELL, smoke-lab.mjs for the density readback). A failing check reverts that item.
- [ ] **Step 3:** In `tests/gpu/shaders.test.js` add `test('projectile kind constants substituted into WGSL equal PROJECTILE_KINDS', ...)`: the substituted collide source contains each kind's value under its constant name and no literal kind number remains in the kind switch.
- [ ] **Step 4:** Commit `Share simulation shader helpers and substitute kind constants`.

Verify: `npm test`, `npm run smoke`, `projectiles.mjs`, `player.mjs`, `grid.mjs`, `steer.mjs`, `smoke-lab.mjs`. Review focus: Review Focus 1 and 2; the 8-binding limit in the collide and kill passes.

### Task D1b: Simplify the simulation and GPU JavaScript (about 2 hours, port 5185)

**Files:** `src/sim/*.js` except `layout.js` and `density-readback.js`, `src/gpu/*.js` except `shaders.js`, `tests/sim/**`, `tests/gpu/**` except `shaders.test.js`, `tests/browser/pages/player-check.js` and `simulation-check.js` (imports only).

- [ ] **Step 1:** Apply each D1b item with `npm test` after each; `simulation.js` exports DEFAULT_PLAYER_RADIUS and player-check.js imports it; setSpecies writes the hue table once instead of five per-step copies (simulation.mjs checks hues per species).
- [ ] **Step 2:** Commit `Remove duplicated simulation buffer lists and constants`.

Verify: `npm test`, `npm run smoke`, `player.mjs`, `simulation.mjs`. Review focus: Review Focus 1.

### Task D2: Simplify the render layer, with a deterministic render capture (about 3 hours, port 5186)

**Files:** `src/render/**`, `tests/render/**`, `tests/browser/render-capture.mjs` (new), `tests/browser/pages/render-capture.html` and `render-capture-check.js` (new).

**Interfaces:** `node tests/browser/render-capture.mjs --out <directory> [--compare <directory>]` builds a 65,536-slot Simulation seeded with a fixed agent pattern (the seeding used by the steer and projectiles pages), never steps it, sets render time to 1.0, trails off, and draws one fixed scene (ship, one projectile of each kind, one pickup) once per bloom quality; it writes `render-<quality>.png` and raw RGBA. `--compare` fails if any quality's mean absolute per-channel difference exceeds 0.5/255 or any channel differs by more than 4/255. D7 reuses it.

- [ ] **Step 1:** Write the capture tool and run it on the unchanged code: `--out artifacts/render-before`; run it twice more with `--compare artifacts/render-before` and confirm a zero difference (determinism).
- [ ] **Step 2:** Move the shared quad and feather helpers into one WGSL header prepended by `render-shaders.js`; reuse one view buffer per renderer instead of a per-frame Float32Array; hoist the density sum in sampleField; derive the impulse constants from one JS source through constant substitution.
- [ ] **Step 3:** `render-capture.mjs --out artifacts/render-after --compare artifacts/render-before` passes; paste the per-quality differences.
- [ ] **Step 4:** Commit `Share render shader helpers and reuse view buffers`.

Verify: `npm test`, `render-capture.mjs --compare`, `npm run smoke`, `smoke.mjs --play 600`. Review focus: the capture is fully deterministic (Step 1 zero difference); no `new Float32Array` left in encode paths.

### Task D3a: Simplify the game layer and main.js (about 3 hours, port 5187)

**Files:** `src/game/**` except `projectiles.js` and `weaponTypes.js`, `src/main.js`, `tests/game/**`.

- [ ] **Step 1:** Apply each D3a item, `npm test` after each. `appendShot` becomes a `#private` method; `controlsFrom` changes outside Playing only if a test proves its output is unused there, else keep.
- [ ] **Step 2:** Extract main.js's preset-settle wiring (Plan C fix item 10: apply the live settings after a swap settles, compare against `quality.current`) into `src/game/quality.js` as `settleApply({ quality, liveSettings, applySettings })`, with `test('a preset swap settling applies the live settings, not the snapshot', ...)`.
- [ ] **Step 3:** Commit `Remove residue from the game layer`.

Verify: `npm test`, `npm run smoke`, `smoke.mjs --play 600`, `quality.mjs` (its carry gate may still fail; D8 owns it). Review focus: main.js wiring unchanged in effect.

### Task D3b: Simplify ui, input, audio and settings (about 1 hour, port 5188)

**Files:** `src/ui/**`, `src/input/**`, `src/audio/**`, `src/settings/**`, `tests/ui/**`, `tests/input/**`, `tests/audio/**`, `tests/settings/**`.

- [ ] **Step 1:** Apply each D3b item, `npm test` after each; the arpeggio pattern becomes one preallocated array per voice (music.test.js note sequences unchanged).
- [ ] **Step 2:** Commit `Remove residue from the ui and audio layers`.

Verify: `npm test`, `smoke-menu.mjs`, `smoke-lab.mjs`, `mobile-smoke.mjs`, `audio-render.mjs`. Review focus: menu and HUD page screenshots unchanged.

## Phase 2: Fixes and diagnosis (parallel after Phase 1)

D4a, D4b, D5, D6, D7, D8, D9 and D10 run in parallel from the Phase 1 tip on disjoint files. Integration order D4a, D4b, D5, D6, D7, D8, D9, D10 (D10 after D6, which owns the projectiles-check tolerance its fallback run needs).

### Task D4a: Capacity swap, ship heading and quality persistence (about 3 hours, port 5189)

**Files:** `src/game/capacity-swap.js`, `src/game/game.js`, `src/game/quality.js`, `src/render/ship.js`, `tests/game/capacity-swap.test.js`, `quality.test.js`, `game.test.js`, `tests/render/ship.test.js`.

**Interfaces:** `new CapacitySwap({ ..., now = () => performance.now(), timeoutMilliseconds = 10000 })`, with `now` passed through from `Game.create` so tests inject it (a monotonic millisecond source, never the game clock, which stalls while paused and resets at a swap). `request(change)` records `now()`; `expire()` reads `now()` and is polled by `Game.render` once per animation frame. Game.render runs every frame, paused or not (main.js's render callback), while `Game.update` returns early when paused (game.js:301) and opening Settings, where capacity changes happen, pauses the run (P40). When a request is older than timeoutMilliseconds, expire clears `pending` and the request rejects with an Error named `CapacitySwapTimeout`, keeping the documented "rethrows for the UI to show" contract (capacity-swap.js:8-10). A prepare that resolves after expiry goes to `discard(prepared)` and is never committed or installed; one that rejects after expiry is ignored (already reported). A rejection before expiry still rethrows with `pending` cleared, as today.

- [ ] **Step 1:** Failing tests:
  - `a prepare that never settles rejects with CapacitySwapTimeout after timeoutMilliseconds and clears pending` (fake prepare never resolves; fake `now` advanced 10,100 ms, then `expire()`).
  - `a prepare resolving after the timeout is discarded once and never installed` (counts discard, commit and install calls).
  - `Game.render polls the swap every frame` (fake swap counts `expire` calls over two renders).
  - `a swap requested while paused still times out` (game paused, fake `now` advanced 10,100 ms, two `render` calls, no `update`: the request rejects with CapacitySwapTimeout and `pending` is false).
  - `a rejected prepare still rethrows and clears pending` (pins the contract).
  - `ship heading eases across a simulation time reset` (Game.scene and packShipView use accumulated step time, not `simulation.time`).
  - `apply does not persist when setCapacity resolves false`.
- [ ] **Step 2:** Run `node --test tests/game/ tests/render/ship.test.js`; paste the failing lines. Step 3: implement. Step 4: `npm test` green.
- [ ] **Step 5:** Commit `Time out stuck capacity swaps and ease the ship on step time`.

Verify: plus `npm run smoke`, `smoke.mjs --play 600`, `quality.mjs`. Review focus: Review Focus 3; QualityController and the settings select still surface the rejection.

### Task D4b: Weapons, pickups, run and score fixes (about 2 hours, port 5190)

**Files:** `src/game/weapons.js`, `pickups.js`, `run.js`, `score.js`, `tests/game/weapons.test.js`, `pickups.test.js`, `run.test.js`, `score.test.js`.

- [ ] **Step 1:** Failing tests: `fire on a huge delta spawns at most MAXIMUM_SHOTS_PER_UPDATE volleys` (the constant exceeds any real step's volley count, so play is unchanged); `zero aim while firing resets the accumulator`; `rotationSeconds at or below zero throws`; `fallback placement keeps the minimum distance from a corner player` (injected random that fails every attempt); `start resets respawnSequence`; `recordHit clears a pending milestone`.
- [ ] **Step 2:** Run them; paste failing lines. Step 3: fix. Step 4: `npm test` green.
- [ ] **Step 5:** Commit `Fix weapon, pickup and run edge cases from the deferred minors`.

Verify: plus `smoke.mjs --play 600`. Review focus: no change to fire rate or pickup timing in normal steps.

### Task D5: Input, ui, settings and audio fixes (about 3 hours, port 5191)

**Files:** `src/input/rumble.js`, `src/ui/hud.js`, `settings.js`, `rotateOverlay.js`, `menuRouting.js`, `labPanel.js`, `labPresets.js`, `src/settings/storage.js`, `src/audio/music.js`, `src/main.js`, matching tests under `tests/ui`, `tests/input`, `tests/settings`, `tests/audio`, and `tests/browser/smoke-menu.mjs`.

- [ ] **Step 1:** Failing tests:
  - `touch Play again restarts once for pointerdown then click`.
  - `settings opened while the rotate overlay pauses shows no pause menu under it`.
  - `arrow keys on a focused slider keep its focus` (blur only on a pointer-driven change; Escape and O still close the panel through the one action path).
  - `load clamps out-of-range numbers to the defaults' ranges`; `decodeMix clamps rules into RULE_RANGES`.
  - `backquote in a lab number field does not toggle the lab`.
  - `rumble survives a synchronous playEffect throw`.
  - `death dropout clears a pending melodic hit` (fake audio context: no `hit` note after the dropout).
- [ ] **Step 2:** Run; paste failing lines. Step 3: fix. Step 4: `npm test` green.
- [ ] **Step 5:** smoke-menu.mjs: after an arrow step on a settings slider, Escape still closes the panel (elementFromPoint check as today).
- [ ] **Step 6:** Commit `Fix input, settings and audio edge cases from the deferred minors`.

Verify: `npm test`, `smoke-menu.mjs` three times, `smoke-lab.mjs`, `mobile-smoke.mjs`. Review focus: the Plan C fix-wave contract (one close path; closing returns to what was under it).

### Task D6: Simulation shares, bind group eviction and the pulse orb segment (about 2 hours, port 5192)

**Files:** `src/sim/species.js`, `src/gpu/bind-group-cache.js`, `src/sim/particles.js`, `src/sim/shaders/projectiles_step.wgsl`, `tests/sim/species.test.js`, `tests/gpu/bind-group-cache.test.js`, `tests/browser/pages/projectiles-check.js` (the only Phase 2 owner).

- [ ] **Step 1:** Failing tests: `normalizeShares treats NaN and non-finite shares as zero and falls back to equal shares when all are zero`; `particle pool resize evicts its bind group cache entries`; projectiles-check case (j) `pulse orb kills agents on its final segment` (an agent on the conversion step's segment dies).
- [ ] **Step 2:** Run; paste failing lines. Step 3: fix.
- [ ] **Step 4:** projectiles-check: the `[true, ...]` verdict becomes `every((entry) => entry.pass)` (B2), and case (e) "sidewinder speed kept" compares within a relative 0.5 percent (the SwiftShader adapter measured 1.9975 against 2.0000; hardware gives 2.0000). `npm test` and `projectiles.mjs` pass.
- [ ] **Step 5:** Commit `Guard species shares, evict stale bind groups and collide the last orb segment`.

Verify: plus `npm run smoke`, `simulation.mjs`. Review focus: case (j) fails before the shader change.

### Task D7: Bloom shimmer on medium and low (about 3 hours, port 5193)

**Files:** `src/render/shaders/bloom_downsample.wgsl`, `src/render/bloom.js`, `tests/render/bloom.test.js` (new), `tests/render/gates.test.js` (new), `tests/browser/bloom.mjs`, `tests/browser/pages/bloom.html` and `bloom-check.js` (new). Reads D2's render-capture tool.

- [ ] **Step 1:** Unit tests for `bloomTextureSize` and `Renderer.setBloomQuality` (divisors 2, 3, 4; unknown quality throws; unchanged quality returns early) and `packGateView` against gates.wgsl's documented layout (render review Minor 6).
- [ ] **Step 2:** GPU check (fails first): render a one-pixel bright line at 16 subpixel offsets through the downsample at divisors 3 and 4; assert the bloom energy varies by under 10 percent across offsets.
- [ ] **Step 3:** Take four bilinear taps at plus or minus a quarter output texel at divisors 3 and 4; fix the header comment.
- [ ] **Step 4:** `bloom.mjs` passes; `render-capture.mjs --out artifacts/bloom-after --compare <capture of the D7 base>` passes for high (must match) and is reported, not gated, for medium and low (expected to change; attach the PNGs).
- [ ] **Step 5:** Commit `Sample a box in the bloom downsample at the lower qualities`.

Review focus: Review Focus 4; tap count stays within the mobile budget.

### Task D8: Diagnose the quality.mjs carry gate (about 3 hours, port 5194)

**Files:** `tests/browser/quality.mjs` only (all instrumentation is page-side test code); read `src/sim/compact.js`, `simulation.js` and `capacity-swap.js`. Use superpowers:systematic-debugging.

Background: quality.mjs compares `before` (the last record before install, stats a few frames stale) with `after` (the first stats frame at or after the commit sequence) against `min(before.alive, 131072)`; as-is runs rise 7 to 17 percent (P42). Neither number is the count the compaction carried.

- [ ] **Step 1 (decisive experiment):** In the page, wrap `game.capacitySwap.commit` and `install` (test-side only) to read three exact counts by copying agent buffers to a MAP_READ buffer and counting alive flags with the layout from `src/sim/layout.js`: O, the old simulation's alive agents queued just before commit; N, the new simulation's alive agents queued right after install, before the next step; and A, alive in the first stats frame after install. Run 5 times as is, then 5 times with spawning held: `spawnPressure.setRamp({ floorFraction: 0, ceilingFraction: 0, refillFractionPerSecond: 0 })` from 30 steps before to 30 after the swap, and confirm SpawnPressure's per-step request total is 0 over that window (if the gate director or first fill still requests spawns, find the path and hold it test-side too).
- [ ] **Step 2 (decision):** If fewer than 3 of the 5 as-is runs rise by at least 5 percent (A against the old gate's reference), run 5 more as-is runs before deciding. If still fewer than 3 of 10 rise, the old gate was flaky by timing: record the 10 runs' numbers in the check's header, replace the gate with the exact carried count (N within 0.5 percent of min(O, newCapacity)) plus the 1.05 times target bound below, and open no fix task, provided carry is correct. Carry is correct when N is within 0.5 percent of min(O, newCapacity) in all 10 runs. Test timing (P42) is confirmed when carry is correct and A / N - 1 is under 1 percent in every held run while the as-is runs keep their 7 to 17 percent rise. Then rewrite the gate to assert N against min(O, newCapacity) within 0.5 percent, keep a bound that alive 10 frames later is under 1.05 times the alive target, and record the numbers in the check's header. A real carry bug is any of: N over min(O, newCapacity) by more than 0.5 percent (duplication), N under it by more than 0.5 percent (loss), or A / N - 1 over 1 percent in a held run (agents appear with spawning stopped). Then STOP with DONE_WITH_CONCERNS and the numbers; the controller opens a fix task in compact.js with this experiment as its regression test.
- [ ] **Step 3:** Commit `Measure the carried agents at install in the quality check` (test timing only).

Verify: `quality.mjs` five times, all pass. Review focus: the new gate fails on a real loss (scratch edit that drops half the compacted agents, then revert).

### Task D9: Browser harness hygiene (about 2 hours, port 5195)

**Files:** `tests/browser/server.mjs`, `smoke.mjs`, `smoke-lab.mjs`, `audio-render.mjs`, `tests/browser/pages/grid-check.js`, `player-check.js`, `audio-render-check.js`.

- [ ] **Step 1:** server.mjs: readiness requires the Vite child's own stdout to print the served URL (strip ANSI color codes before matching) as well as an HTTP 200, and the returned object gains `stop()` that kills the child and awaits its exit; `child` stays in the object, so other callers keep working unchanged. smoke.mjs uses `stop()`, validates `--frames` inside its try, names its magic numbers, reports a non-secure SMOKE_URL as exit 1 with its own message, and fixes the "stats:" spacing and the "aliveTotal at capture" wording.
- [ ] **Step 2:** Vacuities: grid-check seeds cell counts 1 to 64 instead of equal counts; player-check asserts overlap per frame.
- [ ] **Step 3:** smoke-lab: one Play run with the probe on (no `probe=off`) for 300 frames, no console errors, the stored preset unchanged afterwards (Plan C fix item 4). audio-render: one worst-case render (bomb, death and 50 kills at intensity 0.9) with peak at or below 0 dBFS (C5 limiter).
- [ ] **Step 4:** Commit `Tighten the browser harness and remove vacuous checks`.

Verify: every changed script once; grid.mjs fails with the scatter offset broken by one (scratch edit, revert). Review focus: no check got weaker.

### Task D10: Platform-aware launch flags and a GPU checks runner (about 2 hours, port 5196)

**Files:** `tests/browser/launch.mjs`, `tests/browser/webgpu-probe.mjs` (new), `tests/browser/gpu-checks.mjs` (new), `tests/browser/launch.test.js` (new; `npm test` picks it up), `package.json` (scripts only).

**Interfaces:** `webGpuFlagsFor({ platform, measuring })`: win32 keeps today's list byte for byte; linux uses `--headless=new`, `--enable-unsafe-webgpu`, `--enable-features=Vulkan`, `--use-angle=vulkan`, `--disable-vulkan-surface`, `--ignore-gpu-blocklist`, `--mute-audio` (Chrome's Linux guidance, sources below). `WEBGPU_ADAPTER=fallback` makes `launchWebGpuBrowser` add an init script calling `navigator.gpu.requestAdapter({ ...options, forceFallbackAdapter: true })` (test-side only). `npm run check:gpu` runs `webgpu-probe.mjs`, then grid, player, simulation and projectiles in sequence; exit 2 if the probe finds no adapter, 1 on any failure.

- [ ] **Step 1:** Node tests for `webGpuFlagsFor` per platform and for the init script being added only with `WEBGPU_ADAPTER=fallback`.
- [ ] **Step 2:** webgpu-probe.mjs prints the adapter's vendor and architecture, runs one compute dispatch doubling 1M u32 values, and checks the readback.
- [ ] **Step 3:** Run `npm run check:gpu` on hardware, then `WEBGPU_ADAPTER=fallback npm run check:gpu`; both exit 0, except that the fallback projectiles case (e) may fail until D6 lands (record it; the controller reruns after integration). Paste the probe's architecture lines (expect nvidia, then swiftshader) and each check's duration.
- [ ] **Step 4:** Commit `Choose WebGPU flags by platform and add a software adapter path`.

Review focus: win32 flags unchanged; the fallback path is never the default.

## Phase 3: Coverage and CI (parallel after Phase 2)

D11, D12a, D12b, D12c and D12d run in parallel on disjoint files. Integration order D11, D12a, D12c, D12d, D12b, then D13. A D12 test that exposes a bug stops that lane with DONE_WITH_CONCERNS and the failing test name; D12 lanes change no `src/` file.

### Task D11: Check workflow and the self-hosted browser workflow (about 2 hours, port none)

**Files:** `.github/workflows/check.yml` (new), `.github/workflows/browser.yml` (new), `.github/workflows/pages.yml` (name only), `tests/workflows.test.js` (new).

Decision: keep pages-check.yml (assembly) and pages.yml (deploy; it runs `npm test` only for trusted main and same-repository builds under `pull_request_target`). Add check.yml for every push and pull_request with `permissions: contents: read`, so untrusted pull request code is tested without a write token; the duplicate `npm test` on main is deliberate (deploy gate versus check). No GPU work in pages.yml.

- [ ] **Step 1:** `tests/workflows.test.js`, a fixed-spelling check (no YAML parser is available and none may be added; a comment says so): every line matching `uses:` in `.github/workflows/*.yml` has the exact shape `uses: <owner>/<name>@<40 hex> # v<version>`; check.yml contains the literal lines `  push:` and `  pull_request:` under `on:`; browser.yml contains no `pull_request` substring anywhere, contains `persist-credentials: false`, `contents: read` and the repository guard line.
- [ ] **Step 2:** check.yml jobs, each with `timeout-minutes`: `test` (ubuntu-latest, 15 minutes; checkout with `persist-credentials: false` and setup-node pins from pages.yml, node 24, `npm ci`, `npm test`, `npm run coverage`, `npm run build`); `gpu-software` (ubuntu-latest, 25 minutes, `continue-on-error: true` with a comment that it is advisory until its first green run, then the flag is removed; `sudo apt-get install -y libvulkan1 mesa-vulkan-drivers`, `npx playwright install --with-deps chromium`, `WEBGPU_ADAPTER=fallback npm run check:gpu`).
- [ ] **Step 3:** browser.yml: top-level `permissions: contents: read`; triggers `push` to main and `workflow_dispatch` only; `concurrency: { group: browser-gpu, cancel-in-progress: false }`; one job with `if: github.repository_owner == 'mtschoen'` (the repository name is not settled; a fork's owner differs), `runs-on: [self-hosted, gpu]`, `timeout-minutes: 60`, checkout with `persist-credentials: false`, setup-node, `npm ci`, `npx playwright install chromium`, then `npm run smoke`, `smoke.mjs --play 600`, `smoke-menu.mjs`, `smoke-lab.mjs`, `mobile-smoke.mjs`, `quality.mjs`, `npm run check:gpu`, `steer.mjs` and `bloom.mjs`, with `SMOKE_PORT` set once in the job's env.
- [ ] **Step 4:** pages.yml: `name: Publish Pages` and `run-name: Publish ${{ github.event.repository.name }}` (Plan A Task 4 minor).
- [ ] **Step 5:** Validate: `npm test`; `actionlint` if installed, else `python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/*.yml`; state which ran.
- [ ] **Step 6:** Commit `Add check and self-hosted browser workflows`.

Review focus: Review Focus 5; minimal permissions; no secret or write token in check.yml or browser.yml.

### Task D12a: Simulation tests skipped under R23 and Plan A (about 2 hours, port none)

**Files:** `tests/sim/**`.

- [ ] **Step 1:** Write and keep green: spawn director gate selection favors dense coarse cells and the far side (C0b, C0b2; injected density and random); each DEFAULT_RAMP and gate default pinned by value; every default species row finite (A Task 5); every params.js offset pinned by value (A Task 7).
- [ ] **Step 2:** `npm test`, `npm run coverage`; report per-file coverage before and after. Commit `Cover the spawn director and simulation packing`.

### Task D12b: GPU cases skipped under R23 (about 2 hours, port 5184)

**Files:** `tests/browser/pages/projectiles-check.js`, `tests/browser/smoke.mjs` (one sweep assertion).

- [ ] **Step 1:** Case (k): a 180 degree single-step beam reversal kills both half-sectors with no empty bin and nothing beyond the padding. Case (l): two non-identical overlapping bullets (different radii and speeds) kill the union. `smoke.mjs --sweep` with the lab sweep budget on: the drawn beam's reach matches the shortened kill reach within one coarse cell on the capture.
- [ ] **Step 2:** `projectiles.mjs`, `smoke.mjs --sweep`, `npm run check:gpu` and `WEBGPU_ADAPTER=fallback npm run check:gpu` pass. Commit `Cover beam reversal, mixed bullets and the shortened beam on the GPU`.

### Task D12c: Game tests skipped under R23 and Plan B (about 3 hours, port none)

**Files:** `tests/game/**`.

- [ ] **Step 1:** Write and keep green: every weapon table entry pinned by exact value (C0e, replacing range checks); `turret-only player on the base gun counts as onBaseGun for the pickup director` (R29, game level); useBomb rejected outside Playing (B1); unknown type throws, beam expiry, diagonal aim, swap mid-fire (B4); frozen ageing outside play, milestone restarting the pity timer, nearest of two collected, rotation not retyping existing pickups (B5); Game.scene per phase and onArmWeapon wiring (B6, B7); the test-side zero-charge drain loop in game.test.js gets a frame cap and uses the director's API instead of pushing a raw pickup (B6).
- [ ] **Step 2:** `npm test`, `npm run coverage`; per-file report. Commit `Cover the game logic skipped during prototyping`.

### Task D12d: UI, settings, input and render tests (about 2 hours, port none)

**Files:** `tests/ui/**`, `tests/settings/**`, `tests/input/**`, `tests/render/**`.

- [ ] **Step 1:** Write and keep green: probe cooldown with `windowFrames * frameSeconds < minimumSecondsBetweenSteps` (C1); the labPresets non-finite test with valid-length rules and matrix (C6a); charge bar and top-mode classes (B8); ship ease mid-turn lag (C0c); touchcancel, a second touch in the same half, the injected scheduler receiver with a call-count assertion, dispose removing its window listener (A Task 11); the resize observer's zero-size, unchanged-size and last-entry branches (A Task 13).
- [ ] **Step 2:** `npm test`, `npm run coverage`; per-file report. Commit `Cover the ui, input and render logic skipped during prototyping`.

## Phase 4: Close

### Task D13: Raise the gate, update docs, final verification (about 2 hours, port 5184)

**Files:** `package.json` (thresholds and exclusions), `tests/browser/gpu-checks.mjs` (add bloom.mjs), `README.md`, `SMOKE.md`, `AGENTS.md`.

- [ ] **Step 1:** Run `npm run coverage`; set the line and function thresholds to the measured values rounded down and prune stale exclusions. For every in-scope file under 100 percent lines, list the uncovered ranges and the reason in the report.
- [ ] **Step 2:** Docs (docs-update skill): README Commands gains `npm run coverage` and `npm run check:gpu`; a CI section says what check.yml runs, what browser.yml runs on a self-hosted GPU runner, and what stays local. SMOKE.md's automated list gains the same split. AGENTS.md Commands and file map gain the new scripts and files, and its CapacitySwap line gains the timeout. Grep every changed doc for U+2014.
- [ ] **Step 3:** Full run, sequential, teed to `artifacts/final-checks.txt`: `npm test`, `npm run coverage`, `npm run build`, `npm run smoke`, `smoke.mjs --play 600`, `smoke-menu.mjs`, `smoke-lab.mjs`, `mobile-smoke.mjs`, `quality.mjs`, `npm run check:gpu`, `WEBGPU_ADAPTER=fallback npm run check:gpu`, `steer.mjs`, `render-capture.mjs --compare`, `python tests/pages_assembly_test.py` (skips without rsync on Windows; say so).
- [ ] **Step 4:** Commit `Raise the coverage gate and document CI`.

## Acceptance for the whole plan

- Every fix-now triage row has a test that failed before its fix (or is recorded as already fixed); every resolved row is confirmed in a report; every dropped row is unchanged.
- `npm test`, `npm run coverage` and `npm run build` pass. These run on GitHub-hosted runners (check.yml `test`). The four small GPU page checks run there too on the SwiftShader fallback adapter, as an advisory job until its first green run.
- R24's "coverage back to 100%" is not fully met by this plan. The gate covers only modules node can import, and modules that need a GPU device or a DOM are excluded and covered by browser checks instead. D13's report lists every in-scope file below 100 percent with its uncovered ranges.
- Local only until the owner registers a self-hosted GPU runner (browser.yml): smoke, `--play`, smoke-menu, smoke-lab, mobile-smoke, quality, steer, bloom, render-capture, audio-render and capture-weapons. On the owner's desktop with the forced fallback adapter (Playwright 1.65 headless shell), the game ran at about 1.1 frames per second at 65,536 agents and 0.5 at 262,144. At that rate a 120-frame smoke takes minutes, and the `--play 600` and quality frame-time gates are meaningless on a CPU rasterizer.
- No file over about 500 lines without its note; no em-dash anywhere; no new dependency.

## CI research (decision and sources)

- Chrome's guidance for headless WebGPU on Linux uses `--headless=new --use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface --enable-unsafe-webgpu`. It was verified on a GPU instance, not a CPU runner ([Chrome for Developers](https://developer.chrome.com/blog/supercharge-web-ai-testing)).
- Emscripten's CI ran WebGPU tests in Chrome with `--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader --enable-features=Vulkan` ([emscripten commit](https://chromium.googlesource.com/external/github.com/emscripten-core/emscripten/+/refs/heads/webgpu_testing%5E%21/)).
- A third-party tool documents the SwiftShader Vulkan preset ([agent-browser](https://agent-browser.dev/webgpu)). It notes that `requestAdapter()` returns null without `libvulkan1` and Mesa, and that SwiftShader drops heavy scenes to single-digit frames per second.
- Standard GitHub runners have no GPU. GPU larger runners need a Team or Enterprise plan and are billed per minute even for public repositories ([GitHub runner pricing](https://docs.github.com/en/enterprise-cloud@latest/billing/reference/actions-runner-pricing)).
- Local spike on this machine (2026-11-07), Windows:
  - The `--use-webgpu-adapter=swiftshader` flag sets returned a null adapter.
  - Today's flags plus `forceFallbackAdapter: true` returned a SwiftShader adapter (vendor google, 10 storage buffers per stage) that ran a 1M-element compute dispatch correctly.
  - On it, grid, player and simulation passed. Projectiles passed every case but the sidewinder speed equality (1.9975 against 2.0000).
- Decision: GitHub-hosted runners run unit tests, coverage, build and, as an advisory job, the four small GPU page checks through the fallback adapter. The Linux path is unverified until check.yml first runs after publication. A Linux run on llamabox before then is optional (open question). The realistic answer for the full browser suite is a self-hosted runner on the owner's GPU machine (browser.yml: push to main and workflow_dispatch only, repository-owner guard, read-only token).

## Parked for the owner (not Plan D tasks)

- Publishing the public GitHub repo and enabling Pages (R5; the repo has no remote). check.yml, browser.yml and pages.yml first run then, and the gpu-software job's `continue-on-error` comes off after its first green run.
- Registering a self-hosted GPU runner labeled `gpu` for browser.yml (owner machine and account).
- The mtschoen.com/games/sentient-swarm/ deploy through the site's `ci/deploy-game.sh` (needs the public repo).
- The beam sweep budget default (R25).
- The swarm-shape tuning session (R20, R27: "the swarm should read as sentient"), including the steering-feel minors dropped above.
- Renaming the repo directory and package from murmuration.
- Whether a tap shorter than the fire interval should fire one shot (B4, P21 feel).
