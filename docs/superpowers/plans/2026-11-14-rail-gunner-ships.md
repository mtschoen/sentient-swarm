# Rail Gunner Ships Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the abstract rear-firing rail turrets with gunner ships: each rail turret is a real ship in the swarm that holds station on a circle around the controlled point at its turret angle, points outward along it and fires its own rail needles from its own position.

**Architecture:** `PlayerSwarm` marks up to `railTurrets` live ships as gunners (nearest ship to each station, passed on when a gunner dies). `flockStep` replaces the roaming-waypoint seek of a gunner with a station seek, `faceStep` sets a gunner's heading to its station angle, and a new `GunnerFire` fires needles per gunner at the rail tier interval. The renderer draws a rail-hue ring around each gunner and drops the old ticks on the controlled point's ring. `WeaponState` keeps only the count and tier of turrets.

**Tech Stack:** Plain JavaScript ES modules, WGSL (`swarm.wgsl`, `ship.wgsl`), `node:test`. No dependencies, no TypeScript.

**Spec:** `docs/superpowers/specs/2026-11-13-swarm-weapons-design.md` (section 3.4 option T2, step 5 of section 6, section 8). Owner said "Yes, build it" on 2026-11-14.

## Global Constraints

- Plain JavaScript ES modules and WGSL. No TypeScript. No runtime dependencies.
- Full-word identifiers (`maximum`, not `max`; `position`, not `pos`), WGSL user identifiers too.
- No em-dashes (U+2014) anywhere, including comments, docs and this plan.
- Every source file under about 500 lines, or a one-line note at the top saying why. `swarm-flocking.js` is 288 lines: keep gunner math in the new `swarm-gunners.js`.
- No hard-coded machine paths. No wall-clock assertions in tests; inject `random`, pass `deltaSeconds`.
- Mobile limits: at most 8 storage buffers per stage (no new buffers; the swarm uniform grows by 1 KB only), no `vec3` in storage layouts, uniform arrays stay 16-byte aligned.
- Neighbor contributions are averaged, never summed (unchanged; gunners keep only separation).
- Rail is turrets only (owner ruling R29): a rail pickup leaves the armed weapon, tier and charge alone. Rail needle values stay as in `WEAPON_TYPES.rail`: interval 0.3 s, speed 40, radius 0.05, lifetime 0.6, 1, 2, 3 parallel needles per tier at `parallelOffset` 0.15.
- Turret count cap `MAXIMUM_RAIL_TURRETS` = 12, spacing `RAIL_TURRET_SPACING_RADIANS` = 30 degrees, offsets from `railTurretOffsets(count)` (centered on the rear of the aim). Past 12 each further pickup raises `railTier`.
- Turrets keep firing under beam time, a down seat drops its turrets (`weapons.dropAll`), death drops every seat's turrets, a revived seat starts with none (all unchanged, now via the count).
- Commit after every task, imperative message, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` unless the executing harness states another line.
- Test commands: `npm test` (whole suite), `node --test tests/game/x.test.js` (single file). Never `node --test <directory>` (fails on this machine).
- Implementers prove every new test by mutation: after green, break the named line of production code, see the named test fail, restore it. Say so in the commit body.

## Design decisions (owner or orchestrator: check these)

1. **Choosing gunners.** For each station index `0..effectiveCount-1` that has no gunner, the live non-gunner ship nearest to that station's world position (ties to the lowest slot) becomes its gunner. A gunner keeps its station index until it dies or the effective count drops below its index, so ships do not swap roles while flying. `effectiveCount = min(railTurrets, aliveShips)`: the turret count drops only when the swarm has fewer ships than turrets.
2. **Stations.** Station k is at `point + (cos, sin)(aimAngle + offset_k) * stationRadius`, with `offset` from `railTurretOffsets(effectiveCount)` and `stationRadius = homeRadiusFor(aliveCount) * GUNNER_STATION_REACH` (0.8: inside the leash circle, outside the bee cloud). The ring rotates with the aim exactly as the abstract turrets did. With no aim yet the last aim angle is used (0 at the start).
3. **Station keeping vs flocking.** A gunner's roaming waypoint is replaced by its station: seek toward the station with weight `GUNNER_SEEK` (1.6, against 0.6 for the waypoint seek), the same arrival braking and `SWARM_ROAM_COMFORT`. A gunner also drops the harmonic well, cohesion, pressure and the attack bias (each pulls toward or around the point and would fight the station), keeps separation and the leash, and scales wander by `GUNNER_WANDER_SCALE` (0.25) and buzz by `GUNNER_BUZZ_SCALE` (0.3) so it hovers instead of jittering off station. A non-gunner steps exactly as today.
4. **Heading and fire.** A gunner's heading is set to its station angle every step (exempt from `faceStep`; no turn limit, as the abstract turrets were instant). It fires needles along that heading from its own position, one volley per rail interval (0.3 s), count by `railTier`, each gunner phased by `slotHash` when fire goes down, cooldowns in intervals carrying their remainder (like `SwarmFire`). A gunner fires while firing is held with a nonzero aim, whatever else is armed (including the beam). It fires even while flying out to a fresh station; accepted for simplicity.
5. **Aggregate rate.** Unchanged from today: every turret fires once per 0.3 s, so 12 gunners give 40, 80, 120 needles per second by tier. The spec's exponent 0.3 applies only if gunners exceeded ships, which `effectiveCount` makes impossible, so no exponent is implemented.
6. **Hit liability.** Gunners are ordinary ships in the contact pass and can be hit. A dead gunner's turret passes to the nearest non-gunner on the next update.
7. **Look.** A gunner keeps its seat body color and gets a thin rail-hue ring around the dart (distinguishable in both seat colors and under beam time; the cockpit still shows the armed hue). The old tick marks on the controlled point's ring are removed. Needs a visual check at 844 by 390 with two seats.
8. **HUD.** The rail readout is unchanged: it shows `weapons.railTurrets` and `railTier` (`RAIL x3`, `RAIL x12 II`), even in the corner case of fewer ships than turrets.
9. **Shipped visible change, no toggle.** This replaces the abstract turrets for everyone. No lab toggle: it would need a new lab knob, mix field and lab panel rows, which collide with the parallel solo camera zoom plan's lab edits and are not cheap.

## Review Focus

Failure modes the spec implies that no feature task would otherwise exercise (each gets a test in the owning task):

1. A swarm with fewer ships than turrets (for example 3 ships, 12 turrets): every ship is a gunner, none crash, stations use the smaller count (Task 1, Task 3).
2. A gunner is killed while the aim swings: the turret passes to a living non-gunner and the count stays (Task 3, Task 8).
3. No aim at the start of a run (zero aim): stations use the last aim angle, nothing is NaN (Task 3).
4. Rail pickup then the seat goes down, dies, quits or is revived: no gunner survives the weapon drop (Task 8).
5. 256 ships with 12 gunners: assignment and steering stay allocation-free and bounded (Task 1, Task 3).

## File Structure and Lanes

| File | Responsibility | Task |
|---|---|---|
| `src/game/swarm-gunners.js` (new) | Station geometry, gunner assignment, gunner steering constants | 1 |
| `src/game/swarm-flocking.js` | Gunner branch of `flockStep` | 2 |
| `src/game/swarm-facing.js` | `faceStep` exempts gunners | 2 |
| `src/game/player-swarm.js` | Gunner slot fields, `setGunnerCount`, station aim, ship entry `gunnerIndex` | 3 |
| `src/game/swarm-shots.js` | `gunnerShotRecipe(railTier)` | 4 |
| `src/game/gunner-fire.js` (new) | `GunnerFire`: needle volleys per gunner | 5 |
| `src/game/swarm-fire.js` | `distribute` uses `GunnerFire` for `turretSpawns` | 6 |
| `src/game/weapons.js` | Drop turret emission, keep count and tier | 7 |
| `src/game/player-seat.js`, `src/game/seats.js` | Sync gunner count, pass `railTier`, cue source | 8 |
| `src/render/swarm.js`, `src/render/shaders/swarm.wgsl` | Gunner ring | 9 |
| `src/render/ship.js`, `src/render/shaders/ship.wgsl`, `tests/browser/pages/render-capture-check.js` | Remove ticks, capture scene gains a gunner | 10 |
| `AGENTS.md`, comments in `game.js`, `weaponTypes.js`, `tests/browser/capture-weapons.mjs` | Docs and capture script | 11 |
| whole repo | Verification | 12 |

**Parallel lanes** (disjoint files; lanes A, B and C can run at the same time in separate worktrees):

- **Lane A (steering):** Tasks 1, 2, 3 in order. Tasks 2 and 3 need Task 1's exports.
- **Lane B (fire):** Tasks 4, 5, 6, 7 in order.
- **Lane C (render):** Tasks 9 and 10 (independent of each other and of A and B; they only read `ship.gunnerIndex` from the contract below).
- **Integration (after A and B merge):** Task 8, then Task 11 (docs, after everything), then Task 12.

**Shared contracts** (all lanes code against these, names are fixed):

- Ship entry from `PlayerSwarm.ships` and `shipsAt`: `{ slot, x, y, previousX, previousY, age, heading, gunnerIndex }`, `gunnerIndex` is `-1` for a normal ship and `0..11` (the station index) for a gunner.
- `PlayerSwarm.setGunnerCount(count: number): void` (the turret count wanted; clamped to the live ships inside the update).
- `SwarmFire.distribute(fire, ships, origin, centroid, { firing, aimX, aimY, deltaSeconds, kind, tier, railTier })` returns `{ spawns, turretSpawns, beam }`; `turretSpawns` come from gunner ships (`gunnerIndex >= 0`); `fire.turretSpawns` is no longer read. `railTier` defaults to 1.
- `weapons.railTurrets` and `weapons.railTier` keep their meaning; `WeaponState.update` returns `{ spawns, beam, expired }` with no `turretSpawns` key (removed in Task 7).

Until Tasks 6, 7 and 8 have all landed the integrated game has no rail fire; merge lane B only together with Task 8. Overlap with the solo camera zoom plan: none in code. The only shared file is `src/game/game.js`, where Task 11 edits header comments only (lines near 23 to 39 and the `debugArm` comment); merge that after the zoom plan's `followCamera` edit or resolve the textual conflict by keeping both.

---

## Phase 1: Lane A, gunner steering

### Task 1: Station geometry and assignment

**Files:**
- Create: `src/game/swarm-gunners.js`
- Test: `tests/game/swarm-gunners.test.js`

**Interfaces:**
- Consumes: `railTurretOffsets(count)` from `src/game/weapons.js` (keep that export as is), `MAXIMUM_RAIL_TURRETS` from `src/game/weaponTypes.js`.
- Produces:
  - `export const GUNNER_STATION_REACH = 0.8; GUNNER_SEEK = 1.6; GUNNER_WANDER_SCALE = 0.25; GUNNER_BUZZ_SCALE = 0.3;`
  - `export function gunnerStations(count, aimAngle, centerX, centerY, radius, out)`: fills `out[0..count-1]` (reused `{ x, y, angle }` entries; the function creates entries only when `out` is shorter) with `angle = aimAngle + railTurretOffsets(count)[index]`, `x = centerX + cos(angle) * radius`, `y = centerY + sin(angle) * radius`. Returns `out`.
  - `export function assignGunners(slots, effectiveCount, stations)`: sets on every slot `gunnerIndex`, `stationX`, `stationY`, `stationAngle` (non-gunners `gunnerIndex = -1`, station fields untouched). Rules: a dead slot or a gunner with `gunnerIndex >= effectiveCount` becomes a non-gunner; each station index `0..effectiveCount-1` with no gunner takes the nearest alive non-gunner by squared distance to `stations[index]` (ties to the lowest slot index); every gunner then copies its station's fields. Allocation-free after the first call (module scratch `Int16Array(MAXIMUM_RAIL_TURRETS)`).

- [ ] **Step 1: Write the failing tests** in `tests/game/swarm-gunners.test.js` (slots here are plain objects `{ alive, x, y, gunnerIndex: -1, stationX: 0, stationY: 0, stationAngle: 0 }`):
  - `gunnerStations puts three stations 30 degrees apart around the rear of the aim at the radius`: aim 0, centre (5, 5), radius 1: angles are `150, 180, 210` degrees, positions are centre plus radius times the unit vector; `out` entries are reused on a second call (same object identity).
  - `assignGunners picks the nearest live ship to each station`: 4 ships in a row, 2 stations, assert slot indices by hand.
  - `assignGunners keeps a gunner on its station index while it lives`: assign, move the ships so another ship is nearer to station 0, assign again, the original gunner still has index 0.
  - `a dead gunner's station passes to the nearest non-gunner`: set `alive = false` on the gunner of index 1, assign: exactly 2 gunners, indices `{0, 1}`, the dead slot has `gunnerIndex === -1`.
  - `fewer ships than turrets makes every ship a gunner` (Review Focus 1): 3 live ships, `effectiveCount = 3`, all `gunnerIndex` in `{0, 1, 2}` and unique.
  - `a lowered effective count demotes the highest indices`: assign 4, then assign 2: only indices 0 and 1 remain.
  - `assignGunners does not allocate`: 256 slots, 12 stations, run it 1000 times; assert the module returns the same `slots` objects and no new properties appear (identity check on `Object.keys` of a slot before and after).
- [ ] **Step 2: Run** `node --test tests/game/swarm-gunners.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `gunnerStations` and `assignGunners` as specified. Header comment of two to four lines naming the decisions (nearest ship, kept index, station geometry).
- [ ] **Step 4: Run** the same command. Expected: PASS. Mutation proof: make the nearest search pick the farthest; the "nearest live ship" test must fail; restore. Make demotion skip dead slots; the dead-gunner test must fail; restore.
- [ ] **Step 5: Commit** `Add rail gunner station geometry and assignment`.

### Task 2: Steering and facing for gunners

**Files:**
- Modify: `src/game/swarm-flocking.js` (the waypoint, well, cohesion, attack, wander and buzz parts of `flockStep`)
- Modify: `src/game/swarm-facing.js` (`faceStep`)
- Test: `tests/game/swarm-gunners-flock.test.js` (new), `tests/game/swarm-facing.test.js` (add)

**Interfaces:**
- Consumes: Task 1 constants; slot fields `gunnerIndex`, `stationX`, `stationY`, `stationAngle` (a slot is a gunner when `gunnerIndex >= 0`).
- Produces: `flockStep` and `faceStep` honor those fields; slots without them (the existing tests build slots through `PlayerSwarm`, whose `deadSlot` is extended in Task 3) behave as before, so read the field as `ship.gunnerIndex >= 0` (`undefined >= 0` is false).

- [ ] **Step 1: Write the failing tests.**
  - In `swarm-gunners-flock.test.js`, helper `gunnerSlot(stationX, stationY)` built from `temperamentFor(0)` plus `{ alive: true, x: 5, y: 5, velocityX: 2, velocityY: 0, course: 0, heading: 0, gunnerIndex: 0, stationX, stationY, stationAngle: 0 }`; context `{ targetX: 5, targetY: 5, firing: false, aimX: 0, aimY: 0, time, aliveCount: 12, bounds: WORLD_BOUNDS, margin: 0.02 }`.
  - `a gunner settles within 0.2 of its station`: station (6, 5), run `flockStep` 240 steps of 1/60 advancing `time`, then assert the mean distance over the last 60 steps is under 0.2.
  - `a gunner holds its station while the attack bias would pull it`: same with `firing: true`, aim (1, 0): still under 0.25 (the attack term is dropped).
  - `the same ship as a non-gunner roams`: `gunnerIndex: -1`, same run, mean distance to (6, 5) stays above 0.2 (guards against the test passing by accident).
  - `a gunner's wander and buzz are scaled`: the standard deviation of its position around the station over 120 steps is under 0.12.
  - In `swarm-facing.test.js`: `a gunner's heading is its station angle, firing or not`: slot with `gunnerIndex: 2, stationAngle: 1.2, course: -2, heading: 0`; `faceStep` once with `firing: true`, aim (1, 0) and once with `firing: false`: heading `=== 1.2` both times. `a non-gunner is unchanged`: existing tests keep passing.
- [ ] **Step 2: Run** `node --test tests/game/swarm-gunners-flock.test.js tests/game/swarm-facing.test.js`. Expected: FAIL (new tests).
- [ ] **Step 3: Implement.** In `flockStep`, `const gunner = ship.gunnerIndex >= 0;` per ship. For a gunner: the seek target is `(ship.stationX, ship.stationY)` instead of the roaming waypoint, weight `GUNNER_SEEK` instead of `SWARM_SEEK`, the rest of the seek expression unchanged; skip the harmonic well, the whole cohesion and pressure block and the attack bias; multiply the wander term by `GUNNER_WANDER_SCALE` and the buzz by `GUNNER_BUZZ_SCALE`; keep the leash, separation and the catch-up. Everything for a non-gunner stays byte for byte; do not allocate. In `faceStep`, a gunner sets `ship.heading = ship.stationAngle` and continues.
- [ ] **Step 4: Run** the same command plus `node --test tests/game/player-swarm.test.js`. Expected: PASS. Mutation proof: replace the station target by the waypoint (the settle test must fail); drop the `GUNNER_BUZZ_SCALE` factor (the deviation test must fail); remove the `faceStep` exemption (the heading test must fail); restore each.
- [ ] **Step 5: Commit** `Steer gunner ships to their stations and point them outward`.

### Task 3: PlayerSwarm owns the gunners

**Files:**
- Modify: `src/game/player-swarm.js`
- Test: `tests/game/player-swarm.test.js` (add)

**Interfaces:**
- Consumes: Task 1 `gunnerStations`, `assignGunners`, `GUNNER_STATION_REACH`; `homeRadiusFor` from `swarm-flocking.js`.
- Produces: `PlayerSwarm.setGunnerCount(count)`; slot fields `gunnerIndex` (-1 default in `deadSlot`), `stationX`, `stationY`, `stationAngle`; `ships` entries carry `gunnerIndex` (add to `shipEntries` and the `ships` getter; `shipsAt` copies it through `blendShips`).

- [ ] **Step 1: Write the failing tests** (deterministic `random` as in the existing file):
  - `gunners are the requested count of live ships`: reset with 12 ships, `setGunnerCount(5)`, one `update`: exactly 5 entries of `ships` have `gunnerIndex >= 0`, indices unique `0..4`.
  - `fewer ships than turrets: every ship is a gunner` (Review Focus 1): reset with 3 ships, `setGunnerCount(12)`, update: 3 gunners, indices unique, no NaN in any `x`, `y`, `heading`.
  - `zero aim keeps the last aim angle and stays finite` (Review Focus 3): update with aim (0, 0) from the start: stations at angle 0 plus offsets; then aim (0, 1) once, then (0, 0): stations rotate to the last nonzero aim, all positions finite.
  - `a killed gunner's turret passes on and the count holds` (Review Focus 2): 12 ships, 3 gunners, update, `applyHits` on a gunner's slot (use the existing mask helper pattern in this file), update again: still 3 gunners, the dead slot is not one, one more ship became a gunner.
  - `gunners hold the station ring while the point is still`: 12 ships, 4 gunners, 5 simulated seconds: each gunner is within 0.3 of its station and all gunners' headings equal their station angles (aim along +x: headings are the 4 offsets of `railTurretOffsets(4)`).
  - `the count dropping to zero returns every ship to normal`: `setGunnerCount(0)`, update: no entry has `gunnerIndex >= 0`.
  - `shipsAt carries gunnerIndex` and extend `update, contactShips and ships reuse their arrays` with gunners present (256 ships, 12 gunners): the arrays stay identical objects (Review Focus 5).
  - `reset clears every gunner`: after `reset`, no slot has `gunnerIndex >= 0` until the next update re-marks them.
- [ ] **Step 2: Run** `node --test tests/game/player-swarm.test.js`. Expected: FAIL (new tests).
- [ ] **Step 3: Implement.** `setGunnerCount` stores `this.gunnerCount` (non-negative integer, clamp to `MAXIMUM_RAIL_TURRETS`). In `update`, before `flockStep`: if `controls` has a nonzero aim set `this.stationAimAngle = atan2(aimY, aimX)` (the angle persists otherwise); `effective = Math.min(this.gunnerCount, this.aliveCountValue)`; `radius = homeRadiusFor(this.aliveCountValue) * GUNNER_STATION_REACH`; `gunnerStations(effective, this.stationAimAngle, targetX, targetY, radius, this.stations)`; `assignGunners(this.slots, effective, this.stations)`. `deadSlot` and `spawnShip` set `gunnerIndex: -1`; the `ships` getter writes `entry.gunnerIndex`. Aim comes only from `controls` (already unit or zero), regardless of `firing`.
- [ ] **Step 4: Run** `node --test tests/game/player-swarm.test.js tests/game/swarm-gunners.test.js tests/game/swarm-facing.test.js`. Expected: PASS. Mutation proof: use `this.gunnerCount` instead of the `min` with alive ships (the fewer-ships test must fail or produce NaN); skip `assignGunners` when a gunner died (the death test must fail); restore.
- [ ] **Step 5: Commit** `Mark rail gunner ships in the player swarm`.

---

## Phase 2: Lane B, gunner fire

### Task 4: Gunner shot recipe

**Files:**
- Modify: `src/game/swarm-shots.js`
- Test: `tests/game/swarm-shots.test.js` (create if absent; check `ls tests/game` first, the file does not exist today)

**Interfaces:**
- Produces: `export function gunnerShotRecipe(railTier)` returning a frozen `{ kind, speed, radius, lifetime, needleCount, parallelOffset, intervalSeconds, extra }` from `WEAPON_TYPES.rail.tiers[railTier - 1]` (tier clamped to 1 to 3). `needleCount` is `projectilesPerShot`, `intervalSeconds` is `fireInterval`.

- [ ] **Step 1: Write the failing test** `gunnerShotRecipe follows the rail tiers`: tier 1, 2, 3 give `needleCount` 1, 2, 3; every tier has `intervalSeconds === 0.3`, `speed === 40`, `radius === 0.05`, `lifetime === 0.6`, `parallelOffset === 0.15`, `kind === PROJECTILE_KINDS.rail`; tier 0 and tier 9 clamp to 1 and 3.
- [ ] **Step 2: Run** `node --test tests/game/swarm-shots.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `gunnerShotRecipe` reading `WEAPON_TYPES.rail` (no copied numbers). Update the file header sentence "nor does rail (turrets only)" to point at `gunnerShotRecipe`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Mutation proof: hard-code `needleCount` to 1; the tier test must fail; restore.
- [ ] **Step 5: Commit** `Add the rail gunner shot recipe`.

### Task 5: GunnerFire

**Files:**
- Create: `src/game/gunner-fire.js`
- Test: `tests/game/gunner-fire.test.js`

**Interfaces:**
- Consumes: `gunnerShotRecipe` (Task 4), `slotHash` from `src/game/swarm-hash.js`, `MAXIMUM_SWARM_SHIPS`.
- Produces: `export class GunnerFire { constructor({ random = Math.random } = {}); reset(); fire(ships, { firing, aimX, aimY, deltaSeconds, railTier }) }` returning an array of spawns `{ x, y, velocityX, velocityY, radius, lifetime, kind, seed, extra }`. Only ships with `gunnerIndex >= 0` fire. Cooldown per slot in intervals (`Float64Array(MAXIMUM_SWARM_SHIPS)`), reduced by `deltaSeconds / intervalSeconds`, a ready gunner fires one volley per update at most and adds 1 to its cooldown (remainder carried, a waiting gunner banks at most one step). On the first update after not firing (or `reset`), each gunner's cooldown starts at `slotHash(slot, 22)` (phase). No fire when `firing` is false or the aim is zero (`reset` the phase flags in that case). Needles: `needleCount` needles centered on the heading axis, offset `(index - (needleCount - 1) / 2) * parallelOffset` perpendicular to the heading, velocity `speed` along the heading, `seed: this.random()`.

- [ ] **Step 1: Write the failing tests** (ships `{ slot, x, y, heading, gunnerIndex }`, seeded random):
  - `a gunner fires needles along its own heading from its own position`: one gunner at (3, 4) heading 1.0, tier 1, run 0.6 s: every spawn has `x === 3`, `y === 4`, velocity `speed * (cos 1.0, sin 1.0)`.
  - `tier sets the needle count with parallel offsets`: tier 3, heading 0: first volley has 3 spawns at `y` offsets `-0.15, 0, 0.15` (perpendicular), same `x`.
  - `a normal ship never fires rail`: ships with `gunnerIndex: -1` give no spawns.
  - `twelve tier 2 gunners fire 80 needles per second`: over 3.0 s at 1/60 steps the total is between `12 * 2 * 9` and `12 * 2 * 11` needles (ten volleys per gunner at the 0.3 s interval, phase moves each gunner by at most one).
  - `gunners are phased, not synchronized`: with 12 gunners, the frames in the first 0.3 s that contain a volley number at least 6.
  - `no fire without firing or with zero aim`: both give no spawns, and the phase restarts afterwards (the first volley after resuming is not instant for a gunner whose phase is above 0: assert `slotHash(slot, 22) > 0.1` gunner first fires after at least `0.1 * 0.3` s).
  - `a huge delta fires one volley per gunner, not a backlog`: `deltaSeconds` 5: exactly one volley per gunner.
- [ ] **Step 2: Run** `node --test tests/game/gunner-fire.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `GunnerFire` as specified, with a header comment (pure, no clock; `random` injected; why one volley per update).
- [ ] **Step 4: Run** the same command. Expected: PASS. Mutation proof: let a normal ship fire (the normal-ship test must fail); remove the `slotHash` phase (the phased test must fail); allow several volleys per update (the huge-delta test must fail); restore.
- [ ] **Step 5: Commit** `Add gunner needle fire`.

### Task 6: SwarmFire distributes gunner fire

**Files:**
- Modify: `src/game/swarm-fire.js` (`distribute`, `reset`, the header comment on turrets)
- Test: `tests/game/swarm-fire.test.js` (replace the test at line 160, update `no ships fire nothing`)

**Interfaces:**
- Consumes: `GunnerFire` (Task 5).
- Produces: `distribute` as in Shared contracts: `turretSpawns = this.gunnerFire.fire(ships, { firing, aimX, aimY, deltaSeconds, railTier })`; `fire.turretSpawns` is ignored; the beam passthrough stays; `reset()` also resets `gunnerFire`. `control.railTier` defaults to 1.

- [ ] **Step 1: Update the tests first.** Replace `turret volleys fire once from one rotating ship, at full size; the beam leaves the centroid` with `gunners fire the turret needles from their own positions; the beam still leaves the centroid`: three ships, two with `gunnerIndex: 0, 1` and headings 0 and pi, one normal; control `firing: true`, `railTier: 2`, kind `base`: after 0.6 s every turret spawn comes from one of the two gunner positions with velocity along that gunner's heading, none from the normal ship; passing `fire.turretSpawns: [turret]` in the input changes nothing; the beam is `[centroid.x, centroid.y, halfWidth]`. Add `a gunner fires under a pooled beam and a pulse` (kind `beam` tier 1, then `pulse`): turret spawns still appear. Update `no ships fire nothing`'s expected value (shape unchanged: `{ spawns: [], turretSpawns: [], beam: null }`) and make `shipsHeading` add `gunnerIndex: -1` so the existing tests use real entries.
- [ ] **Step 2: Run** `node --test tests/game/swarm-fire.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `distribute`, replace the turret rotation block; construct `GunnerFire` in the constructor with the same `random`. `this.rotation` stays for `fireShips`. Update the header bullet "Rail turrets: ..." to describe gunners.
- [ ] **Step 4: Run** `node --test tests/game/swarm-fire.test.js tests/game/gunner-fire.test.js`. Expected: PASS. Mutation proof: read `fire.turretSpawns` again (the "changes nothing" assertion must fail); skip `gunnerFire.reset()` in `reset` (add one assertion that after `reset` the first volley is phased again, and see it fail); restore.
- [ ] **Step 5: Commit** `Fire the rail turrets from the gunner ships`.

### Task 7: WeaponState keeps only the turret count and tier

**Files:**
- Modify: `src/game/weapons.js` (remove `fireTurrets`, `railAccumulator`, `turretSpawns` from the update result; keep `railTurretOffsets`, `collect`, `railTurrets`, `railTier`, `dropAll`)
- Modify: `src/game/weaponTypes.js` (comment at lines 37 to 40 only)
- Test: `tests/game/weapons.test.js`

**Interfaces:**
- Produces: `WeaponState.update` returns `{ spawns, beam, expired }`. Callers that read `.turretSpawns` from it are fixed in Task 8 (`seats.js`); `SwarmFire` no longer reads it (Task 6).

- [ ] **Step 1: Update tests first.** Delete `turrets fire rail shots at the rail interval while firing and not while idle` and the accumulator test `swapping weapons mid-fire leaves the turrets accumulator alone`. Add `update no longer returns turret spawns` (collect 12 rails, update 1 s firing: `'turretSpawns' in result` is false). Keep the offsets, cap, tier and `collect` tests untouched.
- [ ] **Step 2: Run** `node --test tests/game/weapons.test.js`. Expected: FAIL (the new test).
- [ ] **Step 3: Implement** the removals; update the class comment that says turrets "fire rail shots alongside it on their own accumulator".
- [ ] **Step 4: Run** `node --test tests/game/weapons.test.js`. Expected: PASS. Mutation proof: return `turretSpawns: []` from `update`; the new test must fail; restore.
- [ ] **Step 5: Commit** `Remove abstract turret fire from WeaponState`.

---

## Phase 3: Lane C, rendering

### Task 9: Gunner ring in the swarm renderer

**Files:**
- Modify: `src/render/swarm.js`, `src/render/shaders/swarm.wgsl`
- Test: `tests/render/swarm.test.js` (add)

**Interfaces:**
- Consumes: ship entries with `gunnerIndex` (Shared contracts), `WEAPON_HUES.rail`.
- Produces: the uniform grows by a `gunnerMarks: array<vec4f, MAXIMUM_SWARM_SHIPS / 4>` after the ships array (one float per ship, 1 for a gunner, 0 otherwise, packed four to a `vec4f`: ship `i` is component `i % 4` of element `i / 4`), so `SWARM_VIEW_BYTES = 80 + 256 * 16 + 256 * 4`. Header float 7 (the old padding after `shipSize`) becomes `railHue = WEAPON_HUES.rail`.

- [ ] **Step 1: Write the failing tests.**
  - Update `packSwarmView writes a white body by default ...`: `SWARM_VIEW_BYTES === 80 + 256 * 16 + 256 * 4`.
  - `packSwarmView marks gunner ships`: ships `[{ gunnerIndex: -1 }, { gunnerIndex: 3 }, { gunnerIndex: 0 }]` (with x, y, age, heading): marks floats at `WORLD_VIEW_FLOATS + 12 + 256 * 4 + index` are `0, 1, 1`; a ship entry without `gunnerIndex` (older callers) is `0`.
  - `packSwarmView marks are rewritten each call`: pack gunners, then pack the same buffer with no gunners: marks back to 0.
  - `packSwarmView carries the rail hue`: float `WORLD_VIEW_FLOATS + 7 === Math.fround(WEAPON_HUES.rail)`.
- [ ] **Step 2: Run** `node --test tests/render/swarm.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `swarm.js`: `VIEW_FLOATS` grows by `MAXIMUM_SWARM_SHIPS`; write the rail hue and the marks. In `swarm.wgsl`: add `railHue` (rename `padding`) and `gunnerMarks` to `SwarmView`, update the layout comment, pass the mark to the fragment as a flat varying, and in the ship branch of `swarmFragment` add a ring: `ringDistance = abs(length(input.offset) - GUNNER_RING_RADIUS * view.shipSize)` with `GUNNER_RING_RADIUS = 0.14` (the dart's nose is 0.12 times shipSize, the quad half extent 0.16), thin like the marker ring, color `hsvToRgb(view.railHue, 0.8, 1.0) * 1.2 * ring * gunnerMark`, added to the existing color. The body color is untouched so both seat colors read. Update the header comment of `swarm.wgsl`.
- [ ] **Step 4: Run** `node --test tests/render/swarm.test.js tests/render/render-shaders.test.js`, then `npm run check:gpu` (exit 2 means no adapter; with `WEBGPU_ADAPTER=fallback` it must pass: it compiles the swarm shader). Expected: PASS. Mutation proof: write `0` for every mark (the marks test must fail); restore.
- [ ] **Step 5: Commit** `Draw a rail-hue ring on gunner ships`.

### Task 10: Remove the turret ticks from the controlled point's ring

**Files:**
- Modify: `src/render/ship.js`, `src/render/shaders/ship.wgsl`, `tests/browser/pages/render-capture-check.js`
- Test: `tests/render/ship.test.js`

**Interfaces:**
- Produces: `packShipView` and `ShipRenderer.encode` no longer accept `railTurrets`; `SHIP_SHADER_CONSTANTS` loses the rail entries; `SHIP_VIEW_BYTES` stays 80 (the four turret floats become padding so the uniform layout and size do not change).

- [ ] **Step 1: Update the tests first.** In `tests/render/ship.test.js` delete `packShipView packs the turret count ...` and `ship.wgsl takes the turret spacing, cap and rail hue ...`; add `ship.wgsl has no turret constants left` (the source has no `__RAIL_` placeholder and `SHIP_SHADER_CONSTANTS` has no `RAIL_` key) and keep `SHIP_VIEW_BYTES === 80`.
- [ ] **Step 2: Run** `node --test tests/render/ship.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Remove the tick loop, `turretCount` fields (replace by one `viewPadding: vec4f`), `RAIL_*` constants and the tick constants in `ship.wgsl`; remove `railTurrets` from `ship.js` and its constants import. In `render-capture-check.js` remove `railTurrets: 3` from the ship and give the capture scene's swarm entries a few ships with `gunnerIndex` 0 to 2 so the ring shows (the page already builds `swarm` ships, extend that literal).
- [ ] **Step 4: Run** `node --test tests/render/ship.test.js tests/render/render-capture.test.js`, then `npm run check:gpu` (with `WEBGPU_ADAPTER=fallback` if needed). Expected: PASS. Mutation proof: put the tick loop back (the no-`RAIL_`-constants test must fail); restore.
- [ ] **Step 5: Commit** `Remove the rail turret ticks from the ship ring`.

---

## Phase 4: Integration

### Task 8: Seat wiring and game tests (after Lanes A and B merge)

**Files:**
- Modify: `src/game/player-seat.js` (`flock`, `fire`), `src/game/seats.js` (`fireSeats` cue)
- Test: `tests/game/player-seat.test.js`, `tests/game/game.test.js` (lines 1019 to 1060 and neighbours), `tests/game/seats.test.js`, `tests/game/coop.test.js`, `tests/game/coop-beam-time.test.js`

**Interfaces:**
- Consumes: `PlayerSwarm.setGunnerCount`, `SwarmFire.distribute` `railTier`.
- Produces: `PlayerSeat.flock` calls `this.swarm.setGunnerCount(this.weapons.railTurrets)` before `swarm.update` (so `dropAll`, a down seat, death, quit and revive clear gunners with no extra code); `PlayerSeat.fire` passes `railTier` into `distribute`'s control; `fireSeats` plays the `'rail'` cue when `shots.turretSpawns.length > 0` and nothing else cued (replacing `fire.turretSpawns.length`).

- [ ] **Step 1: Write the failing tests** (use `tests/game/game-harness.js` helpers like the existing ones):
  - Rewrite `turret shots are queued with the weapon shots, and a turret-only frame plays the rail cue at the turret tier`: `debugArm('rail', 13)`, firing aim +x for 1.2 s: rail spawns number between `3 * 12 * 2` and `5 * 12 * 2`; the needle directions, rounded to degrees, are exactly the 12 offsets of `railTurretOffsets(12)` in degrees; at most one cue per frame; `'fire rail 2'` is played; beam time still produces turret spawns (`game.weapons.collect('beam')` replaced by `beginBeamTime` as the neighbouring beam test does: gunners keep firing).
  - `rail gunners are ships of the swarm`: `debugArm('rail', 3)`, update a few steps: exactly 3 entries of `game.seats[0].swarm.ships` have `gunnerIndex >= 0` and `game.state.railTurrets === 3` (HUD unchanged).
  - `a gunner that is hit passes its turret on` (Review Focus 2/4): script the hit mask for a gunner's slot through the harness's swarm hit helper (see how the existing swarm hit tests in this file feed `swarmHitMask`), update: still 3 gunners, `game.state.railTurrets === 3`.
  - `quit to title, death and a down seat leave no gunners` (Review Focus 4): after each, one update and no ship has `gunnerIndex >= 0`; reuse the existing quit, death and `seatGoesDown` scenarios in `game.test.js`, `coop.test.js`.
  - `two seats keep their own gunners`: in `coop.test.js`, seat 1 with 4 turrets, seat 2 with 2: each swarm has its own gunner count; spawns from seat 2's gunners originate at seat 2's ships.
  - `player-seat.test.js`: `flock syncs the gunner count from the weapons`.
  - Adjust any test that read `fire.turretSpawns` from `WeaponState` (`seats.test.js` if it does).
- [ ] **Step 2: Run** `node --test tests/game/game.test.js tests/game/player-seat.test.js tests/game/seats.test.js tests/game/coop.test.js tests/game/coop-beam-time.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the three small edits described under Produces.
- [ ] **Step 4: Run** the same command, then `npm test`. Expected: PASS. Mutation proof: remove the `setGunnerCount` call (the gunners-are-ships test must fail); pass no `railTier` (the tier-2 needle count assertion must fail); restore.
- [ ] **Step 5: Commit** `Wire rail gunners into the seat update and fire`.

### Task 11: Docs and the capture script (after Task 8)

**Files:**
- Modify: `AGENTS.md`, `src/game/game.js` (header comment only), `src/game/weaponTypes.js` (comment only, if Task 7 left it stale), `tests/browser/capture-weapons.mjs` (comments and the `turrets` subject description)
- Run the `docs-update` skill over README, AGENTS.md, other docs and inline comments.

- [ ] **Step 1: Edit `AGENTS.md`:** in "Player swarm" replace the sentence about turrets firing "from one ship per volley, full size" with gunners (the paragraph beginning "Contact" and the one beginning "The player is a swarm" mention it); in "Pass order" and "Frame order" step 3 (rail pickup text: "a rail pickup adds a rear-firing turret ... 30 degrees apart around the rear of the aim") say the turrets are gunner ships; step 4 (`turretSpawns`, "beside any weapon including the beam") say they come from `SwarmFire.distribute` via `GunnerFire`; "Co-op" down and revive bullet (drops weapons and turrets) says the gunner marks clear with the count; file map: add `swarm-gunners.js` and `gunner-fire.js`, change `weapons.js` ("rail turrets and `railTurretOffsets`" becomes count, tier and offsets), `swarm-fire.js` and `src/render/ship.js` ("ship, charge ring and rail turret ticks" becomes "ship and charge ring") and `swarm.js` (gunner ring); add the new constants (`GUNNER_STATION_REACH`, `GUNNER_SEEK`, `GUNNER_WANDER_SCALE`, `GUNNER_BUZZ_SCALE`) once. Keep the file under the 12,000 character cap rule for global files only; this file is project scoped, just stay concise.
- [ ] **Step 2:** Update the `game.js` header comment (lines about the rail pickup and `turretSpawns`) and the `debugArm` comment ("turrets" stays true: count of gunners). Update the `capture-weapons.mjs` header lines 2 to 5 and the `turrets` subject comment ("the turret ticks on the ship's ring" becomes "the gunner ships' rings around the swarm").
- [ ] **Step 3: Verify the docs:** `grep -rn "turret tick\|rear-firing\|one ship per volley\|from one ship in rotation" AGENTS.md src tests` returns nothing stale; `grep -c $'\xe2\x80\x94' AGENTS.md docs/superpowers/plans/2026-11-14-rail-gunner-ships.md src/game/swarm-gunners.js src/game/gunner-fire.js` prints zero for each (no em-dashes).
- [ ] **Step 4: Commit** `Document rail gunner ships`.

### Task 12: Verification

- [ ] **Step 1:** `npm test` (whole suite), then `npm run coverage` (floors 92 and 86; the new modules are pure and covered).
- [ ] **Step 2:** `npm run build`, `npm run check:gpu` (`WEBGPU_ADAPTER=fallback` for the software adapter; exit 2 means no adapter, then say so and say what was not run).
- [ ] **Step 3:** Browser checks that touch turrets or the swarm: `node tests/browser/player.mjs`, `node tests/browser/coop.mjs`, `node tests/browser/beam-time.mjs` (HUD rows, seat colors, beam pointers unaffected), and `SMOKE_PORT=5189 node tests/browser/capture-weapons.mjs after turrets` with `TURRET_COUNT=12`; open `artifacts/r29-turrets.png` and confirm: a ring of 12 outward-pointing darts each with a rail-hue ring, needles leaving radially, seat color still reading. Repeat once with two seats (co-op script or `debugArm` on seat 2) and at 844 by 390. State exactly which of these ran and which hit a missing adapter. The attended play check by the owner stays the last stage.
- [ ] **Step 4:** Play-feel items to report, not to tune silently: station ring density at 12 gunners (`GUNNER_STATION_REACH`), whether the ring whips too fast when the mouse swings the aim, and gunners firing while flying out to a fresh station.

---

## Self-Review

- Spec 3.4 T2: gunner flag and tick ring (Tasks 3, 9), station on the leash circle at the turret angle (Tasks 1 to 3), heading overridden outward and exempt from `faceStep` (Task 2), one needle volley per rail interval from its own position (Tasks 4 to 6), real ships that can be hit (unchanged contact pass; Task 8 test), turret passes on (Tasks 1, 3, 8), retire turret rotation emission in `distribute` (Task 6). Step 5 module list (`player-swarm.js`, `swarm-flocking.js`, `swarm-facing.js`, renderer) matches. AGENTS.md and browser checks: Tasks 10 to 12.
- Names used across tasks: `gunnerIndex`, `setGunnerCount`, `gunnerStations`, `assignGunners`, `gunnerShotRecipe`, `GunnerFire`, `railTier` (control field), `GUNNER_*` constants are defined once (Task 1, Task 4) and referenced by the same names.
- Interface seams for parallel lanes are fixed in "Shared contracts": lane B and lane C tests build ship entries by hand and never import lane A.
