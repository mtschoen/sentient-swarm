# Plan B: Play Loop and Weapons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Plan A swarm demo into a playable run: a one-hit-kill player ship, GPU projectiles that kill agents through the spatial grid, five weapon upgrade types with three tiers and a draining charge, typed pickups with the no-landmine swap rule and a recovery guard, smart bombs, lives, a capacity-normalized score with a kill-streak multiplier, death that clears the arena, a HUD in the letterbox bands, and shockwaves in the warp grid. No audio, menus, probe, presets or lab mode yet; those are Plan C.

**Architecture:** Game state (score, lives, bombs, weapon, pickups, run phase) lives on the CPU in small pure modules tested with node:test. The GPU owns everything numerous: agents, projectiles, collisions, particles, the coarse field. Each frame the CPU turns input and weapon state into projectile spawn requests and a few uniform values; the GPU runs the Plan A simulation plus projectile step and collide passes, a player-contact pass with a hit latch, and a kill-all pass when a bomb or death demands it; the stats readback (one or more frames late, sequence-numbered) feeds kills and hits back into the CPU state. The renderer gains the ship with its charge ring, projectiles, pickups, and impulse shockwaves in the warp grid.

**Tech Stack:** As Plan A: WebGPU (WGSL), JavaScript ES modules, Vite, node:test, Playwright smoke. HUD is DOM in the letterbox bands.

**Spec:** `docs/superpowers/specs/2026-11-06-murmuration-design.md`

## Global Constraints

- Everything in Plan A's Global Constraints still binds: plain JavaScript ES modules and WGSL, no TypeScript, no runtime dependencies, shaders via `fetch(new URL(...))`, full-word identifiers, no em-dashes, files under about 500 lines, no hard-coded machine paths, no wall-clock assertions in tests (inject time or step with `deltaSeconds`), at most 8 storage buffers per shader stage, 16-byte aligned storage structs with no `vec3`, workgroup size at most 256, workgroup memory at most 16 KB.
- One hit kills any agent. One touch kills the player. Nothing has health.
- Agents die only to projectiles, beams, pulse rings, bombs, player contact, and the death clear. Species never kill each other.
- Kill counting is exact: an agent's alive bit is cleared with `atomicAnd` and counted only when the old value was alive.
- Event ordering within a frame: input (bomb) first, then pickups collected, then projectile kills, then player contact, then charge expiry; a pickup collected in the frame of expiry wins.
- Every GPU event carries `frameSequence`; the CPU ignores hit events whose sequence predates the current respawn; a GPU latch blocks a second hit until acknowledged.
- `REFERENCE_CAPACITY = 262144`. Points per kill are `10 * REFERENCE_CAPACITY / capacity`. Multiplier steps are `[1, 2, 3, 4, 5, 6, 8, 10]` at kill-streak thresholds `[0, 50, 150, 400, 1000, 2500, 6000, 15000]` scaled by `capacity / REFERENCE_CAPACITY`. Bomb kills and death-clear kills score nothing.
- Lives start at 3, bombs at 3. Extra life at scores `75000 * 2^n` (n from 0). Extra bomb at `40000 * 2.5^n`.
- Weapon upgrades: five types `beam, scatter, rail, pulse, sidewinders`, tiers 1 to 3. Same-type pickup: tier plus one (cap 3) and refill. Different type: tier becomes `max(1, tier - 1)` and refill. Charge drains only while firing. Expiry returns to the base gun. Death drops everything. Untouched pickups fade after 10 seconds. The arena offers one pickup type at a time, rotating every 20 seconds. A pickup is guaranteed within 10 seconds of being on the base gun during play.
- Commit after every task; messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A hit reported late by the GPU, after the player has already respawned, must not take a second life. Pinned in Task B3 (browser) and Task B1 (unit).
2. Two projectiles crossing the same agent in one frame must count one kill and spawn one splash. Pinned in Task B2.
3. A pickup collected in the same frame the charge hits zero must leave the player armed. Pinned in Task B4.
4. Holding the beam into a wall-pinned mass for a long time must not stall the frame: the beam collide walk is bounded by cell count along the segment. Pinned in Task B2.
5. Game over and restart must reset score, multiplier, lives, bombs, weapon, pickups, spawn pressure and clear the arena, with no stale events from the previous run. Pinned in Task B6.

---

## Phase 3: Play loop

### Task B1: Score, multiplier, and run state

**Files:**
- Create: `src/game/score.js`, `src/game/run.js`, `tests/game/score.test.js`, `tests/game/run.test.js`

**Interfaces:**
- `score.js`: `REFERENCE_CAPACITY`, `MULTIPLIER_STEPS`, `STREAK_THRESHOLDS`; `class ScoreKeeper { constructor({ capacity }); recordKills(count) ; recordHit() ; reset() ; get score ; get multiplier ; get streak ; get pointsPerKill ; get nextMultiplierAt ; consumeMilestone() -> boolean }` where `recordKills` adds `count * pointsPerKill * multiplier` to `score`, advances `streak`, steps `multiplier` when the streak crosses a scaled threshold and sets a milestone flag that `consumeMilestone` returns once; `recordHit` zeroes streak and multiplier. `nextLifeThreshold(index) -> 75000 * 2 ** index`, `nextBombThreshold(index) -> 40000 * 2.5 ** index`; `class Awards { constructor(); update(score) -> { lives: number, bombs: number } }` returning how many of each were newly earned since the last call.
- `run.js`: `RunPhase = { Ready, Playing, Dying, Respawning, GameOver }` (string values in camelCase); `class RunState { constructor({ lives = 3, bombs = 3, dyingSeconds = 0.8, respawnSeconds = 0.6, invulnerableSeconds = 2 }); start() ; update(deltaSeconds) -> Array<Action> ; playerHit(frameSequence) -> boolean ; useBomb() -> boolean ; addLife() ; addBomb() ; get phase ; get lives ; get bombs ; get invulnerable ; get respawnSequence }`. Actions are `{ type: 'clearArena' }`, `{ type: 'shockwave', x, y, strength }`, `{ type: 'respawn' }`, `{ type: 'gameOver' }`, `{ type: 'bomb' }`. `playerHit` returns false and does nothing when `phase !== Playing`, when `invulnerable`, or when `frameSequence < respawnSequence`; otherwise it decrements lives, enters Dying, and queues `clearArena` and `shockwave`. `update` moves Dying to Respawning to Playing (with invulnerability) or to GameOver when lives are 0. `useBomb` returns false when bombs are 0 or phase is not Playing; otherwise decrements and queues `bomb` and `shockwave`. `setRespawnSequence(frameSequence)` is called by the game when it respawns so stale hits are rejected.

- [ ] **Step 1: Write failing tests:** points per kill at capacity 262144 is 10 and at 1048576 is 2.5; 50 kills at reference capacity step the multiplier to 2 and set a milestone that `consumeMilestone` returns true once then false; at capacity 524288 the second step needs 300 kills; `recordHit` resets multiplier to 1 and streak to 0 but keeps score; `Awards.update(76000)` returns one life and one bomb (40000 crossed too), `update(100000)` returns zero lives and one bomb (100000 is the second bomb threshold); `RunState`: `playerHit` in Ready returns false; in Playing decrements lives and emits `clearArena` then `shockwave`; after `update` totaling 1.4 s the phase is Playing and `invulnerable` is true, and after 2 more seconds false; a hit with `frameSequence` below `respawnSequence` returns false; three hits end in GameOver with a `gameOver` action; `useBomb` with 0 bombs returns false.
- [ ] **Step 2: Run `npm test`; expect FAIL.**
- [ ] **Step 3: Implement both modules.**
- [ ] **Step 4: Run `npm test`; expect PASS.**
- [ ] **Step 5: Commit** `Add score keeping, awards, and run state machine`.

### Task B2: GPU projectiles and collision

**Files:**
- Create: `src/game/projectiles.js`, `src/sim/shaders/projectiles_step.wgsl`, `src/sim/shaders/projectiles_collide.wgsl`, `tests/browser/projectiles.mjs`, `tests/browser/pages/projectiles.html`
- Modify: `src/sim/shaders/common.wgsl` (add `Projectile` struct and kind constants), `src/sim/simulation.js` (expose a hook to encode extra passes between integrate and stats, and a `killsThisFrame` contribution from this pass)

**Interfaces:**
- `Projectile` struct, 48 bytes: `position: vec2f, previousPosition: vec2f, velocity: vec2f, radius: f32, lifetime: f32, kind: u32, flags: u32, seed: f32, extra: f32`. Kinds: `0 bullet, 1 scatter, 2 rail, 3 pulseOrb, 4 pulseRing, 5 sidewinder, 6 beam`. `flags` bit 0 alive. `extra` is ring growth speed for `pulseRing` and detonation density threshold for `pulseOrb`.
- `class Projectiles { static async create(gpu, { capacity = 8192, common }); queueSpawn({ x, y, velocityX, velocityY, radius, lifetime, kind, seed = 0, extra = 0 }) ; setBeam({ x, y, directionX, directionY, halfWidth } | null) ; encode(encoder, { agentsBuffer, gridBuffers, fieldBuffers, particlePool, statsBuffer, paramsBuffer }) ; get buffer ; get capacity }`. Slots are assigned by the CPU round-robin (`cursor = (cursor + 1) % capacity`, slot 0 reserved for the beam); queued spawns are written with one `queue.writeBuffer` per frame into their slots; the GPU clears the alive bit when lifetime expires or the projectile leaves the arena.
- `projectiles_step.wgsl`: `previousPosition = position; position += velocity * dt; lifetime -= dt`. Sidewinders steer toward the gradient of total species density read from the blurred coarse field, turning at most `extra` radians per second. A `pulseOrb` whose lifetime expires, or whose coarse cell total density exceeds `extra`, becomes a `pulseRing` with `radius = 0.05`, `lifetime = 0.5`, `extra = 6` (ring growth in world units per second) and zero velocity; a `pulseRing` grows `radius += extra * dt`. The beam slot is rewritten by the CPU every frame while firing and cleared otherwise.
- `projectiles_collide.wgsl`: one thread per alive projectile. For kinds 0 to 3 and 5: walk the grid cells intersecting the capsule from `previousPosition` to `position` with radius `radius` (DDA over at most 64 cells), and for every alive, non-spawning agent in those cells whose distance to the segment is at most `radius + 0.02`, kill it. For `pulseRing`: visit the cells within `radius` of `position` (bounded by 32 by 32 cells) and kill agents whose distance to `position` is within `[radius - 0.08, radius]`. For `beam`: walk cells along the ray from `position` in `velocity` direction until the arena edge (at most `columns + rows` cells) and kill agents within `radius` of the ray. Kill means `atomicAnd` the alive bit, and if it was alive: increment the workgroup kill count, claim 4 particles from the pool colored by species, and `atomicAdd` one threat unit (256) into `threatAccumulator` at the agent's coarse cell; the beam additionally adds 4 threat units per cell it walks so the trench shows even where nothing dies.
- Storage buffers in the collide pass: projectiles, agents (atomic flags view), cellCounts, cellOffsets, sortedIndices, particles, particleCursor, threatAccumulator = 8. The stats contribution goes through the same `statsBuffer` binding as Plan A's kill pass; if that makes 9, fold `particleCursor` into the first 16 bytes of the particles buffer (ruling for the implementer: do this fold, and update `ParticlePool` accordingly).

- [ ] **Step 1: Write `tests/browser/projectiles.mjs`:** seed 10000 Chasers in a 2 by 2 block at arena center; (a) spawn one `rail` projectile of radius 0.05 crossing the block at speed 20 for 0.3 s: assert kills between 200 and 2000 and the surviving agents form a visible gap (no alive agent within 0.05 of the path line); (b) spawn two overlapping `bullet` projectiles on the same path in the same frame: assert kills equal the single-projectile count within 2 percent (no double counting); (c) set a beam through the block for 1 frame: assert kills > 0 and the frame's submit completes (device not lost) with the block pinned against the right wall by placing it at x = 15.5; (d) a `pulseOrb` fired into the block converts to a ring and kills agents in an annulus: alive agents remain inside radius 0.3 after 0.1 s but a ring of kills exists beyond.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** Add to `Simulation` a `registerPass(encodeFunction)` hook called after integrate and before stats so `Projectiles.encode` can run with the frame's grid.
- [ ] **Step 4: Run `node tests/browser/projectiles.mjs`; expect pass. Run `npm run smoke`; expect ok.**
- [ ] **Step 5: Commit** `Add GPU projectiles with grid-walking collision`.

### Task B3: Player entity, contact, latch, and kill-all

**Files:**
- Create: `src/game/player.js`, `src/sim/shaders/player_collide.wgsl`, `src/sim/shaders/kill_all.wgsl`, `tests/game/player.test.js`, `tests/browser/player.mjs`, `tests/browser/pages/player.html`
- Modify: `src/sim/simulation.js`, `src/sim/shaders/common.wgsl` (params gain `playerRadius`, `playerInvulnerable`, `acknowledgedHitSequence`, `killAllRequested`), stats buffer gains `playerHitSequence` and `hitLatch`

**Interfaces:**
- `player.js` (CPU, pure): `class PlayerShip { constructor({ speed = 6, radius = 0.12, arenaWidth, arenaHeight }); update(deltaSeconds, inputState) ; respawn() ; get position ; get aim ; get facing }` moving by `inputState.move * speed * deltaSeconds` clamped inside the arena by `radius`; `aim` is the input aim vector when its length exceeds 0.2, otherwise the last aim; `facing` is the angle of `aim`.
- `player_collide.wgsl`: one workgroup of 256 threads reads the 3 by 3 cells around the player; any alive agent not in spawn-in within `playerRadius + 0.02` of the player while `playerInvulnerable == 0` and `hitLatch == 0` sets `playerHitSequence = frameSequence` and `hitLatch = 1` (atomicMax on the sequence, atomicOr on the latch) and kills that agent. The latch clears in the same pass when `acknowledgedHitSequence >= playerHitSequence`.
- `kill_all.wgsl`: one thread per agent: clear alive, spawn particles for every eighth slot (bounds the flood), add one threat unit per 64 kills per coarse cell. Kills from this pass go to a separate `killsUnscored` stat so they never score.
- `Simulation` gains `setPlayerState({ x, y, radius, invulnerable })`, `acknowledgeHit(frameSequence)`, `requestKillAll()` (one frame), and `readStats()` returns `{ ..., playerHitSequence, killsUnscored }`.

- [ ] **Step 1: Write failing unit tests** for `PlayerShip`: moving right for 1 s at speed 6 from the center reaches x = 14; clamped at `16 - radius`; aim holds the last direction when the stick is released.
- [ ] **Step 2: Write `tests/browser/player.mjs`:** seed 5000 Chasers at distance 3 from the player at center, run until `playerHitSequence > 0` (within 10 seconds of sim time); assert the agent count dropped by at least 1 and that a second hit is not reported until `acknowledgeHit` is called and 3 more frames run; then set invulnerable and assert no hit is reported for 60 frames while agents overlap the player; then `requestKillAll` and assert `aliveTotal == 0` and `killsUnscored > 0` and `killsThisFrame == 0`.
- [ ] **Step 3: Run; expect FAIL.**
- [ ] **Step 4: Implement. Run both checks; expect pass.**
- [ ] **Step 5: Commit** `Add player contact with hit latch and kill-all pass`.

### Task B4: Weapon definitions and fire control

**Files:**
- Create: `src/game/weaponTypes.js`, `src/game/weapons.js`, `tests/game/weapons.test.js`

**Interfaces:**
- `weaponTypes.js`: `WEAPON_TYPE_NAMES = ['beam', 'scatter', 'rail', 'pulse', 'sidewinders']`; `WEAPON_TYPES` keyed by name plus `base`, each `{ kind, tiers: [tier1, tier2, tier3] }` where a tier is `{ fireInterval, projectilesPerShot, spreadRadians, speed, radius, lifetime, chargeSeconds, extra, parallelOffset }`. Values are yours, within these shapes: `base` fires 3 bullets at 0.12 s with 0.25 rad spread, speed 14, radius 0.04, lifetime 1.2; `beam` is continuous (`fireInterval = 0`) with `radius` (half width) 0.12, 0.2, 0.3 by tier and `chargeSeconds` 8; `scatter` fires 9, 13, 17 projectiles at 0.2 s over 1.2 rad with lifetime 0.35; `rail` fires 1, 2, 3 parallel bolts (`parallelOffset` 0.15) at speed 40, lifetime 0.6; `pulse` fires 1, 2, 3 orbs at speed 6, lifetime 1.0, `extra` (detonation density) 40; `sidewinders` fires 2, 4, 6 missiles at 0.25 s, speed 9, lifetime 2.5, `extra` (turn rate) 5. Every upgrade type has `chargeSeconds` between 6 and 10.
- `weapons.js`: `class WeaponState { constructor({ types = WEAPON_TYPES, random = Math.random }); get armed ; get tier ; get charge ; get isBase ; collect(typeName) -> { swapped: boolean, tier } ; dropAll() ; update(deltaSeconds, { firing, aimX, aimY, x, y }) -> { spawns: Array<SpawnRequest>, beam: BeamRequest | null, expired: boolean } }` where `SpawnRequest` matches `Projectiles.queueSpawn` and `BeamRequest` matches `setBeam`. `update` applies the fire interval with an accumulator so fire rate is independent of frame rate, drains `charge` by `deltaSeconds / chargeSeconds` only while firing, and when charge reaches 0 sets `armed = 'base'`, `tier = 1`, `charge = 0`, and returns `expired: true` once. `collect` implements the same-type and different-type rules from the Global Constraints.

- [ ] **Step 1: Write failing tests:** base gun at 1 s of firing at 0.12 s interval yields 8 shots of 3 projectiles; `collect('rail')` from base arms rail tier 1 with charge 1; `collect('rail')` again gives tier 2; `collect('beam')` at rail tier 3 gives beam tier 2 and charge 1; `collect('beam')` at beam tier 3 stays tier 3 and refills; charge drains only while firing (1 s not firing: unchanged); after `chargeSeconds` of firing `expired` is true exactly once and `armed` is `base`; `collect` in the same `update` tick as expiry leaves the player armed (call `collect` then `update`); `dropAll` returns to base.
- [ ] **Step 2: Run `npm test`; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`; expect PASS.**
- [ ] **Step 5: Commit** `Add weapon types and fire control with charge and swap rules`.

### Task B5: Pickups

**Files:**
- Create: `src/game/pickups.js`, `tests/game/pickups.test.js`

**Interfaces:**
- `class PickupDirector { constructor({ rotationSeconds = 20, pitySeconds = 10, fadeSeconds = 10, minimumDistance = 3, maximumDistance = 5, arenaWidth, arenaHeight, random = Math.random }); update(deltaSeconds, { playerX, playerY, onBaseGun, milestone, phasePlaying }) ; get offeredType ; get pickups (Array<{ x, y, type, age, fade }>) ; collect(playerX, playerY, radius = 0.35) -> typeName | null ; reset() }`. Rules: `offeredType` cycles through `WEAPON_TYPE_NAMES` every `rotationSeconds` of playing time; a pickup of the offered type spawns when `milestone` is true, and also when `onBaseGun` has been true for `pitySeconds` continuously (then the pity timer restarts); placement is uniformly random at a distance in `[minimumDistance, maximumDistance]` from the player, clamped inside the arena; pickups older than `fadeSeconds` are removed; `fade` is `1 - age / fadeSeconds`; `collect` removes and returns the nearest pickup within `radius`. Placement away from the densest mass is deferred to Plan C's lab tuning.

- [ ] **Step 1: Write failing tests** with an injected `random`: no pickup before 10 s on base gun, one at 10 s, and another at 20 s; a milestone spawns immediately; the offered type after 20 s is `scatter`; placement distance is within `[3, 5]` and inside the arena when the player stands at the corner; pickups vanish after 10 s; `collect` within radius returns the type and removes it, outside returns null.
- [ ] **Step 2: Run `npm test`; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`; expect PASS.**
- [ ] **Step 5: Commit** `Add pickup director with offered type rotation and recovery guard`.

### Task B6: Game orchestration

**Files:**
- Create: `src/game/game.js`, `tests/game/game.test.js`
- Modify: `src/main.js`

**Interfaces:**
- `class Game { static async create({ gpu, simulation, projectiles, renderer, input, capacity, clock }) ; start() ; restart() ; update(deltaSeconds) ; render(alpha) ; get state -> { score, multiplier, lives, bombs, armed, tier, charge, offeredType, phase, aliveTotal } }`. `update` order each frame: read `input.state`; if `bomb` edge and `run.useBomb()`, call `simulation.requestKillAll()` and queue an impulse; `player.update`; `pickups.update` and `collect` at the player, feeding `weapons.collect`; `weapons.update` producing spawns and beam into `projectiles`; `simulation.setPlayerState`; `spawnPressure.update` into the simulation; process the latest `readStats()`: `score.recordKills(killsThisFrame)` if `phase === Playing`, `awards.update(score)` adding lives and bombs, `run.playerHit(playerHitSequence)` which on success calls `weapons.dropAll()`, `score.recordHit()`, `simulation.acknowledgeHit`, and queues `requestKillAll` for the `clearArena` action; `respawn` action resets the player to center, calls `run.setRespawnSequence(currentFrameSequence)`, resets spawn pressure; `gameOver` freezes the run until `restart`. `restart` resets every module and clears the arena.
- `main.js` replaces the debug kill with `Game`; the debug panel from Plan A stays reachable.
- Testability: `Game` accepts fakes for `simulation`, `projectiles`, and `renderer` (objects with the same method names); `tests/game/game.test.js` runs `update` with scripted stats.

- [ ] **Step 1: Write failing tests** with fakes: a scripted stats stream of 60 kills across frames raises score and steps the multiplier; a hit event with a current sequence drops a life, drops the weapon to base, resets the multiplier and requests kill-all; a hit event with a stale sequence (below respawn) is ignored; `restart` after game over returns score to 0, lives to 3, bombs to 3, armed to base, and requests kill-all exactly once.
- [ ] **Step 2: Run `npm test`; expect FAIL.**
- [ ] **Step 3: Implement and wire `main.js`.**
- [ ] **Step 4: Run `npm test`; expect PASS. Extend `smoke.mjs` with a `--play 600` mode: synthetic right-stick firing toward the densest direction (just aim at the arena center from a position offset by 2 units) for 600 frames; assert `window.__murmuration.stats.score > 0` and no console errors. Run smoke; expect ok.**
- [ ] **Step 5: Commit** `Orchestrate the play loop: player, weapons, pickups, score, lives`.

## Phase 4: Weapons on screen

### Task B7: Ship, projectile, and pickup rendering

**Files:**
- Create: `src/render/ship.js`, `src/render/projectiles.js`, `src/render/pickups.js`, `src/render/shaders/ship.wgsl`, `src/render/shaders/projectiles.wgsl`, `src/render/shaders/pickups.wgsl`
- Modify: `src/render/renderer.js`

**Interfaces:**
- `class ShipRenderer { constructor(gpu, { viewport }); encode(pass, { x, y, facing, charge, armed, invulnerable, time }) }`: a white chevron glyph pointing along `facing`, a thin additive ring of radius 0.3 world units whose arc length is `charge` colored by the armed weapon's hue (full ring hidden when `armed === 'base'`), blinking at 8 Hz while invulnerable.
- `class ProjectileRenderer { constructor(gpu, { projectiles, viewport }); encode(pass, time) }`: one instance per projectile slot (dead slots degenerate); bullets and rails as stretched quads along velocity, scatter as short sparks, orbs as glowing discs, rings as thin expanding circles, sidewinders as short trails, the beam as a quad from the ship to the arena edge with width `2 * radius` and a bright core; colors per kind from a fixed palette in `weaponTypes.js` (`WEAPON_HUES`).
- `class PickupRenderer { constructor(gpu, { viewport }); encode(pass, pickups, time) }`: up to 32 instances uploaded per frame as a small uniform or storage buffer; rotating hexagon outline in the type's hue, alpha times `fade`, with a slow pulse.
- Draw order in `Renderer.render`: warp grid, trails decay, glyphs, projectiles, pickups, particles, ship, bloom, composite.

- [ ] **Step 1: Extend `smoke.mjs --play`:** after 600 frames, screenshot and assert the mean luminance in a 40 by 40 box around the ship exceeds the arena mean (the ship and its fire are bright) and no console errors.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run smoke; expect ok. Look in Chrome: fire each weapon from the debug panel's new `arm weapon` select (add `Game.debugArm(type, tier)`) and confirm each has a distinct silhouette.**
- [ ] **Step 5: Commit** `Render the ship, projectiles, and pickups`.

### Task B8: HUD in the letterbox bands

**Files:**
- Create: `src/ui/hud.js`, `src/ui/hud.css`, `tests/ui/hud.test.js`
- Modify: `index.html`, `src/main.js`

**Interfaces:**
- `createHud(rootElement) -> { update(state), showGameOver(score, onRestart), hideGameOver(), layout(arenaRectCssPixels, viewportCssSize) }`. `update` renders score (grouped digits), multiplier (`x4`), lives and bombs as icon rows, the armed weapon name and tier (`RAIL III`), and the offered pickup type. `layout` places the HUD in the left and right bands when the bands are at least 80 CSS pixels wide, otherwise along the top edge inside the arena with 60 percent opacity. Game over shows score and a `Play again` button; on touch devices a tap anywhere also restarts.
- Pure DOM, tested under node with a minimal fake `document` (the test constructs elements via a tiny stub with `createElement`, `textContent`, `classList`, and `append`), asserting the text content produced by `update`.

- [ ] **Step 1: Write failing tests:** `update({ score: 123456, multiplier: 4, lives: 2, bombs: 1, armed: 'rail', tier: 3 })` yields score text `123,456`, multiplier text `x4`, weapon text `RAIL III`; base gun yields weapon text `BASE`; `layout` with 100 px bands returns `'bands'`, with 20 px bands returns `'top'`.
- [ ] **Step 2: Run `npm test`; expect FAIL.**
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run `npm test` and smoke; expect PASS and ok.**
- [ ] **Step 5: Commit** `Add HUD in the letterbox bands with game over and restart`.

### Task B9: Shockwaves and particle floods

**Files:**
- Create: `src/render/impulses.js`, `tests/render/impulses.test.js`
- Modify: `src/render/warpgrid.js`, `src/render/shaders/warpgrid.wgsl`, `src/game/game.js`

**Interfaces:**
- `class ImpulseSet { constructor({ capacity = 8, durationSeconds = 1.2 }); add({ x, y, strength }, time) ; toUniformArray(time) -> Float32Array(capacity * 4) ; prune(time) }` packing `[x, y, age, strength]` per impulse (dead impulses have strength 0).
- `warpgrid.wgsl` adds, per vertex, a radial displacement `strength * exp(-((distance - 7 * age) ** 2) / 0.3) * (1 - age / 1.2)` for each impulse. `Game` adds an impulse of strength 1 on bomb and death, 0.3 on pulse ring detonation (reported by a stat counter `ringsThisFrame`, added in `projectiles_step`), and 0.15 at pickup collection.
- The bomb and death kill-all pass already floods particles (Task B3); this task adds a one-frame bloom boost (`bloomStrength * 2`) on bomb and death, decaying over 0.3 s.

- [ ] **Step 1: Write failing tests:** `toUniformArray` packs `[x, y, age, strength]`; after `durationSeconds` the impulse's strength is 0; a ninth impulse replaces the oldest.
- [ ] **Step 2: Run `npm test`; expect FAIL.**
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run `npm test` and smoke; expect PASS and ok. Look in Chrome: press bomb and watch the grid ring out.**
- [ ] **Step 5: Commit** `Add warp grid shockwaves for bombs, deaths, rings, and pickups`.

### Task B10: Documentation

**Files:**
- Modify: `README.md`, `AGENTS.md`

- [ ] **Step 1: Update docs affected by this plan:** run the docs-update check across `README.md`, `AGENTS.md` and inline comments. `README.md` gains a "How to play" section (controls for gamepad, mouse and keyboard, touch; bombs; weapons and pickups; what the charge ring means) and the scoring rules in one short table. `AGENTS.md` gains the per-frame order of operations from Task B6 and the file map additions.
- [ ] **Step 2: Run `npm test` and `npm run smoke`; expect PASS and ok.**
- [ ] **Step 3: Commit** `Document the play loop and weapons`.

---

## Self-review notes

- Spec coverage for this plan's scope: one-hit kills and one-touch death (B2, B3), lives and bombs and award thresholds (B1), kill-streak multiplier and capacity-normalized score (B1), bomb kills unscored (B3), death clears the arena with respawn invulnerability (B1, B3, B6), event ordering and stale-hit rejection with a GPU latch (B1, B3, B6), five weapon types with tiers, charge ring, swap rule, expiry, death drops all (B4, B7), pickups with offered rotation, pity timer, fade, and no landmines (B5), threat written by weapons so flee and the warp grid react (B2), weapon grid signatures via threat plus impulses (B2, B9), HUD in the bands (B8), base gun humble but able to open a lane (B4 values, tuned in Plan C's lab).
- Deferred to Plan C: pickup placement away from the densest mass, bullet-time or beat-synced flourishes, settings for stick dead zones.
- Names reused across tasks: `ScoreKeeper`, `Awards`, `RunState`, `RunPhase`, `Projectiles`, `PlayerShip`, `WeaponState`, `WEAPON_TYPES`, `WEAPON_TYPE_NAMES`, `WEAPON_HUES`, `PickupDirector`, `Game`, `ImpulseSet`, `createHud`, `Simulation.registerPass`, `Simulation.setPlayerState`, `Simulation.acknowledgeHit`, `Simulation.requestKillAll`, stats fields `killsThisFrame`, `killsUnscored`, `playerHitSequence`, `ringsThisFrame`.
