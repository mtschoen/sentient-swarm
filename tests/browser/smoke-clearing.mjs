// Smoke modes for tasks C0b and C0b2 (owner rulings R12, R13, R14 and R21), run through smoke.mjs:
// --corridor: the R13 acceptance metric. The synthetic gamepad moves the ship to the left wall
//   (starting the run), the spawn floor is optionally raised (--corridor-floor F) through
//   SpawnPressure.setRamp, the ship turns invulnerable (game.debugInvulnerable: a death would
//   clear the arena mid-measurement), the swarm settles for CORRIDOR_SETTLE_FRAMES, then a tier 3
//   beam (armed through game.debugArm, the debug panel's arm path) fires right across the arena
//   for CORRIDOR_FIRE_FRAMES. The coarse field is read back (Simulation.readCoarseField, a
//   test-only readback) before the fire and 1 s and 3 s after it stops. Corridor: the coarse
//   cells whose centers lie within the beam's half width of the ship's row, from CORRIDOR_START_X
//   to CORRIDOR_END_X (clear of the ship, where seek gathers the swarm). Control: the same columns
//   in the rows CONTROL_ROW_OFFSET above and below, untouched by the beam. The corridor's mean
//   density must stay under half the control's at 3 s. Each reading also prints the corridor per
//   species, the densest coarse cell and the share of cells over CLUMP_DENSITY (a clump check),
//   and the gates and aim after the beam. Diagnostics (task C0b2 P25): --corridor-norefill stops
//   refills at the beam, --corridor-species '{"pressure":0}' overrides every species row at the beam.
// --bursts: the visual gates, with the ship invulnerable until the death capture.
//   artifacts/kill-burst.png: the base gun firing at the oldest gate's swarm (R12, R21), captured
//   after BURST_FIRE_FRAMES of fire. Then, mid-wave, the gate check (R14): at least
//   GATE_CLUSTER_MINIMUM_SHARE of the fresh spawns lie at a gate, and artifacts/gates.png.
//   artifacts/bomb.png: the floor raised to BOMB_FLOOR_FRACTION, a bomb through the dense arena,
//   captured BOMB_CAPTURE_FRAMES after the press; the particle pool's live count (read from its
//   header) is reported against the pool size before and after the bomb. artifacts/death-flood.png:
//   full seek, the ship vulnerable and moving into the swarm, captured DEATH_CAPTURE_FRAMES after
//   the phase turns dying (R21: the flash, the flood and the clear).
// --blast (task C0e, owner ruling R22): the pickup blast visual gate. The ship (invulnerable) is
//   nudged to start the run, the floor raised to BLAST_FLOOR_FRACTION so the swarm crowds it,
//   then a pickup placed under the ship is collected; artifacts/pickup-blast.png is captured
//   BLAST_CAPTURE_FRAMES later. The blast must kill (the alive total drops) without scoring.
// All fail on console errors; the corridor check also fails when the ship died anyway.
import { COARSE_CELL_SIZE, COARSE_CHANNELS, COARSE_COLUMNS, COARSE_ROWS, SPECIES_COUNT, WORLD_HEIGHT, WORLD_WIDTH } from '../../src/sim/layout.js';

// Long enough at the ship's 6 units per second to reach the left wall from the world center.
const MOVE_TO_WALL_FRAMES = Math.ceil(((WORLD_WIDTH / 2) / 6) * 60) + 5;
// --legacy-spawn: the Plan A spawn for comparison: anywhere in the arena (a band of half the
// arena height), refilling as fast as the ramp allows, no density bias.
const LEGACY_RAMP = { refillFractionPerSecond: 1 };
const LEGACY_SPAWN = { bandWidth: WORLD_HEIGHT / 2, densityBias: 0 };
const CORRIDOR_SETTLE_FRAMES = 600;
const CORRIDOR_FIRE_FRAMES = 60;
const CORRIDOR_LATE_FRAMES = [60, 180];
const CORRIDOR_START_X = 5;
const CORRIDOR_END_X = 15;
const CONTROL_ROW_OFFSET = 2.25;
// The tier 3 beam's half width (WEAPON_TYPES.beam in src/game/weaponTypes.js).
const BEAM_TIER = 3;
const BEAM_HALF_WIDTH = 0.3;
const CORRIDOR_MAXIMUM_RATIO = 0.5;
const BURST_FIRE_FRAMES = 240;
const BURST_AIM_FRAMES = 60;
const BOMB_FLOOR_FRACTION = 0.9;
const BOMB_SETTLE_FRAMES = 180;
const BOMB_CAPTURE_FRAMES = 6;
const BLAST_FLOOR_FRACTION = 0.5;
const BLAST_NUDGE_FRAMES = 4;
const BLAST_SETTLE_FRAMES = 300;
const BLAST_CAPTURE_FRAMES = 6;
// --bursts gate check (owner ruling R14, task C0b2): frames into a wave before sampling, the
// margin past a gate radius a fresh spawn may lie (gate drift during its spawn-in) and the share
// of fresh spawns that must lie at a gate.
const GATE_WAVE_FRAMES = 12;
const GATE_CLUSTER_MARGIN = 0.25;
// Fresh spawns: at least this many of their 30 spawn-in frames left (at most 6 frames old), so
// their outward ejection has carried them at most about 0.16 world units.
const GATE_FRESH_SPAWN_FRAMES = 24;
const GATE_CLUSTER_MINIMUM_SHARE = 0.9;
// The death flood capture comes this many frames after the phase turns dying (the clear and the
// flood run in the step after the hit is read).
const DEATH_CAPTURE_FRAMES = 3;
const FRAME_TIMEOUT_MILLISECONDS = 60_000;
const CELL_HEIGHT = COARSE_CELL_SIZE;
const CELL_WIDTH = COARSE_CELL_SIZE;

// Mean total density (species channels) over the cells whose centers lie within halfHeight of
// rowCenterY and between startX and endX.
function bandDensity(field, rowCenterY, halfHeight, startX, endX, onlySpecies = null) {
  let sum = 0;
  let cells = 0;
  for (let row = 0; row < COARSE_ROWS; row += 1) {
    if (Math.abs((row + 0.5) * CELL_HEIGHT - rowCenterY) >= halfHeight) continue;
    for (let column = 0; column < COARSE_COLUMNS; column += 1) {
      const centerX = (column + 0.5) * CELL_WIDTH;
      if (centerX < startX || centerX > endX) continue;
      const base = (row * COARSE_COLUMNS + column) * COARSE_CHANNELS;
      for (let species = 0; species < SPECIES_COUNT; species += 1) if (onlySpecies === null || onlySpecies === species) sum += field[base + species];
      cells += 1;
    }
  }
  return sum / cells;
}

// --corridor-floor F raises the spawn floor to the fraction F of capacity for a denser crowd (by
// default the tuned ramp is left alone); --legacy-spawn measures the Plan A spawn instead.
function corridorOptions(argumentList) {
  const index = argumentList.indexOf('--corridor-floor');
  const floorFraction = index === -1 ? null : Number.parseFloat(argumentList[index + 1]);
  if (floorFraction !== null && !(floorFraction > 0 && floorFraction <= 1)) throw new Error('--corridor-floor needs a fraction in (0, 1]');
  const overrideIndex = argumentList.indexOf('--corridor-species');
  const speciesOverride = overrideIndex === -1 ? null : JSON.parse(argumentList[overrideIndex + 1]);
  const norefill = argumentList.includes('--corridor-norefill');
  return { floorFraction, legacy: argumentList.includes('--legacy-spawn'), speciesOverride, norefill };
}

async function readField(page, evaluateWithin) {
  return Float32Array.from(await evaluateWithin(page, 'reading the coarse field', async () => Array.from(await window.__murmuration.game.simulation.readCoarseField())));
}

// The densest coarse cell and the share of cells above CLUMP_DENSITY agents (a clump check).
const CLUMP_DENSITY = 60;
function crowding(field) {
  let maximum = 0;
  let crowded = 0;
  const cells = COARSE_COLUMNS * COARSE_ROWS;
  for (let cell = 0; cell < cells; cell += 1) {
    let total = 0;
    for (let species = 0; species < SPECIES_COUNT; species += 1) total += field[cell * COARSE_CHANNELS + species];
    maximum = Math.max(maximum, total);
    if (total > CLUMP_DENSITY) crowded += 1;
  }
  return { maximum, crowdedShare: crowded / cells };
}

// The corridor metric: mean density of the band around shipY against the mean of the same band
// CONTROL_ROW_OFFSET above and below, with the corridor per species and the crowding check.
// smoke.mjs --play measures the base gun's tunnel with it.
export function corridorDensities(field, shipY, { halfHeight = BEAM_HALF_WIDTH, startX = CORRIDOR_START_X, endX = CORRIDOR_END_X } = {}) {
  const corridor = bandDensity(field, shipY, halfHeight, startX, endX);
  const control = (bandDensity(field, shipY - CONTROL_ROW_OFFSET, halfHeight, startX, endX)
    + bandDensity(field, shipY + CONTROL_ROW_OFFSET, halfHeight, startX, endX)) / 2;
  const perSpecies = Array.from({ length: SPECIES_COUNT }, (unused, species) => bandDensity(field, shipY, halfHeight, startX, endX, species).toFixed(2)).join('/');
  return { corridor, control, ratio: control > 0 ? corridor / control : Number.POSITIVE_INFINITY, perSpecies, ...crowding(field) };
}

async function framesLater(page, helpers, frames) {
  const start = await helpers.evaluateWithin(page, 'reading the frame', () => window.__murmuration.frame);
  await page.waitForFunction((target) => window.__murmuration.frame >= target, start + frames, { timeout: FRAME_TIMEOUT_MILLISECONDS });
}

async function setRamp(page, helpers, ramp) {
  await helpers.evaluateWithin(page, 'changing the spawn ramp', (values) => window.__murmuration.game.spawnPressure.setRamp(values), ramp);
}

// Moves the ship to the left wall, which also starts the run. Returns the ship's y.
async function moveToLeftWall(page, helpers) {
  await helpers.setSticks(page, [-1, 0, 0, 0]);
  await framesLater(page, helpers, MOVE_TO_WALL_FRAMES);
  await helpers.setSticks(page, [0, 0, 0, 0]);
  return (await helpers.evaluateWithin(page, 'reading the ship', () => window.__murmuration.stats)).playerY;
}

function describe({ corridor, control, ratio, maximum, crowdedShare, perSpecies }) {
  return `corridor ${corridor.toFixed(3)} [${perSpecies}], control ${control.toFixed(3)}, ratio ${ratio.toFixed(3)} (densest cell ${maximum.toFixed(1)}, cells over ${CLUMP_DENSITY}: ${(crowdedShare * 100).toFixed(1)} percent)`;
}

// Returns a failure message, or null.
export async function checkCorridor(page, helpers) {
  const options = corridorOptions(process.argv.slice(2));
  await helpers.evaluateWithin(page, 'making the ship invulnerable', () => window.__murmuration.game.debugInvulnerable(true));
  const shipY = await moveToLeftWall(page, helpers);
  await setRamp(page, helpers, { ...(options.floorFraction === null ? {} : { floorFraction: options.floorFraction }), ...(options.legacy ? LEGACY_RAMP : {}) });
  if (options.legacy) {
    await helpers.evaluateWithin(page, 'restoring the uniform spawn', (spawn) => {
      const { simulation } = window.__murmuration.game;
      simulation.setSpawnBandWidth(spawn.bandWidth);
      simulation.setSpawnDensityBias(spawn.densityBias);
    }, LEGACY_SPAWN);
  }
  console.log(`smoke: corridor setup floor ${options.floorFraction ?? 'default'}${options.legacy ? ', legacy spawn (uniform, refill 1 per second, no bias)' : ', default spawn'}`);
  await framesLater(page, helpers, CORRIDOR_SETTLE_FRAMES);
  const settled = await helpers.evaluateWithin(page, 'reading stats', () => window.__murmuration.stats);
  const livesBefore = settled.lives;
  const before = corridorDensities(await readField(page, helpers.evaluateWithin), shipY);
  if (options.speciesOverride !== null) {
    await helpers.evaluateWithin(page, 'overriding species', (override) => {
      const { simulation } = window.__murmuration.game;
      simulation.setSpecies(simulation.species.map((row) => ({ ...row, ...override })), simulation.matrix);
    }, options.speciesOverride);
  }
  if (options.norefill) await setRamp(page, helpers, { refillFractionPerSecond: 0 });
  await helpers.evaluateWithin(page, 'arming the beam', (tier) => window.__murmuration.game.debugArm('beam', tier), BEAM_TIER);
  await helpers.setSticks(page, [0, 0, 1, 0]);
  await framesLater(page, helpers, CORRIDOR_FIRE_FRAMES);
  await helpers.setSticks(page, [0, 0, 0, 0]);
  const after = [];
  let waited = 0;
  for (const frames of CORRIDOR_LATE_FRAMES) {
    await framesLater(page, helpers, frames - waited);
    waited = frames;
    after.push(corridorDensities(await readField(page, helpers.evaluateWithin), shipY));
    const gates = await helpers.evaluateWithin(page, 'reading the gates', () => {
      const { game } = window.__murmuration;
      const { aim } = game.player;
      return `aim (${aim.x.toFixed(2)}, ${aim.y.toFixed(2)}), ` + game.spawnDirector.gates.map((gate) => `(${gate.x.toFixed(1)}, ${gate.y.toFixed(1)}${gate.emit > 0 ? ' emitting' : ''})`).join(' ');
    });
    console.log(`smoke: corridor gates ${frames / 60} s after the beam: ${gates}`);
  }
  const { phase, lives } = await helpers.evaluateWithin(page, 'reading stats', () => window.__murmuration.stats);
  console.log(`smoke: corridor before the beam (aliveTotal ${settled.aliveTotal}, lives ${livesBefore}): ${describe(before)}`);
  // Informational: the ratio relative to the ratio before the beam, which factors out a corridor
  // row that was already thinner (or denser) than the control rows.
  CORRIDOR_LATE_FRAMES.forEach((frames, index) => console.log(`smoke: corridor ${(frames / 60).toFixed(0)} s after the beam: ${describe(after[index])}, relative to before ${(after[index].ratio / before.ratio).toFixed(3)}`));
  if (page.consoleErrors.length > 0) return `smoke: console errors during the corridor check: ${page.consoleErrors.join(' | ')}`;
  if (phase !== 'playing' || lives < livesBefore) {
    return `smoke: the ship died during the corridor measurement (phase ${phase}, lives ${livesBefore} -> ${lives}); the metric needs a live ship`;
  }
  const late = after[after.length - 1];
  if (!(late.ratio < CORRIDOR_MAXIMUM_RATIO)) {
    return `smoke: expected the corridor under ${CORRIDOR_MAXIMUM_RATIO} of the control density ${CORRIDOR_LATE_FRAMES.at(-1) / 60} s after the beam, got ${describe(late)}`;
  }
  return null;
}

// The particle pool's live count (header word 1) and size, read back through the game's device.
async function readParticleLoad(page, helpers) {
  return helpers.evaluateWithin(page, 'reading the particle pool', async () => {
    const { game } = window.__murmuration;
    const { device } = game.gpu;
    const pool = game.simulation.particlePool;
    const staging = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(pool.buffers.particles, 0, staging, 0, 16);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const live = new Uint32Array(staging.getMappedRange())[1];
    staging.unmap();
    staging.destroy();
    return { live, size: pool.capacity };
  });
}

// Reads the alive agents at least GATE_FRESH_SPAWN_FRAMES from the end of their spawn-in (the
// newest spawns) and the director's gates in the same task, then counts how many of those agents
// lie within a gate radius plus GATE_CLUSTER_MARGIN of some gate (their ejection and the gate's
// drift move them a little).
async function readGateClustering(page, helpers) {
  return helpers.evaluateWithin(page, 'reading the fresh spawns', async ({ margin, freshFrames }) => {
    const { game } = window.__murmuration;
    const { device } = game.gpu;
    const source = game.simulation.agentsBuffer;
    const gates = game.spawnDirector.gates.map(({ x, y, radius }) => ({ x, y, radius }));
    const staging = device.createBuffer({ size: source.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, 0, staging, 0, source.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const floats = new Float32Array(staging.getMappedRange());
    const words = new Uint32Array(floats.buffer);
    let fresh = 0;
    let inside = 0;
    for (let slot = 0; slot < words.length / 8; slot += 1) {
      const flags = words[slot * 8 + 5];
      if ((flags & 1) === 0 || ((flags >> 8) & 255) < freshFrames) continue;
      fresh += 1;
      const x = floats[slot * 8];
      const y = floats[slot * 8 + 1];
      if (gates.some((gate) => Math.hypot(x - gate.x, y - gate.y) <= gate.radius + margin)) inside += 1;
    }
    staging.unmap();
    staging.destroy();
    return { fresh, inside, gates: gates.length };
  }, { margin: GATE_CLUSTER_MARGIN, freshFrames: GATE_FRESH_SPAWN_FRAMES });
}

// Polls (one evaluate per animation frame inside the page) until predicate holds, then waits
// extraFrames more. The predicate runs in the page.
async function waitInPage(page, helpers, label, predicateSource, extraFrames = 0) {
  await page.waitForFunction(predicateSource, null, { timeout: FRAME_TIMEOUT_MILLISECONDS, polling: 'raf' });
  if (extraFrames > 0) await framesLater(page, helpers, extraFrames);
}

// Returns a failure message, or null.
export async function captureBlast(page, helpers) {
  await helpers.evaluateWithin(page, 'making the ship invulnerable', () => window.__murmuration.game.debugInvulnerable(true));
  await helpers.setSticks(page, [-1, 0, 0, 0]);
  await framesLater(page, helpers, BLAST_NUDGE_FRAMES);
  await helpers.setSticks(page, [0, 0, 0, 0]);
  await setRamp(page, helpers, { floorFraction: BLAST_FLOOR_FRACTION });
  await framesLater(page, helpers, BLAST_SETTLE_FRAMES);
  const before = await helpers.evaluateWithin(page, 'reading stats', () => window.__murmuration.stats);
  const radius = await helpers.evaluateWithin(page, 'placing a pickup under the ship', () => {
    const { game } = window.__murmuration;
    const { x, y } = game.player.position;
    game.pickups.pickups.push({ x, y, type: 'scatter', age: 0, fade: 1 });
    return game.pickupBlastRadius;
  });
  await framesLater(page, helpers, BLAST_CAPTURE_FRAMES);
  const blast = await helpers.evaluateWithin(page, 'the pickup blast capture', () => window.__murmuration.capture());
  await helpers.writeDataUrl('pickup-blast.png', blast.pngDataUrl);
  const after = await helpers.evaluateWithin(page, 'reading stats', () => window.__murmuration.stats);
  console.log(`smoke: pickup blast (radius ${radius}) at (${before.playerX.toFixed(2)}, ${before.playerY.toFixed(2)}): aliveTotal ${before.aliveTotal} -> ${after.aliveTotal}, score ${before.score} -> ${after.score}, armed ${after.armed}, arena mean ${blast.meanLuminance.toFixed(4)}`);
  if (page.consoleErrors.length > 0) return `smoke: console errors during the blast capture: ${page.consoleErrors.join(' | ')}`;
  if (after.armed !== 'scatter') return `smoke: expected the pickup under the ship to be collected, armed ${after.armed}`;
  if (!(after.aliveTotal < before.aliveTotal)) return `smoke: expected the pickup blast to kill, aliveTotal ${before.aliveTotal} -> ${after.aliveTotal}`;
  return null;
}

// Returns a failure message, or null.
export async function captureBursts(page, helpers) {
  // A death would flood the pool with its own clear and empty the arena before the bomb.
  await helpers.evaluateWithin(page, 'making the ship invulnerable', () => window.__murmuration.game.debugInvulnerable(true));
  await moveToLeftWall(page, helpers);
  // Gates gather the early swarm, so aim at the oldest gate (re-aimed as it drifts or closes).
  for (let aimed = 0; aimed < BURST_FIRE_FRAMES; aimed += BURST_AIM_FRAMES) {
    const aim = await helpers.evaluateWithin(page, 'aiming at a gate', () => {
      const { game } = window.__murmuration;
      const gate = game.spawnDirector.gates[0];
      const offsetX = gate ? gate.x - game.player.position.x : 1;
      const offsetY = gate ? gate.y - game.player.position.y : 0;
      const length = Math.hypot(offsetX, offsetY) || 1;
      return [offsetX / length, offsetY / length];
    });
    await helpers.setSticks(page, [0, 0, ...aim]);
    await framesLater(page, helpers, BURST_AIM_FRAMES);
  }
  const kills = await helpers.evaluateWithin(page, 'the kill burst capture', () => window.__murmuration.capture());
  await helpers.writeDataUrl('kill-burst.png', kills.pngDataUrl);
  const burstLoad = await readParticleLoad(page, helpers);
  console.log(`smoke: kill burst capture after ${BURST_FIRE_FRAMES} frames of base fire, arena mean ${kills.meanLuminance.toFixed(4)}, live particles ${burstLoad.live} of ${burstLoad.size}`);
  // R14: the kills leave a deficit, so the next wave pours from one gate; sample it mid-wave.
  await waitInPage(page, helpers, 'waiting for a wave', () => window.__murmuration.game.spawnDirector.wave?.emitting === true, GATE_WAVE_FRAMES);
  const clustering = await readGateClustering(page, helpers);
  const gates = await helpers.evaluateWithin(page, 'the gate capture', () => window.__murmuration.capture());
  await helpers.writeDataUrl('gates.png', gates.pngDataUrl);
  await helpers.setSticks(page, [0, 0, 0, 0]);
  const clusteredShare = clustering.fresh > 0 ? clustering.inside / clustering.fresh : 0;
  console.log(`smoke: gates ${clustering.gates}, fresh spawns ${clustering.fresh}, within a gate radius + ${GATE_CLUSTER_MARGIN}: ${clustering.inside} (${(clusteredShare * 100).toFixed(1)} percent)`);
  await setRamp(page, helpers, { floorFraction: BOMB_FLOOR_FRACTION });
  await framesLater(page, helpers, BOMB_SETTLE_FRAMES);
  const aliveBefore = (await helpers.evaluateWithin(page, 'reading stats', () => window.__murmuration.stats)).aliveTotal;
  const loadBefore = await readParticleLoad(page, helpers);
  await page.keyboard.down('Space');
  await framesLater(page, helpers, BOMB_CAPTURE_FRAMES);
  await page.keyboard.up('Space');
  const bomb = await helpers.evaluateWithin(page, 'the bomb capture', () => window.__murmuration.capture());
  await helpers.writeDataUrl('bomb.png', bomb.pngDataUrl);
  const loadAfter = await readParticleLoad(page, helpers);
  console.log(`smoke: bomb through ${aliveBefore} alive agents: live particles ${loadBefore.live} -> ${loadAfter.live} of ${loadAfter.size}, arena mean ${bomb.meanLuminance.toFixed(4)}`);
  // R21: let the swarm reach the ship (full seek, ship vulnerable, moving into the arena), then
  // capture the death flood a few frames after the hit is read.
  await setRamp(page, helpers, { seekFloorFraction: 1 });
  await helpers.evaluateWithin(page, 'making the ship vulnerable', () => window.__murmuration.game.debugInvulnerable(false));
  await helpers.setSticks(page, [1, 0, 0, 0]);
  await waitInPage(page, helpers, 'waiting for a death', () => window.__murmuration.game.run.phase === 'dying', DEATH_CAPTURE_FRAMES);
  const death = await helpers.evaluateWithin(page, 'the death flood capture', () => window.__murmuration.capture());
  await helpers.setSticks(page, [0, 0, 0, 0]);
  await helpers.writeDataUrl('death-flood.png', death.pngDataUrl);
  const deathLoad = await readParticleLoad(page, helpers);
  console.log(`smoke: death flood capture ${DEATH_CAPTURE_FRAMES} frames into dying, arena mean ${death.meanLuminance.toFixed(4)}, live particles ${deathLoad.live} of ${deathLoad.size}`);
  if (page.consoleErrors.length > 0) return `smoke: console errors during the burst captures: ${page.consoleErrors.join(' | ')}`;
  if (!(loadAfter.live > loadBefore.live && loadAfter.live <= loadAfter.size)) {
    return `smoke: expected the bomb to add live particles within the pool, got ${loadBefore.live} -> ${loadAfter.live} of ${loadAfter.size}`;
  }
  if (!(clustering.fresh > 0 && clusteredShare >= GATE_CLUSTER_MINIMUM_SHARE)) {
    return `smoke: expected at least ${GATE_CLUSTER_MINIMUM_SHARE * 100} percent of the fresh spawns at a gate, got ${clustering.inside} of ${clustering.fresh}`;
  }
  return null;
}
