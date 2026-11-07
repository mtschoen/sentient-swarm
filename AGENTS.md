# Agent instructions

## Global constraints (binding)

- Plain JavaScript ES modules and WGSL. No TypeScript. No runtime dependencies. Vite and Playwright are dev dependencies only.
- Shaders are loaded with `fetch(new URL('./shaders/<name>.wgsl', import.meta.url))` so the page also runs from any static server without Vite.
- Full-word identifiers (`maximum`, not `max`; `position`, not `pos`) in JavaScript. WGSL may use `vec2f` style built-in names but user identifiers follow the same rule.
- No em-dashes (U+2014) anywhere, including comments and docs.
- Every source file under about 500 lines, or carrying a one-line note at the top saying why.
- No hard-coded machine paths. No wall-clock assertions in tests; inject time.
- Mobile WebGPU limits are designed for: at most 8 storage buffers bound per shader stage; agent data interleaved in 16-byte aligned structs with no `vec3` in storage layouts; `@workgroup_size` at most 256; workgroup memory at most 16 KB; timestamp queries optional.
- Neighbor contributions are averaged, never summed. Per-agent fine-pass neighbor sampling is capped at `MAXIMUM_NEIGHBOR_SAMPLES = 32`.
- Arena is 16 by 9 world units, bounded, fully in view, letterboxed; renderer works in device pixels.
- Species count is 5. Coarse field is 64 by 36 cells with 8 float channels (5 species densities, 1 threat, 2 padding).
- Commit after every task with a message in the imperative; end commit messages with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Commands

- `npm run dev`: dev server on 127.0.0.1:5174 (strictPort).
- `npm run build`: static build into `dist/`, base taken from `PAGES_BASE` (default `/`).
- `npm test`: CPU logic tests via node:test.
- `npm run smoke`: Playwright browser smoke test.

## Pass order

Each animation frame `FrameLoop` runs zero or more fixed update steps, then one render. Each is its own queue submission.

- Update (`Simulation.step`): spawn, grid count, grid scan, grid scatter, coarse field downsample, coarse field blur, steer, integrate, kill-all (only in the step after `requestKillAll`), registered passes (`Simulation.registerPass`; `Projectiles.encode` runs projectile step, collide and beam here), player contact with the hit latch (once `setPlayerState` has been called), debug kill (only while armed; only the browser checks arm it), particle step, stats, stats copy into the staging ring. The step clears only the stats buffer's per-frame prefix; its persistent tail (`playerHitSequence`, `hitLatch` and the cumulative scored `kills` counter) survives, and a capacity swap copies it into the new simulation along with the compacted alive agents. The projectile step counts pulse ring detonations into the prefix (`ringsThisFrame`, `lastRingX`, `lastRingY`).
- Render (`Renderer.render`): warp grid layer (with this frame's shockwave impulses), trails decay, glyphs, projectiles, pickups, particles, ship and charge ring, bloom, composite. `Game.scene()` supplies the projectiles, pickups and ship; the ship hides from death until respawn.

## Frame order of operations

One `Game.update(deltaSeconds)` is one fixed step (full comments at the top of `src/game/game.js`):

1. Input: `input.update`; in Ready, the first gesture (fire, bomb, movement or stick) starts the run, and a start clears the arena with one kill-all. A rising bomb edge accepted by `RunState.useBomb` requests a kill-all before this step.
2. `PlayerShip.update` (Playing only); the mouse aims from the ship to the pointer unless a stick or touch aim is pushed.
3. `PickupDirector.update`, then collection at the player into `WeaponState.collect`, before charge expiry.
4. `WeaponState.update`: spawns go to `Projectiles.queueSpawn` and the beam to `setBeam` (cleared on the expiry frame).
5. `Simulation.setPlayerState` (`setPlayer` only in Ready, so contact stays off until start), then spawn pressure (`SpawnPressure.update` with the latest stats and the step's sequence, so spawns still in flight are not requested twice; paused while dying and respawning), then the simulation step is submitted.
6. Every ready stats frame (`readAllStats`, oldest first): kills (`killsSinceLastRead`, the difference of the cumulative counter) score once per stats frame and only while Playing, awards add lives and bombs, ring detonations queue a shockwave, and each new `playerHitSequence` is acknowledged and offered to `RunState.playerHit` (which drops the weapon and resets the multiplier).
7. `RunState.update` drains actions: clear the arena and projectiles, queue bomb and death shockwaves, respawn.

While a capacity change is pending (`Game.setCapacity` through `CapacitySwap`), `Game.update` does nothing, so no step is lost to the simulation being replaced. After each update `main.js` hands `Game.freshStats` (the newest frame read this update, kills summed) to the audio hook.

Event order inside the GPU step follows the pass order above: bomb kill-all, projectile kills, player contact. A pickup collected in the frame of charge expiry wins. Every projectile kind pierces. GPU events carry `frameSequence`; the CPU ignores hits that predate the current respawn.

## File map

- `src/audio/`: `audio.js` (`AudioEngine`, unlock on the first gesture), `sequencer.js` (`StepSequencer`), `music.js` (`ProceduralMusic`), `sfx.js` (`EffectsSynth`), `voices.js`, `intensity.js`, `audio-hook.js` (wiring, M to mute).
- `src/game/`: `game.js` (`Game`: joins input, ship, weapons, pickups, score, run state and the simulation; one `update` per step), `capacity-swap.js` (`CapacitySwap`: pauses stepping across a capacity change), `loop.js` (fixed-step `FrameLoop`), `player.js` (CPU `PlayerShip`: movement, aim, facing), `run.js` (`RunState`: phases, lives, bombs, death and respawn timing, invulnerability), `score.js` (`ScoreKeeper`, `Awards`: capacity-normalized points, multiplier, extra lives and bombs), `weaponTypes.js` (projectile kinds, hues, tier tables), `weapons.js` (`WeaponState`: tiers, charge, fire spawns), `pickups.js` (`PickupDirector`: rotation, milestone and recovery guard spawns), `projectiles.js` (GPU `Projectiles`: CPU slot assignment and spawn writes, `projectiles_step.wgsl` and `projectiles_collide.wgsl` in `src/sim/shaders/`).
- `src/gpu/`: `device.js` (adapter, device, unsupported-browser copy), `buffers.js` (buffer helpers, `StagingRing`), `shaders.js` (shader loading and constant substitution), `bind-group-cache.js`.
- `src/input/`: `input.js` (unified `InputState`), `keyboard.js`, `pointer.js`, `touch.js`, `gamepad.js`. Mouse: left button fires, right button is the bomb (and the inspect zoom). Keyboard: WASD or arrows move, Space bombs. Gamepad: right stick aims and fires, face buttons bomb. Touch: left half moves, right half aims and fires.
- `src/render/`: `renderer.js` (frame order, settings), `viewport.js` (letterbox, inspect zoom), `canvas-size.js`, `glyphs.js`, `particles.js`, `ship.js` (ship and charge ring, `ship.wgsl`), `projectiles.js` and `pickups.js` (`projectiles.wgsl`, `pickups.wgsl`), `world-view.js` (shared world uniform header), `trails.js`, `bloom.js`, `warpgrid.js` (shockwaves from `impulses.js`: `ImpulseSet` and the bloom boost), `composite.js`, `render-shaders.js`, `capture.js` and `capture-hook.js` (frame readback for the smoke), `shaders/*.wgsl` (`ships.wgsl` holds the per-species ship silhouettes prepended to `glyphs.wgsl`).
- `src/sim/`: `simulation.js` (facade), `layout.js` (shared constants and sizes), `params.js` (`SimParams` packing), `species.js` (rows, matrix, table packing), `grid.js`, `field.js`, `steer.js`, `spawn.js` (GPU spawn) and `spawner.js` (`SpawnPressure`), `kill.js` (debug kill, kill-all and player contact passes), `compact.js` (alive-agent compaction for the capacity swap), `particles.js`, `stats.js`, `shaders/*.wgsl` (including `common.wgsl`, the shared header).
- `src/ui/`: `hud.js` and `hud.css` (DOM HUD in the letterbox bands: score, multiplier, weapon, charge, lives, bombs, game over), `debugPanel.js` (DOM panel, including the arm weapon select), `panelModel.js` (slider specs, capacity list, frames-per-second meter, readout text).
- `src/main.js`: boot, wiring, capacity change.
- `tests/<area>/`: node:test files mirroring `src/` (`audio`, `game`, `gpu`, `input`, `render`, `sim`, `ui`), plus `build.test.js`, `sanity.test.js` and `pages_assembly_test.py`.
- `tests/browser/`: `smoke.mjs`, GPU checks (`grid.mjs`, `steer.mjs`, `simulation.mjs`, `projectiles.mjs`, `player.mjs` with their pages under `pages/`), `launch.mjs` and `server.mjs` shared launchers.
