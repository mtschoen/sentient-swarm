# Beam Shards and Beam Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The beam leaves the pickup rotation and becomes an earned event: the player fetches beam shards that appear one per wave off screen, and the last shard starts beam time, a short window of beam plus a surge of enemy spawning.

**Architecture:** Three small pure modules (`beam-time.js`, `beam-shards.js`, and a `WeaponState` override pair) hold the rules; one game-side module (`beam-time-seats.js`, on the pattern of `seats.js`) applies them to the seats and keeps `game.js` growth to a few hook lines. Shards are ordinary entries in `PickupDirector.pickups` flagged `persistent`, drawn by the existing pickup shader through a new shape value, and pointed at by their own DOM pointer pool. The surge is a multiplier inside `SpawnPressure` plus a `surging` flag on `SpawnDirector`, never a preset or quality change.

**Tech Stack:** Plain JavaScript ES modules, WGSL (one fragment-shader branch, no new pass or buffer), node:test, Playwright for the evidence script only.

**Spec:** There is no spec file. The binding source is the owner rulings and the orchestrator's defaults in the "Rulings and defaults" section below, plus `docs/superpowers/specs/2026-11-13-swarm-weapons-design.md` sections 4.2 and 9 for context (its recommended kill meter, R1, was NOT chosen; the owner chose shards). Task 14 records the choice there.

## Global Constraints

- Plain JavaScript ES modules and WGSL. No TypeScript. No runtime dependencies.
- Full-word identifiers (`maximum`, not `max`; `position`, not `pos`).
- No em-dashes (U+2014) anywhere, including comments and docs.
- Every source file under about 500 lines or carrying a one-line note at the top. `src/game/game.js` already carries one (744 lines): its additions stay under about 25 lines. New logic goes in new files.
- No hard-coded machine paths. No wall-clock assertions in tests: inject time (tests pass `deltaSeconds` explicitly).
- Mobile WebGPU limits unchanged: no new buffer, no new pass, storage buffer count untouched.
- Commit after every task with an imperative message ending with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (the executor's own model line).
- No new settings key, storage key, job kind, GPU buffer or pass (see "Needs owner consent").
- Baseline: `npm test` in a worktree without `node_modules` shows exactly 2 failures (`tests/browser/launch.test.js` and `tests/build.test.js`, both "Cannot find module" for dev dependencies). Every task must keep the failure count at or below that baseline; with `npm ci` done it is 0.

## Rulings and defaults

Owner rulings (binding): (1) the beam must be earned and leaves the normal rotation; (2) about 6 shards "spread out across waves", one per wave, away from the player, waiting until fetched; (3) the last shard gives beam time, "super aggressive spawning but you have the beam", both end together and the shard count resets; (4) the shard has "its own unique offscreen pointer that throbs or something"; (5) the beam stays a special occasion.

Defaults taken for the owner (each is a constant or lab knob, so reversing is a one-line change):

| Default | Value | Cost if wrong |
| --- | --- | --- |
| Shards needed `BEAM_SHARDS_NEEDED` | 6 | Constant plus lab knob `beamShardsNeeded`; pips are rebuilt when it changes. |
| Beam time `BEAM_TIME_SECONDS` | 8 s real time, kept through pause | Lab knob `beamTimeSeconds`. |
| Beam during beam time | today's beam, tier 1 (`BEAM_TIME_TIER`), one per live seat from its swarm centroid, ships fire no projectiles, rail turrets keep firing | Tier 1 is the narrowest beam (half width 0.12); tier 2 or 3 is one constant. The brief fixed "width unchanged" but not which tier, so this is a gap the plan filled. |
| Weapon override | previous kind, tier and charge return afterwards; charge does not drain meanwhile; weapon pickups collected meanwhile apply to the returning weapon | Pickups during beam time feel "banked" rather than immediate. |
| Shard persistence | uncollected shards persist and accumulate; none spawn during beam time; bombs and the pickup blast never touch them | Accumulation lets all six wait at once (see pacing). `maximumWaiting` cap in Task 5 keeps count plus waiting at most `needed`. |
| "Away from you" | off screen, inside the world, not at a gate (rule in Task 5) | Placement constants in `beam-shards.js`. |
| Collecting | normal pickup effect and blast; the last shard starts beam time with a stronger cue (Task 11) | Cue is data in `sfx.js`. |
| Death and quit | death, a new run and quit to title end beam time and reset the count | None. |
| Co-op | one shared count; either seat not down collects; beam time to every seat not down; a revived seat gets the remainder | Per-seat counts would be a new mechanism. |
| HUD | `needed` pips always present, a beam time bar while running | Row heights in the band and top layouts, checked in Task 13. |
| Pointer | distinct chevron, beam hue, 28 px against 14 px, CSS throb (opacity and transform only), no throb under reduced motion | Size and hue constants. |
| Surge | multiplier on the alive target and refill rate, default 3 (`DEFAULT_BEAM_TIME_SURGE`), ceiling 40 percent of capacity; all open gates emit; the wave bank is bypassed | Lab knob `beamTimeSurge` (range 1 to 6). |
| Count reset moment | the count stays full while beam time runs and resets when it ends (reading "both end together") | Alternative: reset at start; pips would empty while the bar runs. |
| Shard collected while beam time runs | consumed with no effect and no extension. Cannot happen in the shipped rules (nothing spawns, count plus waiting never exceeds needed); only a lab knob lowering `needed` mid-run reaches it. | None. |

## Needs owner consent (not planned)

- A second pickup frequency fix for R31 by duplicating a weapon slot (see Pacing and R31): data only, but it invents a weapon bias nobody ruled on. Planned alternative: the shorter five slot rotation.
- Per-seat shard counts or a separate beam time per seat: a new mechanism.
- Persisting anything about shards or beam time (a new settings or storage key): not needed, nothing persists.
- Easing the surge in and out (a ramp state): the plan uses a step; an ease is one more state machine.
- Any beam width or damage change, a pooled beam, tethers: out of scope per the brief.
- Closing GitHub issue 10 itself: the plan only records its two answers in docs (Task 14); closing the issue is the owner's.

## Facts the code settled (verified by reading unless marked inference)

- **Wave length.** `DEFAULT_GATE_SCHEDULE` in `src/sim/spawn-director.js` has `wavePeriodSeconds: 1.6` and `waveSeconds: 0.7`; `SpawnDirector.reset()` sets `waveClock = wavePeriodSeconds`. A wave starts every 1.6 s of director time (the first at 1.6 s) and emits for 0.7 s. The director keeps no wave counter today (Task 6 adds `waveSequence`).
- **Six waves take 9.6 s** (6 x 1.6), counted in director time (slower under a time warp). One shard per wave with six needed puts all six shards in the world by about 10 s into a run. The real pacing is then the player's travel: the point moves at 6 units per second (`PlayerShip` default `speed = 6`), the world is 32 by 18 and the view 16 by 9, so a shard outside the view is roughly 5 to 20 units away, about 1 to 3 s of flight each (inference); six sequential trips with fighting is likely 30 to 60 s (inference). That is **below** the 1 to 2 minute target, and "one shard per wave" is a very fast clock because a "wave" is 1.6 s.
- **Smallest adjustment (owner question, not applied):** make the cadence `BEAM_SHARD_WAVE_INTERVAL` (default 1, the ruling; lab knob `beamShardWaveInterval`). At 10 waves per shard a shard spawns every 16 s, the sixth at 96 s (10 x 1.6 x 6), plus fetch time: about 100 to 110 s. At 8 waves, 77 s plus fetch. Alternatively fewer shards at interval 1 does not help (3 shards is 4.8 s). Recommended question: "interval 10 waves, 6 shards?".
- **R31 wording.** `src/game/weaponTypes.js` line 26: "The pickup rotation (owner ruling R31): the weapons in their order, then the time warp, so a time warp is offered one slot in six." `tests/game/pickups.test.js` is titled "the time warp joins the rotation after the weapons, one slot in six" and asserts `PICKUP_TYPE_NAMES` equals `[...WEAPON_TYPE_NAMES, 'timewarp']`. The swarm weapons design doc line 167 flags "1 in 5, check the R31 ruling about 1 in 6". The rotation is time based (`rotationSeconds` 20 per slot, `PickupDirector.update`), so the ratio is a share of time: today 20 of 120 s (one sixth); with the beam removed 20 of 100 s (one fifth).
- **Recovery guard.** `PickupDirector` pity spawns fire when every seat is down or on the base gun for `pitySeconds` (10). During beam time the armed weapon is the beam, so `onBaseGun` is false and the pity timer resets to 0 and stays there; it restarts when the weapon returns. A weapon held under the override that is not base does not count as base either way. Milestone spawns still happen. Chosen: leave it (pity paused during beam time); no code.
- **Fade.** Ordinary pickups fade out after `fadeSeconds` (10) in `PickupDirector.update`. Shards must not: Task 2 exempts `persistent` entries.
- **Lab arm weapon.** `labPanel.js` builds its select from `WEAPON_TYPE_NAMES`, which keeps `'beam'`, and calls `game.debugArm`. Only `PICKUP_TYPE_NAMES` changes, so the lab can still arm the beam directly. `sfx.test.js` and `projectiles-pickups.test.js` iterate `WEAPON_TYPE_NAMES` and are unaffected.
- **Tests that go through the rotation and must change** (found by grep): `tests/game/pickups.test.js` lines 56, 68, 121 (`offeredType` is `'beam'` first), 178 to 186 (rotation equals weapons plus timewarp, two time warps in twelve slots), 196 to 200 (pity spawn skipping the time warp slot offers `'beam'`); `tests/game/weapons.test.js` line 197 (`PICKUP_TYPE_NAMES` literal); `tests/game/game.test.js` line 357 (`rotationIndex` set by name, unaffected). No browser script collects the beam through the rotation: `smoke.mjs`, `smoke-clearing.mjs` and `player.mjs` arm it through `armFromPanel` or `game.debugArm`, which stay.
- **Reduced motion.** `reducedMotion` is an existing stored setting (`src/settings/storage.js`) applied in `applySettings` in `src/main.js`; nothing sets a document attribute yet, so Task 10 sets `data-reduced-motion` on `document.documentElement` from it (no new key).
- **Quality probe hazard.** `Game.acceptsProbeFrames` feeds `QualityController`, which steps presets down (and persists) when frames run slow. A surge could trip it. Task 7 makes `acceptsProbeFrames` false while beam time runs.

## File Structure

New files:
- `src/game/beam-time.js` (`BeamTime`, constants): the real-time timer, pure.
- `src/game/beam-shards.js` (`BeamShards`, `placeShard`): the shared count, the wave cadence and the placement rule, pure.
- `src/game/beam-time-seats.js`: game-side functions taking `Game` (spawn on waves, collect a shard, start, tick and end beam time, join a revived seat).
- `src/ui/beam-shard-pointer.js` and `src/ui/beam-shard-pointer.css`: the pointer pool and its animation.
- `tests/game/beam-time.test.js`, `tests/game/beam-shards.test.js`, `tests/game/beam-time-seats.test.js`, `tests/ui/beam-shard-pointer.test.js`, `tests/browser/beam-time.mjs`.

Modified: `src/game/weaponTypes.js`, `src/game/pickups.js`, `src/game/weapons.js`, `src/game/game.js` (hooks only), `src/game/seats.js`, `src/sim/spawner.js`, `src/sim/spawn-director.js`, `src/render/pickups.js`, `src/render/shaders/pickups.wgsl`, `src/ui/hud.js`, `src/ui/hud.css`, `src/ui/edgeIndicators.js`, `src/ui/lab.js`, `src/ui/panelModel.js`, `src/ui/labPresets.js`, `src/audio/sfx.js`, `src/audio/audio-hook.js`, `src/main.js`, `index.html`, `AGENTS.md`, the swarm weapons spec, and the matching tests.

## Contract shared by the parallel lanes

`Game.state` gains three fields (Task 7 produces, Tasks 9 and 10 consume):
- `beamShards`: integer count collected (0 to needed).
- `beamShardsNeeded`: integer, the current `BeamShards.needed`.
- `beamTime`: number in [0, 1], `BeamTime.fraction` (1 just after the start, 0 when idle).

Pickup entries for shards: `{ x, y, type: 'beamshard', age: 0, fade: 1, persistent: true }`. Constants from `src/game/weaponTypes.js` (Task 1): `BEAM_SHARD_TYPE = 'beamshard'`, `PICKUP_SHAPE_SHARD = 2`, `PICKUP_HUES.beamshard = WEAPON_HUES.beam` (0.92). Effects cues (Task 7 calls, Task 11 implements): `effects.pickup('beamshard', ...seatArguments)` for a shard, `effects.pickup('beamtime', ...seatArguments)` for the last shard, `effects.expiry()` when beam time ends.

## Parallel lanes

- Lane A (rules, `src/game`): Task 1, then 2, then 5. Task 3 and Task 4 are independent of everything and of each other.
- Lane B (`src/sim`): Task 6, independent.
- Lane C (render): Task 8 after Task 1.
- Lane D (HUD): Task 9 after the contract above (needs no code from other tasks).
- Lane E (pointer): Task 10 after Task 1.
- Lane F (audio): Task 11, independent.
- Join: Task 7 needs Tasks 1 to 6. Task 12 (lab) needs Task 7. Task 13 (browser evidence) needs 7 to 12. Task 14 (docs) last.
- No two parallel lanes edit the same file: `hud.css` belongs to Task 9 only (the pointer has its own css file), `edgeIndicators.js` to Task 10, `main.js` and `index.html` to Task 10, `game.js` to Task 7.

---

### Task 1: Take the beam out of the rotation and name the shard type

**Files:**
- Modify: `src/game/weaponTypes.js:24-31`
- Test: `tests/game/weapons.test.js:197`, `tests/game/pickups.test.js` (lines 56, 68, 121, 178-200)

**Interfaces:**
- Produces: `PICKUP_TYPE_NAMES = ['scatter', 'rail', 'pulse', 'sidewinders', 'timewarp']` (five slots, frozen); `BEAM_SHARD_TYPE = 'beamshard'`; `PICKUP_SHAPE_SHARD = 2`; `PICKUP_HUES = { timewarp: 0.72, beamshard: 0.92 }` (beamshard from `WEAPON_HUES.beam`). `WEAPON_TYPE_NAMES` is unchanged (still includes `'beam'`).

- [ ] **Step 1: Write the failing tests.** In `tests/game/weapons.test.js` change the literal at line 197 to `['scatter', 'rail', 'pulse', 'sidewinders', 'timewarp']` and add `assert.equal(PICKUP_HUES.beamshard, WEAPON_HUES.beam)` and `assert.equal(BEAM_SHARD_TYPE, 'beamshard')`, `assert.equal(PICKUP_SHAPE_SHARD, 2)`. In `tests/game/pickups.test.js` rewrite the rotation test as "the rotation offers scatter, rail, pulse, sidewinders then timewarp, one slot in five, and never the beam": offered over ten slots equals the names twice, `offered.includes('beam') === false`, two time warps. Change the `'beam'` expectations at lines 56, 68, 121 to `'scatter'`, line 70 to `'rail'`, line 72 to `'pulse'`; the pity test (lines 188-200) becomes: advance `4 * 20 + 0.1` seconds to reach the time warp slot, the pity spawn offers `'scatter'` (the next slot wraps to index 0).
- [ ] **Step 2: Run** `node --test tests/game/pickups.test.js tests/game/weapons.test.js`. Expected: FAIL (rotation still includes the beam).
- [ ] **Step 3: Implement** in `weaponTypes.js`: `PICKUP_TYPE_NAMES = Object.freeze([...WEAPON_TYPE_NAMES.filter((name) => name !== 'beam'), 'timewarp'])`; add the three new exports; rewrite the R31 comment to say the time warp is now one slot in five (a share of 20 of 100 s) and why (the beam is earned through shards, `beam-shards.js`).
- [ ] **Step 4: Run** the same command plus `node --test tests/game/game.test.js tests/ui/hud.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/game/weaponTypes.js tests/game && git commit -m "Remove the beam from the pickup rotation"`.

### Task 2: Persistent shard pickups in the director

**Files:**
- Modify: `src/game/pickups.js` (header comment, `update`, new `spawnShard`, `waitingShards`)
- Test: `tests/game/pickups.test.js`

**Interfaces:**
- Consumes: `BEAM_SHARD_TYPE` from Task 1.
- Produces: `PickupDirector.spawnShard(x: number, y: number): void` pushes `{ x, y, type: BEAM_SHARD_TYPE, age: 0, fade: 1, persistent: true }`; getter `waitingShards: number` (entries of that type); `update` leaves `persistent` entries un-aged (`fade` stays 1, never filtered); `collect` and `reset` work unchanged (reset clears them).

- [ ] **Step 1: Failing tests.** (a) a shard survives 60 s of `run(director, 60)` with `fade === 1` while an ordinary pickup spawned with it is gone after `fadeSeconds`; (b) `collect(x, y)` at the shard returns `'beamshard'` and `waitingShards` drops to 0; (c) `reset()` clears shards; (d) 100 spawns across the full rotation, milestone and pity, never yield type `'beam'` or `'beamshard'` (use the existing fake random pattern in the file); (e) `phasePlaying: false` leaves a shard untouched.
- [ ] **Step 2: Run** `node --test tests/game/pickups.test.js`. Expected: FAIL (`spawnShard` is not a function).
- [ ] **Step 3: Implement** as specified. The aging loop skips `persistent`; the filter keeps `persistent || age < fadeSeconds`. Update the file's header comment (shards are placed by `beam-shards.js`, not here).
- [ ] **Step 4: Run** the same test file. Expected: PASS.
- [ ] **Step 5: Commit** `Add persistent beam shard pickups`.

### Task 3: The beam time timer (parallel lane)

**Files:**
- Create: `src/game/beam-time.js`, `tests/game/beam-time.test.js`

**Interfaces:**
- Produces: `BEAM_TIME_SECONDS = 8`, `BEAM_TIME_TIER = 1`, `class BeamTime { constructor({ durationSeconds = BEAM_TIME_SECONDS } = {}); setDuration(seconds): void` (throws `RangeError` unless finite and above 0, as `TimeWarp.setDuration`); `start(): void` (sets remaining to a full duration, also when already running); `end(): void`; `update(realDeltaSeconds): boolean` (counts down; returns true on the one call in which the timer reached 0 and ended, else false; residue under 1e-6 counts as over, as `TimeWarp.update`); getters `active`, `remainingSeconds`, `fraction` (remaining over total, 0 idle) `}`.

- [ ] **Step 1: Failing tests** (injected deltas only): idle `update(1)` returns false and `fraction` is 0; after `start()` `fraction` is 1; `update(4)` gives 0.5 and false; the update that crosses 8 returns true exactly once and `active` is false; a later `update` returns false; `start()` mid-run refills to 1; `setDuration(0)`, `NaN` and `-1` throw `RangeError`; 480 updates of `1 / 60` end within one update of 8 s (float dust case).
- [ ] **Step 2: Run** `node --test tests/game/beam-time.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `BeamTime` after the pattern of `src/game/time-warp.js`, without ramps or scale. Header comment: counts real time (the game calls it every unpaused update), so a pause keeps it.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `Add the beam time timer`.

### Task 4: Weapon override for beam time (parallel lane)

**Files:**
- Modify: `src/game/weapons.js` (`collect`, `dropArmed`, `dropAll`, `update`'s drain, new methods)
- Test: `tests/game/weapons.test.js`

**Interfaces:**
- Produces on `WeaponState`: `beginBeamTime(tier: number): void` (stashes `{ armed, tier, charge }`, arms `'beam'` at `tier` with `charge = 1` and `accumulator = 0`; if already active it does nothing, so a second call never stashes the beam itself); `endBeamTime(): void` (restores kind, tier and charge from the stash, `accumulator = 0`; no-op when inactive); getter `beamTimeActive: boolean`. While active: `update` does not drain `charge` and never reports `expired`; `collect(typeName)` for a non-rail weapon changes the stashed loadout by the normal swap or tier-up rules while the armed beam stays armed, and returns the stashed `{ swapped, tier, ... }`; rail pickups add turrets as always (turrets are not stashed); `dropAll()` clears the override entirely (death, new run, a seat going down, `debugArm`).

- [ ] **Step 1: Failing tests.** (a) start armed `scatter` tier 2 charge 0.5, `beginBeamTime(1)`: `armed === 'beam'`, `tier === 1`, `beamTimeActive`; 100 firing updates of 0.1 s leave `charge === 1` and no `expired`; `endBeamTime()` restores `'scatter'`, tier 2, charge 0.5; (b) on base gun the restore is `base`, `isBase` true; (c) `collect('pulse')` during beam time leaves `armed === 'beam'`, and after `endBeamTime()` the weapon is `pulse` with charge 1 (swap rule: tier `max(1, 2 - 1)`); `collect('scatter')` while stashed scatter tier-ups to 3; (d) `collect('rail')` during beam time increments `railTurrets` and the turrets fire in `update` (`turretSpawns.length > 0` while firing); (e) `dropAll()` during beam time returns to `base` with `beamTimeActive` false and a later `endBeamTime()` changes nothing; (f) `beginBeamTime` twice then `endBeamTime` restores the original weapon, not the beam; (g) `update` while armed by override with firing returns `beam` with `halfWidth === WEAPON_TYPES.beam.tiers[0].radius`.
- [ ] **Step 2: Run** `node --test tests/game/weapons.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Hold the stash in a private field (`#held`, null when inactive). `collect` while `#held !== null` and `typeName !== 'rail'` runs the existing swap logic against the stash (extract the swap/tier arithmetic into a small private helper over a `{ armed, tier, charge }` object so both paths share it, no duplicated rule). In `update`, skip the drain block when `#held !== null`. `dropArmed` (expiry path) must not run during the override; `dropAll` sets `#held = null`.
- [ ] **Step 4: Run** `node --test tests/game/weapons.test.js tests/game/swarm-fire.test.js tests/game/player-seat.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `Let WeaponState hold a weapon under beam time`.

### Task 5: Shard count, wave cadence and placement (lane A, after Task 2)

**Files:**
- Create: `src/game/beam-shards.js`, `tests/game/beam-shards.test.js`

**Interfaces:**
- Consumes: `BEAM_SHARD_TYPE` (Task 1) is not needed here; only `WORLD_BOUNDS` from `src/sim/layout.js`.
- Produces: `BEAM_SHARDS_NEEDED = 6`, `BEAM_SHARD_WAVE_INTERVAL = 1`, `MAXIMUM_BEAM_SHARDS_NEEDED = 8`, `MAXIMUM_BEAM_SHARD_WAVE_INTERVAL = 60`.
  `class BeamShards { constructor({ needed = BEAM_SHARDS_NEEDED, waveInterval = BEAM_SHARD_WAVE_INTERVAL } = {}); setNeeded(count): void` (integer in [1, 8] else `RangeError`); `setWaveInterval(waves): void` (integer in [1, 60] else `RangeError`); getters `count`, `needed`, `waveInterval`; `onWaves(waveSequence: number, { waiting: number, beamTimeActive: boolean }): number` returns how many shards to spawn now (0 or 1); `collect(): { count: number, completed: boolean }` (count plus 1; `completed` is `count >= needed`; count is not clamped, a collect during beam time simply reports `completed: false` and the caller ignores it); `finish(): void` (count to 0 and the wave tally to 0: called when beam time ends); `reset(): void` (everything to 0 including the last seen wave sequence) `}`.
  `placeShard(context, random = Math.random): { x, y }` with `context = { bounds, view: { centerX, centerY, width, height }, anchor: { x, y }, gates: [{ x, y, radius }], shards: [{ x, y }], densityAt: ((x, y) => number) | null }`.

- [ ] **Step 1: Failing tests.**
  Cadence (`onWaves`): with interval 1, `onWaves(1, ...)` is 1, `onWaves(1, ...)` again is 0, `onWaves(3, ...)` is 1 (a jump of two waves spawns one, never a burst); with interval 3 the sequences 1, 2 give 0 and 3 gives 1; `waiting + count >= needed` gives 0 and does not consume the tally; `beamTimeActive` gives 0 and the waves seen meanwhile are not banked (after beam time, the first new wave starts a fresh tally); a sequence lower than the last seen (a director reset) re-bases without spawning; `reset()` re-bases to 0; `setNeeded(0)`, `setNeeded(9)`, `setNeeded(2.5)`, `setWaveInterval(0)`, `setWaveInterval(61)` throw.
  Count: five `collect()` calls report `completed: false`, the sixth `true`; `finish()` returns `count` to 0.
  Placement (use a seeded fake `random`, view 16 by 9 centered at (16, 9) in `WORLD_BOUNDS`, anchor (16, 9)): 200 placements all lie inside the bounds inset by 1, outside the view rectangle grown by 1 (`SHARD_VIEW_MARGIN`), within `2 * view half-diagonal` of the anchor, at least `gate.radius + 2` from every gate (`SHARD_GATE_CLEARANCE`), and at least 4 (`SHARD_SPACING`) from every waiting shard; `densityAt` given: of the first 8 acceptable candidates the lowest density wins (ties to the earlier); fallback 1: with every gate covering the whole ring band, the reach limit is dropped first; fallback 2: gate clearance and spacing dropped; fallback 3 (view as large as the world, as with two seats at zoom 0.5): the result is the inset bounds corner farthest from the anchor (still a valid point, never `null`, never `NaN`); an anchor in a world corner still yields an off-screen point.
- [ ] **Step 2: Run** `node --test tests/game/beam-shards.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Placement constants exported for tests: `SHARD_WALL_INSET = 1`, `SHARD_VIEW_MARGIN = 1`, `SHARD_GATE_CLEARANCE = 2`, `SHARD_SPACING = 4`, `SHARD_MAXIMUM_REACH_HALF_DIAGONALS = 2`, `SHARD_PLACEMENT_ATTEMPTS = 32`, `SHARD_DENSITY_CANDIDATES = 8`. Draw uniform points in the inset bounds; accept on all four rules; take the first `SHARD_DENSITY_CANDIDATES` acceptable (first only when `densityAt` is null), choose by density like `PickupDirector.spawn`. Rationale in the header comment: off screen so the chevron pointer has a job, within reach so the trip is a few seconds, away from gates so a shard is not buried in a wave, spaced so six shards do not stack. The cadence and the rule "never more than needed in play" live in `onWaves`.
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit** `Add the beam shard counter and placement rule`.

### Task 6: Wave counter and the spawn surge (lane B, independent)

**Files:**
- Modify: `src/sim/spawn-director.js` (`reset`, `advanceWaves`, `update` options, header), `src/sim/spawner.js` (`targetAlive`, `stepCap`, new `setSurge`, constants)
- Test: `tests/sim/spawn-director.test.js`, `tests/sim/spawner.test.js`

**Interfaces:**
- Produces on `SpawnDirector`: public `waveSequence: number` (0 after `reset()`, incremented once each time a wave actually starts, that is when `activeWave` is set to a non-null gate in `advanceWaves`; never in continuous mode because waves run only through `advanceWaves`, which still runs in continuous mode, so increment only when `!this.continuous`); `update(...)` option `surging = false`: when true every open, not closing gate emits (`gate.emit` condition gains `|| surging`).
- Produces on `SpawnPressure`: `DEFAULT_BEAM_TIME_SURGE = 3`, `MAXIMUM_BEAM_TIME_SURGE = 6`, `BEAM_TIME_SURGE_CEILING_FRACTION = 0.4`; `setSurge(strength: number): void` (finite, in [1, 6], else `RangeError`); getter `surge`. `targetAlive` becomes `base` when `surge === 1`, else `Math.min(base * surge, Math.max(base, capacity * BEAM_TIME_SURGE_CEILING_FRACTION))`. The refill allowance rate in `stepCap` is multiplied by `surge`. `reset()` leaves `surge` alone (the game sets it every step); `setCapacity` keeps it.

- [ ] **Step 1: Failing tests.**
  Director: `waveSequence` is 0 after construction and `reset`; running `update(0.1)` for 1.7 s with open gates gives `waveSequence === 1`; for 9.7 s (1.6 s period, first at 1.6) gives 6; continuous mode never increments; a wave skipped because no gate can emit (`pickWaveGate` null) does not increment; with `surging: true` every open gate has `emit === 1` between waves, and with `surging: false` none does.
  Pressure: with `surge` 1 every existing test is unchanged; at `rampProgress` 1 (`elapsed = rampSeconds`) and capacity 262144, `setSurge(3)` gives `targetAlive === capacity * 0.3`; at `rampProgress` 0 the target is `3 * 0.01 * capacity`; `setSurge(10)` is clamped by the ceiling only when `base * surge` exceeds `capacity * 0.4` (test with `setSurge(6)` at progress 1: `capacity * 0.4`, not `0.6`); `setSurge(0.5)`, `setSurge(7)`, `NaN` throw; refill: after the first fill, with `wave = null`, the per-second allowed spawns with surge 3 are `3 *` the ones with surge 1 at the same target (compare equal targets by setting the ramp so both have the same `targetAlive`, or assert the allowance formula directly); the per-frame cap `maximumPerFrame` still bounds a step (a huge deficit never spawns more than `capacity / 60` in one step).
- [ ] **Step 2: Run** `node --test tests/sim/spawn-director.test.js tests/sim/spawner.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified; extend the `SpawnPressure` header with the surge paragraph (a multiplier for the beam time event, ceiling 40 percent of capacity against the 10 percent R37 ramp ceiling, intentionally above it for 8 seconds).
- [ ] **Step 4: Run** the same command plus `node --test tests/sim/spawn-director-ring.test.js tests/sim/spawn-director-placement.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `Add a wave counter and a spawn surge`.

### Task 7: Game integration (join)

**Files:**
- Create: `src/game/beam-time-seats.js`, `tests/game/beam-time-seats.test.js`
- Modify: `src/game/game.js` (hooks, about 25 lines), `src/game/seats.js` (`reviveSeats`, the death branch of `applySwarmHits`)
- Test: `tests/game/beam-time-seats.test.js` using `tests/game/game-harness.js` (`createGame`, `STEP`, `stats`, `runFor`, `hitNow` as in `game.test.js`), plus `tests/game/coop.test.js` additions

**Interfaces:**
- Consumes: Tasks 1 to 6.
- Produces in `beam-time-seats.js` (each takes the `Game`): `spawnShardsForWaves(game): void`; `collectShardFor(game, seat): void`; `startBeamTime(game): void`; `tickBeamTime(game, deltaSeconds): void`; `endBeamTime(game): void`; `joinBeamTime(game, seat): void`.
- Produces on `Game`: fields `beamShards` (a `BeamShards`), `beamTime` (a `BeamTime`), `beamTimeSurge` (default `DEFAULT_BEAM_TIME_SURGE`); methods `setBeamTimeSurge(strength)` (delegates range check to `SpawnPressure.setSurge` rules: throws `RangeError` outside [1, 6]); `state` fields `beamShards`, `beamShardsNeeded`, `beamTime` (contract above); `acceptsProbeFrames` false while `beamTime.active`.
- Behavior (each bullet is a test):
  - `spawnShardsForWaves`: called from `Game.spawnCounts` right after `spawnDirector.update` when `run.phase === Playing` and `!watching`. It calls `beamShards.onWaves(spawnDirector.waveSequence, { waiting: pickups.waitingShards, beamTimeActive: beamTime.active })`; for each requested shard it calls `placeShard({ bounds: worldBounds, view: this.view, anchor: pickupAnchor(seats), gates: spawnDirector.gates, shards: pickups.pickups.filter(shard), densityAt }, random)` then `pickups.spawnShard`.
  - `collectShardFor`: `beamShards.collect()`; if `completed` and beam time is not already running, `startBeamTime`; plays `effects.pickup('beamtime', ...seatArguments)` for the completing shard, `effects.pickup('beamshard', ...seatArguments)` otherwise. `Game.collectFor` keeps its blast and impulse for shards (the impulse for the completing shard is strength 1 with bloom boost, constant `BEAM_TIME_IMPULSE_STRENGTH`).
  - `startBeamTime`: `beamTime.start()`; every seat that is not down gets `weapons.beginBeamTime(BEAM_TIME_TIER)`. A seat that is down gets nothing.
  - `tickBeamTime`: called each non-paused update next to `timeWarp.update`; `beamTime.update(delta)`; when it returns true, `endBeamTime`.
  - `endBeamTime`: `beamTime.end()` (idempotent), every seat `weapons.endBeamTime()`, `beamShards.finish()`, `effects.expiry?.()`. Death, `resetModules` and `quitToTitle` end beam time silently (no expiry cue) and `resetModules` also calls `beamShards.reset()`.
  - `joinBeamTime`: called by `reviveSeats` after `seat.revive(...)` when `beamTime.active`; the seat gets `beginBeamTime`.
  - `Game.spawnCounts`: `const surging = this.beamTime.active && !this.watching`; `this.spawnPressure.setSurge(surging ? this.beamTimeSurge : 1)`; the director gets `surging`; `pressure.update` gets `surging ? null : this.spawnDirector.wave` as its wave argument (a null wave trickles refills every step, so the surge is not throttled by the wave bank).
  - `applySwarmHits` run death branch adds `game.beamTime.end()` beside `game.timeWarp.end()`; `seatGoesDown` needs no change (`dropAll` clears the override), beam time continues for the seats still up.

- [ ] **Step 1: Failing tests.**
  1. A started game, `Playing`, interval 1: advancing `1.7` s of updates places exactly one shard (type `beamshard`, `persistent`) inside the world, outside `game.view` grown by 1; `waitingShards + count` never exceeds 6 over 15 s of updates with the default fake stats; a shard stays through 30 s (no fade).
  2. Put a shard under the seat: next update `beamShards.count === 1`, `state.beamShards === 1`, one `pickup` effect with `'beamshard'`, the pickup blast `requestRadialKill` fired, weapons untouched.
  3. Collect six: the sixth update has `state.armed === 'beam'`, `state.tier === 1`, `state.beamTime === 1`, a `pickup('beamtime')` effect, `state.beamShards === 6`; `projectiles.beams.at(-1)` is non-null while fire is held (the beam is sent) and `projectiles.spawns` get no ship shots while firing, rail turrets (collect one rail pickup first) still queue turret spawns.
  4. Advance 8 s of real updates: `armed` returns to the weapon held before (arm `scatter` tier 2 at charge 0.5 first, assert it returns with charge 0.5 within 1e-9), `state.beamTime === 0`, `state.beamShards === 0`, one `expiry` effect.
  5. Pause: `game.pause()` then 100 `update(STEP)` calls leave `beamTime.remainingSeconds` unchanged; after `resume()` it counts again.
  6. Surge: while beam time runs `simulation.seekScales` unaffected, `spawnPressure.surge === 3` and `spawnPressure.targetAlive` is 3x the base target (capped at 40 percent of capacity); the director's gates all `emit` (check through `spawnDirector.spawnGates`); after beam time `surge === 1`. `acceptsProbeFrames` is false during beam time and true after.
  7. Death during beam time (scripted wipe through `hitNow`): `beamTime.active` false, the next `restart()` leaves count 0, no shards in the world, `weapons` base.
  8. Weapon pickup collected during beam time (scatter pickup under the seat): armed stays `beam`; after beam time `armed === 'scatter'`, tier 1, charge 1. A time warp pickup during beam time starts the warp and does not change `beamTime.remainingSeconds` accounting (real time).
  9. `quitToTitle()` mid beam time resets count, timer, surge and shards.
  10. Co-op (in `coop.test.js` style): two seats, seat 2 collects the sixth shard: both seats are armed `beam`; with seat 2 down at the start only seat 1 is, and when seat 2 revives mid beam time it has `armed === 'beam'` for the remainder and the same restore at the end; a seat that goes down during beam time drops to base and does not get its old weapon back at the end (`dropAll`); the shared count is one number in `state`.
  11. `setBeamTimeSurge(0.5)` and `setBeamTimeSurge(7)` throw `RangeError`; lab Watch mode (`setWatch(0.1)`) never places a shard and never surges.
- [ ] **Step 2: Run** `node --test tests/game/beam-time-seats.test.js tests/game/coop.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the six functions and the `Game` hooks. Update the `game.js` header frame-order comment (steps 3, 4 and 6 gain one sentence each) and keep the additions small. Add the import of `BeamTime`, `BeamShards`, `SpawnPressure` constants.
- [ ] **Step 4: Run** `npm test`. Expected: failures at or below the baseline (2 without `node_modules`).
- [ ] **Step 5: Commit** `Wire beam shards and beam time into the game`.

### Task 8: The shard look in the pickup renderer (lane C, after Task 1)

**Files:**
- Modify: `src/render/pickups.js` (`packPickupView`), `src/render/shaders/pickups.wgsl` (fragment shape branch), comment at the top of both
- Test: `tests/render/projectiles-pickups.test.js`, `tests/gpu/shaders.test.js` (whatever it asserts for the pickup shader; read before editing)

**Interfaces:**
- Consumes: `BEAM_SHARD_TYPE`, `PICKUP_SHAPE_SHARD`, `PICKUP_HUES.beamshard` (Task 1).
- Produces: a pickup of type `beamshard` packs hue `WEAPON_HUES.beam + PICKUP_SHAPE_SHARD` (2.92). In the shader the shape is `floor(hue)`: 0 hexagon, 1 clock, 2 shard.

- [ ] **Step 1: Failing test.** `packPickupView` for `[{ x, y, type: 'beamshard', fade: 1 }]` writes `[x, y, WEAPON_HUES.beam + PICKUP_SHAPE_SHARD, 1]` (compare through `Math.fround`); the weapon and time warp packings are unchanged.
- [ ] **Step 2: Run** `node --test tests/render/projectiles-pickups.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `pickups.js` pick the hue by type through a small lookup (weapon hue, `timewarp` plus `PICKUP_SHAPE_CLOCK`, `beamshard` plus `PICKUP_SHAPE_SHARD`). In `pickups.wgsl` replace `clock = hue >= 1.0` by `let shape = floor(input.hue);` and branch: shard draws a rotating diamond (L1 distance, radius about 0.30, inside the 0.5 half extent), a pulse twice as fast (`PULSE_RATE * 2.0`), an outline half width of `OUTLINE_HALF_WIDTH * 1.4`, `SHARD_CORE` of 1.8 and saturation 0.7, so it reads larger, brighter and a different shape from the weapon hexagons and the clock. No new uniform, binding or pass; the uniform layout comment stays valid.
- [ ] **Step 4: Run** `node --test tests/render tests/gpu`. Expected: PASS.
- [ ] **Step 5: Commit** `Draw beam shards as a bright diamond`.

### Task 9: HUD pips and the beam time bar (lane D)

**Files:**
- Modify: `src/ui/hud.js`, `src/ui/hud.css`
- Test: `tests/ui/hud.test.js`, `tests/ui/hud-backdrop.test.js` (read it: it may enumerate HUD rows)

**Interfaces:**
- Consumes: `state.beamShards`, `state.beamShardsNeeded`, `state.beamTime` (contract above); every field may be absent (treat as 0, needed 6).
- Produces: in the right panel after the warp row: a pips row `hud-beam-pips` (`aria-label="Beam shards"`) with `needed` child spans `hud-pip`, the first `beamShards` also `hud-pip-filled`, the row always visible (ghost outlines when empty, never hidden, never added or removed during play; it rebuilds its spans only when `beamShardsNeeded` changes, which only the lab does); then a bar `hud-beam` (label `BEAM`, track and fill, copying the warp bar's markup and its `visibility: hidden` at 0 so the row stays reserved), fill width from `state.beamTime`.

- [ ] **Step 1: Failing tests** (fake DOM as in the file): at `beamShards 0 / needed 6` the row has 6 spans and none filled; at 3 exactly the first three carry `hud-pip-filled`; at 6 all filled and the bar fill width is `100%` with `state.beamTime: 1` and the bar visible; `beamTime: 0` hides the bar by visibility (not `hidden`, not removal) and the pips row is still present; `beamShardsNeeded` changing from 6 to 4 gives 4 spans; undefined fields do not throw; the pips row and the bar are children of the right panel and inherit `data-touch-exclusive` through the panel.
- [ ] **Step 2: Run** `node --test tests/ui/hud.test.js tests/ui/hud-backdrop.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** with `setText`-style change guards (no DOM write when unchanged). CSS: pips are small rings in the beam hue (`hsl(331, 90%, 66%)`) with a filled variant and glow, the bar in the same hue, the 13 px floor, `min-height` reserving the row; `.hud-top` variants (compact pips, bar width 70 px) next to the existing `.hud-top .hud-warp` rule. Do not touch `index.html` here.
- [ ] **Step 4: Run** `node --test tests/ui`. Expected: PASS.
- [ ] **Step 5: Commit** `Show beam shard pips and the beam time bar`.

### Task 10: The shard pointer (lane E, after Task 1)

**Files:**
- Create: `src/ui/beam-shard-pointer.js`, `src/ui/beam-shard-pointer.css`, `tests/ui/beam-shard-pointer.test.js`
- Modify: `src/ui/edgeIndicators.js` (`edgeIndicatorTargets` skips shards), `src/main.js` (create the pointers, update them in `render`, set `data-reduced-motion`), `index.html` (one stylesheet link), `tests/ui/edgeIndicators.test.js`

**Interfaces:**
- Consumes: `BEAM_SHARD_TYPE`, `PICKUP_HUES` (Task 1); `edgeIndicatorPlacement` from `edgeIndicators.js` (pure, reused).
- Produces: `BEAM_SHARD_POINTER_SLOTS = 8`, `BEAM_SHARD_POINTER_INSET_CSS_PIXELS = 40`, `beamShardTargets(pickups): [{ x, y }]` (pickups of type `beamshard`, at most the slot count); `createBeamShardPointers(parent, { documentObject = document }): { element, update(targets, viewBounds, rect) }`: eight persistent slots, each an outer element positioned by inline `transform: translate(...) rotate(...)` (as the existing chevrons) holding an inner `beam-shard-pointer-chevron` element, 28 CSS px, beam hue `hsl(331, 100%, 70%)`, fading by `opacity` only. The throb is the CSS animation `beam-shard-throb` on the inner element (opacity 0.55 to 1 and `scale(1)` to `scale(1.25)`, 0.9 s, ease-in-out, infinite), compositor properties only. `edgeIndicatorTargets` no longer lists shards, so the generic 12 slots are not spent on them.
- Reduced motion: `html[data-reduced-motion] .beam-shard-pointer-chevron { animation: none }` and the same under `@media (prefers-reduced-motion: reduce)`; the pointer then stays distinct by size, hue and a static glow (`filter: drop-shadow`, static, not animated). `main.js` `applySettings` sets `document.documentElement.toggleAttribute('data-reduced-motion', current.reducedMotion)`; no new settings key.

- [ ] **Step 1: Failing tests.** `beamShardTargets` returns only shards, in order, capped at 8, and ignores a shard that is inside the view only at update time; `edgeIndicatorTargets` with a `beamshard` and a `scatter` pickup returns only the scatter; with a fake document: 8 slots persist, an off-screen shard shows its slot (opacity `1`, transform contains `rotate(`), an on-screen shard and unused slots stay at opacity `0`, the inner element carries the class `beam-shard-pointer-chevron`, and the pointer inset is 40 (placement left at `rect.width - 40` for a target straight right); the stylesheet text (read the css file in the test with `readFileSync`) contains the `beam-shard-throb` keyframes with only `opacity` and `transform` declarations, contains no `box-shadow`, `width`, `top` or `left` inside the keyframes, and contains the reduced-motion override for both the attribute and the media query.
- [ ] **Step 2: Run** `node --test tests/ui/beam-shard-pointer.test.js tests/ui/edgeIndicators.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `main.js` create the pointer layer next to `createEdgeIndicators` (z-index just above it) and in `render` call `beamShardPointers.update(beamShardTargets(game.pickups.pickups), viewport.visibleBounds, cssArenaRect())`.
- [ ] **Step 4: Run** `node --test tests/ui`. Expected: PASS.
- [ ] **Step 5: Commit** `Add the throbbing beam shard pointer`.

### Task 11: Cues through the existing effect hooks (lane F, independent)

**Files:**
- Modify: `src/audio/sfx.js` (`pickup`), `src/audio/audio-hook.js` (`cues.pickup`)
- Test: `tests/audio/sfx.test.js`, `tests/audio/audio-hook.test.js`

**Interfaces:**
- Produces: `EffectsSynth.pickup(type)` handles `'beamshard'` (the weapon pickup run raised an octave, 4 notes) and `'beamtime'` (the weapon run then the raised run, 8 notes, one `playTone` per note, same voice as today); unknown types still play the weapon run. `cues.pickup('beamshard')` and `cues.pickup('beamtime')` play the effect and the music `pickup` cue (only `timewarp` skips the riser). No new voice, so `tests/browser/audio-render.mjs` needs no change beyond its existing pickup render.

- [ ] **Step 1: Failing tests** with the fake audio context: `pickup('beamshard')` schedules 4 tones whose first frequency is twice the weapon run's first; `pickup('beamtime')` schedules 8 tones; `pickup()` and `pickup('timewarp')` unchanged; the hook plays the riser for `'beamshard'` and `'beamtime'` and still skips it for `'timewarp'`; a locked engine plays nothing for either.
- [ ] **Step 2: Run** `node --test tests/audio`. Expected: FAIL.
- [ ] **Step 3: Implement** the two note tables next to `WEAPON_PICKUP_NOTES` and select by type.
- [ ] **Step 4: Run** `node --test tests/audio`. Expected: PASS.
- [ ] **Step 5: Commit** `Add beam shard and beam time pickup cues`.

### Task 12: Lab knobs (after Task 7)

**Files:**
- Modify: `src/ui/panelModel.js` (a "Beam" group in `LAB_KNOB_GROUPS`), `src/ui/labPresets.js` (`KNOB_RANGES` and the schema comment), `src/ui/lab.js` (`LAB_KNOB_BINDINGS`, `LAB_KNOB_DEFAULTS`)
- Test: `tests/ui/lab.test.js` and `tests/ui/labPanel.test.js` (both build a fake game: add `beamShards: new BeamShards()`, `beamTime: new BeamTime()`, `beamTimeSurge`, `setBeamTimeSurge`), `tests/ui/panelModel.test.js`, `tests/ui/labPresets.test.js`

**Interfaces:**
- Produces four knobs, key (range, step, default): `beamShardsNeeded` ([1, 8], 1, 6, integer), `beamShardWaveInterval` ([1, 60], 1, 1, integer), `beamTimeSeconds` ([1, 30], 0.5, 8), `beamTimeSurge` ([1, 6], 0.25, 3). Bindings read and write: `game.beamShards.needed` / `setNeeded`, `game.beamShards.waveInterval` / `setWaveInterval`, `game.beamTime.durationSeconds` / `setDuration`, `game.beamTimeSurge` / `setBeamTimeSurge`. `LAB_KNOB_DEFAULTS` takes the constants (`BEAM_SHARDS_NEEDED`, `BEAM_SHARD_WAVE_INTERVAL`, `BEAM_TIME_SECONDS`, `DEFAULT_BEAM_TIME_SURGE`). The lab's arm-weapon control is untouched and must still list and arm `beam`.

- [ ] **Step 1: Failing tests:** each knob spec exists in `LAB_KNOBS` with the ranges above; `KNOB_RANGES` accepts them and `decodeMix` rejects a value out of range; a mix without the knobs map applies the defaults (the existing "default for a missing knob" test pattern); `readKnob` and `writeKnob` round trip each; integer knobs round; the arm-weapon select still offers `base, beam, scatter, rail, pulse, sidewinders` and `onArmWeapon('beam', 2)` arms the beam on the real game harness.
- [ ] **Step 2: Run** `node --test tests/ui`. Expected: FAIL.
- [ ] **Step 3: Implement** in the three tables.
- [ ] **Step 4: Run** `node --test tests/ui`. Expected: PASS.
- [ ] **Step 5: Commit** `Add beam shard and beam time lab knobs`.

### Task 13: Browser evidence (after Tasks 7 to 12)

**Files:**
- Create: `tests/browser/beam-time.mjs` (not part of `check:gpu`, like `coop.mjs`); output only under `artifacts/` (ignored by `.gitignore`), never committed.

**Interfaces:**
- Consumes: `launchWebGpuBrowser` (`tests/browser/launch.mjs`), `startServer` (`tests/browser/server.mjs`, torn down through `server.stop()` as `browser-launchers.test.js` requires), `window.__murmuration.game`, `.frame`, `.ready`.

- [ ] **Step 1: Write the script**, modeled on `coop.mjs` (frame waiting by `window.__murmuration.frame`, `screenshot(page, name)` into `ARTIFACTS_DIRECTORY`, `TIMEOUT_MILLISECONDS`, usage line `SMOKE_PORT=5199 node tests/browser/beam-time.mjs`, exit 0 or 1). Pages are launched with `?probe=off&capacity=262144` and muted as the other scripts do. Checks, each an `expect(...)`:
  1. Boot at 1280 by 720, wait `ready`, start a solo run by keyboard (`Enter` on the title, as `coop.mjs` does, or `game.start()`), set `game.beamShardWaveInterval` through `game.beamShards.setWaveInterval(1)` and `game.debugInvulnerable(true)` so the swarm survives the walk.
  2. Natural spawn: wait about 120 frames; `game.pickups.waitingShards >= 1`, and each shard is outside `game.view` (compare to `game.view` fields) and inside `game.worldBounds`.
  3. Screenshot `beam-pointer-1280x720.png` with a shard off screen: the pointer element exists in the DOM (`.beam-shard-pointer-chevron`) with computed `animation-name` `beam-shard-throb` and is visible (opacity above 0); then set `data-reduced-motion` on the root and assert computed `animation-name` is `none` while the width is still 28 px.
  4. Collect all six: for each waiting shard move the player point onto it (`game.player.positionX/Y` as `coop.mjs` moves seats, or hold a synthetic movement key) and wait a few frames; after each, `game.state.beamShards` increments; screenshot `beam-pips-1280x720.png` at 3 of 6.
  5. On the sixth: `game.state.armed === 'beam'`, `game.state.beamTime > 0`, `game.spawnPressure.surge === game.beamTimeSurge`; hold fire (`game.input.state.firing = true` through the page as `coop.mjs` sets inputs, or the keyboard) for 60 frames and assert `latestStats.aliveTotal` after the surge is above the value before beam time by at least 1.5x (the surge) and that `game.projectiles` has a beam (`projectiles.beams` non-null if exposed, else `state.armed` only); screenshot `beam-time-1280x720.png` showing the bar.
  5b. Wait about 8 s of real frames; `armed` returns to its prior weapon, `beamTime === 0`, `beamShards === 0`, `spawnPressure.surge === 1`; screenshot `beam-after-1280x720.png`.
  6. Repeat 3 and 5 at 844 by 390 (`PHONE_VIEWPORT`): screenshots `beam-pointer-844x390.png` and `beam-hud-844x390.png`; assert the pips row and the bar do not overlap the pause button or the weapon text (`getBoundingClientRect` intersections) and no HUD element is `display: none` that was present at 1280 (no pop).
  7. Co-op: `?` pad join as `coop.mjs` section B, collect six with seat 2, both seats armed `beam`.
- [ ] **Step 2: Agent runs it** (the orchestrator decides whether this environment has a GPU adapter; exit 2 style skip as `check:gpu` if none): `SMOKE_PORT=5199 node tests/browser/beam-time.mjs`. Expected: exit 0 and the PNGs under `artifacts/`. Attach counts and the reproduction command to the PR, not the PNGs.
- [ ] **Step 3: Run** `node --test tests/browser/browser-launchers.test.js`. Expected: PASS (the new script tears its server down through `server.stop()`).
- [ ] **Step 4: Commit** `Add the beam time browser check`.

### Task 14: Documentation (last)

**Files:**
- Modify: `AGENTS.md`, `docs/superpowers/specs/2026-11-13-swarm-weapons-design.md`, header comments already updated in earlier tasks

- [ ] **Step 1: Run the docs-update check** and bring drifted text in line:
  - `AGENTS.md` Frame order: step 3 gains shards (collected like pickups; `persistent`, no fade; the completing shard starts beam time) and step 6 gains the shard spawn on waves (`SpawnDirector.waveSequence`, `BeamShards.onWaves`, `placeShard`) and the surge (`SpawnPressure.setSurge`, `surging`, null wave); step 4 notes the beam time override (`WeaponState.beginBeamTime`).
  - `AGENTS.md` Co-op "Pickups" bullet: one rotation of five (scatter, rail, pulse, sidewinders, time warp), no beam; shards shared; beam time to every seat not down; revive joins it. "Down and revive" bullet: a revived seat during beam time gets the beam.
  - `AGENTS.md` Pass order, probe rules (`acceptsProbeFrames` false in beam time), HUD bullet (pips, bar), Commands/tests list (`tests/browser/beam-time.mjs`, not part of `check:gpu`), File map (the new files), `?debug` unaffected.
  - The swarm weapons spec: in 4.2 and 9 record that R1 (the kill meter) was not chosen, the beam is earned by shards and beam time, and that open decision 6 and the two questions of GitHub issue 10 are answered: (1) the beam left the rotation for a rarer trigger (six shards, then 8 s of beam time); (2) ships do not fire base shots under the beam, the single centroid beam stays as is (also beam time keeps rail turrets firing). Correct step 4's "1 in 5 ... check R31" note: the time warp is one slot in five.
  - Remove the plan's own scaffolding is NOT part of this task (the plan and spec are deleted at branch-finish).
- [ ] **Step 2: Run** `npm test` and `npm run coverage`. Expected: green (with `npm ci` done), coverage floors 92 and 86 held (every new source file is covered by its test file).
- [ ] **Step 3: Commit** `Document beam shards and beam time`.

## Review Focus

- A shard placed while the view covers the whole world (two seats at zoom 0.5): `placeShard` falls back to the farthest corner, never `null` or `NaN` (Task 5).
- A director reset or a lower wave sequence than the last seen never spawns a burst of shards (Task 5).
- A weapon pickup, a rail pickup, a time warp pickup and a bomb during beam time leave the beam armed and the right weapon returns (Tasks 4 and 7).
- A seat that is down or revived at the moment beam time starts or ends gets the right weapon, never a stale override (Task 7, co-op).
- A pause, a quit to title, a death and a capacity swap during beam time leave no stuck surge or armed beam (Task 7; the capacity swap keeps `surge` through `SpawnPressure.setCapacity`).
- The surge cannot trip the frame probe into a persisted preset step-down (Task 7 `acceptsProbeFrames`).
- The HUD pips and bar stay present and non-popping at 844 by 390 (Tasks 9 and 13).

## Self-review notes

- Coverage of the rulings: 1 (Task 1), 2 (Tasks 2, 5, 7), 3 (Tasks 3, 4, 6, 7), 4 (Task 10), 5 (the design as a whole). Scope items: shard type and spawn (2, 5, 7), shared count (5, 7), beam time (3, 4, 7), surge (6, 7), HUD (9), pointer (10), pickup look (8), cues (11), lab (12), tests throughout, AGENTS.md and issue 10 (14), browser evidence (13).
- Type consistency: `BeamShards.onWaves`, `collect`, `finish`, `reset`, `needed`, `waveInterval`; `BeamTime.update` returns a boolean; `WeaponState.beginBeamTime(tier)` and `endBeamTime()`; `SpawnPressure.setSurge` and `surge`; `Game.beamTimeSurge`; `PickupDirector.spawnShard` and `waitingShards`; state fields `beamShards`, `beamShardsNeeded`, `beamTime`. All used with these names in later tasks.
- Parallel claims were checked against file lists: no two lanes share a file.
