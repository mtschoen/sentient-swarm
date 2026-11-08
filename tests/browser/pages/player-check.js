// Player contact check. A 16384-slot Simulation gets 5000 alive Chasers (species 0, no spawn-in
// frames, at rest) seeded on a circle of radius 3 around the player at the arena center; nothing
// spawns. The page calls setPlayerState every step like the game will, then checks:
// (a) a contact hit is reported (playerHitSequence > 0) within 10 s of sim time; the hit frame
//     has exactly one contact kill (killsUnscored 1: one toucher per latch) and scores none
//     (killsSinceLastRead 0), and the alive total dropped by at least 1;
// (b) the latch: for LATCH_FRAMES unacknowledged frames, with alive agents overlapping the player,
//     playerHitSequence stays at the first hit and hitLatch reads 1; after acknowledgeHit and 3
//     more frames a second hit arrives whose sequence is past the acknowledging frame;
// (c) invulnerable, with the second hit acknowledged: no hit for 60 frames while agents overlap;
// (d) requestKillAll in a step that also spawns (so spawn-in agents exist when kill-all runs):
//     aliveTotal 0, killsUnscored > 0, killsSinceLastRead 0; the next frame killsUnscored is back to 0
//     while playerHitSequence persists across the per-step clear;
// (e) recreateWithCapacity carries the persistent tail: playerHitSequence survives the rebuild;
// (f) the pickup blast (owner ruling R22) through a real Game (fake renderer and input) on a fresh
//     simulation whose species never move: after the start clear, BLAST_AGENT_COUNT agents seeded
//     on rings from 0.3 to 3 around the ship and a pickup under it, one update collects it. Every
//     seeded agent inside pickupBlastRadius dies and every one outside lives, the blast step's
//     stats count them all in killsUnscored and none in killsSinceLastRead, the score stays 0,
//     and the next step kills nothing.
import { createGpuContext } from '/src/gpu/device.js';
import { AGENT_FLAG_ALIVE, AGENT_OFFSETS, AGENT_STRIDE_BYTES, ARENA_HEIGHT, ARENA_WIDTH, SPECIES_COUNT } from '/src/sim/layout.js';
import { DEFAULT_PLAYER_RADIUS, Simulation } from '/src/sim/simulation.js';
import { Game } from '/src/game/game.js';
import { InputState } from '/src/input/input.js';
import { defaultSpecies } from '/src/sim/species.js';

const CAPACITY = 16384;
const GROWN_CAPACITY = 32768;
const AGENT_COUNT = 5000;
const SEED_RADIUS = 3;
const STEP_SECONDS = 1 / 60;
const HIT_FRAME_LIMIT = 600;
const LATCH_FRAMES = 60;
const STALE_ACKNOWLEDGE_FRAMES = 30;
const ACKNOWLEDGE_FRAMES = 3;
const SECOND_HIT_FRAME_LIMIT = 120;
const INVULNERABLE_FRAMES = 60;
const CLEAR_SPAWN = [200, 0, 0, 0, 0];
const READBACK_ATTEMPTS = 20;
const CONTACT_MARGIN = 0.02;
const CENTER = [ARENA_WIDTH / 2, ARENA_HEIGHT / 2];

async function readBuffer(device, source) {
  const staging = device.createBuffer({ size: source.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const encoder = device.createCommandEncoder({ label: 'player-check-readback' });
  encoder.copyBufferToBuffer(source, 0, staging, 0, source.size);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const copy = staging.getMappedRange().slice(0);
  staging.unmap();
  staging.destroy();
  return copy;
}

class Harness {
  constructor(device, simulation) {
    this.device = device;
    this.simulation = simulation;
    this.collected = new Map();
    this.invulnerable = false;
  }

  seedRing() {
    const bytes = new ArrayBuffer(this.simulation.capacity * AGENT_STRIDE_BYTES);
    const view = new DataView(bytes);
    for (let slot = 0; slot < AGENT_COUNT; slot += 1) {
      const angle = (slot / AGENT_COUNT) * Math.PI * 2;
      const base = slot * AGENT_STRIDE_BYTES;
      view.setFloat32(base + AGENT_OFFSETS.position, CENTER[0] + Math.cos(angle) * SEED_RADIUS, true);
      view.setFloat32(base + AGENT_OFFSETS.position + 4, CENTER[1] + Math.sin(angle) * SEED_RADIUS, true);
      view.setUint32(base + AGENT_OFFSETS.species, 0, true);
      view.setUint32(base + AGENT_OFFSETS.flags, AGENT_FLAG_ALIVE, true);
      view.setFloat32(base + AGENT_OFFSETS.phase, angle, true);
    }
    this.device.queue.writeBuffer(this.simulation.agentsBuffer, 0, bytes);
  }

  // One step (player state set first, as the game does), submitted and awaited; returns its stats.
  async step(spawnPerSpecies = new Uint32Array(SPECIES_COUNT)) {
    this.simulation.setPlayerState({ x: CENTER[0], y: CENTER[1], radius: DEFAULT_PLAYER_RADIUS, invulnerable: this.invulnerable });
    const encoder = this.device.createCommandEncoder({ label: 'player-check-frame' });
    this.simulation.step(encoder, STEP_SECONDS, spawnPerSpecies);
    this.device.queue.submit([encoder.finish()]);
    this.simulation.afterSubmit();
    await this.device.queue.onSubmittedWorkDone();
    const sequence = this.simulation.frameSequence;
    for (let attempt = 0; attempt < READBACK_ATTEMPTS && !this.collected.has(sequence); attempt += 1) {
      for (const stats of this.simulation.readAllStats()) this.collected.set(stats.frameSequence, stats);
      if (!this.collected.has(sequence)) await this.device.queue.onSubmittedWorkDone();
    }
    const stats = this.collected.get(sequence);
    if (stats === undefined) throw new Error(`no stats for frame ${sequence}`);
    return stats;
  }

  // Alive agents within contact reach of the player in the newest agents buffer.
  async overlapping() {
    const view = new DataView(await readBuffer(this.device, this.simulation.agentsBuffer));
    let count = 0;
    for (let slot = 0; slot < this.simulation.capacity; slot += 1) {
      const base = slot * AGENT_STRIDE_BYTES;
      if ((view.getUint32(base + AGENT_OFFSETS.flags, true) & AGENT_FLAG_ALIVE) === 0) continue;
      const x = view.getFloat32(base + AGENT_OFFSETS.position, true);
      const y = view.getFloat32(base + AGENT_OFFSETS.position + 4, true);
      if (Math.hypot(x - CENTER[0], y - CENTER[1]) <= DEFAULT_PLAYER_RADIUS + CONTACT_MARGIN) count += 1;
    }
    return count;
  }
}

function verdictLine(verdicts) {
  return verdicts.map(([ok, text]) => `${ok ? 'PASS' : 'FAIL'} ${text}`).join('; ');
}

const BLAST_CAPACITY = 16384;
const BLAST_AGENT_COUNT = 4000;
const BLAST_RINGS = 40;
const BLAST_INNER_RADIUS = 0.3;
const BLAST_OUTER_RADIUS = 3;
const BLAST_EDGE_TOLERANCE = 0.01;
const BLAST_READ_UPDATES = 30;

// Seeds BLAST_AGENT_COUNT motionless agents on BLAST_RINGS rings around center; returns their
// distances from it by slot.
function seedBlastRings(device, simulation, center) {
  const bytes = new ArrayBuffer(simulation.capacity * AGENT_STRIDE_BYTES);
  const view = new DataView(bytes);
  const distances = [];
  const perRing = BLAST_AGENT_COUNT / BLAST_RINGS;
  for (let slot = 0; slot < BLAST_AGENT_COUNT; slot += 1) {
    const ring = Math.floor(slot / perRing);
    const radius = BLAST_INNER_RADIUS + (ring / (BLAST_RINGS - 1)) * (BLAST_OUTER_RADIUS - BLAST_INNER_RADIUS);
    const angle = ((slot % perRing) / perRing) * Math.PI * 2 + ring;
    const base = slot * AGENT_STRIDE_BYTES;
    view.setFloat32(base + AGENT_OFFSETS.position, center[0] + Math.cos(angle) * radius, true);
    view.setFloat32(base + AGENT_OFFSETS.position + 4, center[1] + Math.sin(angle) * radius, true);
    view.setUint32(base + AGENT_OFFSETS.species, 0, true);
    view.setUint32(base + AGENT_OFFSETS.flags, AGENT_FLAG_ALIVE, true);
    distances.push(radius);
  }
  device.queue.writeBuffer(simulation.agentsBuffer, 0, bytes);
  return distances;
}

async function runBlastCase(gpu) {
  const { device } = gpu;
  const species = defaultSpecies().map((row) => ({ ...row, maximumSpeed: 0 }));
  const simulation = await Simulation.create(gpu, { capacity: BLAST_CAPACITY, species });
  const renderer = { setSimulation() {}, render() {}, afterSubmit() {} };
  const input = { state: new InputState(), update() {} };
  const game = await Game.create({ gpu, simulation, renderer, input, capacity: BLAST_CAPACITY, random: () => 0.5 });
  const collected = new Map();
  const update = async () => {
    game.update(STEP_SECONDS);
    await device.queue.onSubmittedWorkDone();
    for (const stats of simulation.readAllStats()) collected.set(stats.frameSequence, stats);
  };
  game.start();
  await update();
  const { x, y } = game.player.position;
  const distances = seedBlastRings(device, simulation, [x, y]);
  game.pickups.pickups.push({ x, y, type: 'scatter', age: 0, fade: 1 });
  await update();
  const blastSequence = simulation.frameSequence;
  const view = new DataView(await readBuffer(device, simulation.agentsBuffer));
  const alive = distances.map((distance, slot) => (view.getUint32(slot * AGENT_STRIDE_BYTES + AGENT_OFFSETS.flags, true) & AGENT_FLAG_ALIVE) !== 0);
  const radius = game.pickupBlastRadius;
  const inside = distances.filter((distance) => distance < radius - BLAST_EDGE_TOLERANCE).length;
  const aliveInside = distances.filter((distance, slot) => alive[slot] && distance < radius - BLAST_EDGE_TOLERANCE).length;
  const deadOutside = distances.filter((distance, slot) => !alive[slot] && distance > radius + BLAST_EDGE_TOLERANCE).length;
  for (let index = 0; index < BLAST_READ_UPDATES && !collected.has(blastSequence + 1); index += 1) await update();
  const blastStats = collected.get(blastSequence);
  const nextStats = collected.get(blastSequence + 1);
  const score = game.state.score;
  game.removeProjectilePass();
  game.projectiles.destroy();
  simulation.destroy();
  if (blastStats === undefined || nextStats === undefined) return [[false, `(f) no stats for the blast step ${blastSequence} or the one after it`]];
  const killed = distances.filter((distance, slot) => !alive[slot]).length;
  return [
    [game.state.armed === 'scatter', `(f) the pickup was collected (armed ${game.state.armed})`],
    [inside > 0 && aliveInside === 0, `(f) alive agents inside the blast radius ${radius}: ${aliveInside} of ${inside} (need 0)`],
    [deadOutside === 0, `(f) dead agents outside the blast radius ${deadOutside} (need 0)`],
    [blastStats.killsUnscored === killed && blastStats.killsSinceLastRead === 0, `(f) blast step killsUnscored ${blastStats.killsUnscored} (need ${killed}), killsSinceLastRead ${blastStats.killsSinceLastRead} (need 0)`],
    [nextStats.killsUnscored === 0 && nextStats.killsSinceLastRead === 0, `(f) next step kills ${nextStats.killsUnscored} unscored, ${nextStats.killsSinceLastRead} scored (need 0 and 0)`],
    [score === 0, `(f) score after the blast ${score} (need 0)`],
  ];
}

async function runCheck() {
  const gpu = await createGpuContext(document.getElementById('canvas'));
  const { device } = gpu;
  let lostReason = null;
  device.lost.then((info) => { lostReason = info.message || info.reason || 'lost'; });
  device.addEventListener('uncapturederror', (event) => { console.error(`uncaptured WebGPU error: ${event.error.message}`); });

  let simulation = await Simulation.create(gpu, { capacity: CAPACITY });
  const harness = new Harness(device, simulation);
  harness.seedRing();
  const verdicts = [];

  // (a) first contact.
  let stats = await harness.step();
  const aliveBefore = stats.aliveTotal;
  let frames = 1;
  while (stats.playerHitSequence === 0 && frames < HIT_FRAME_LIMIT) {
    stats = await harness.step();
    frames += 1;
  }
  const firstHit = stats.playerHitSequence;
  verdicts.push([firstHit > 0, `(a) first hit at frame ${firstHit} after ${frames} frames (need within ${HIT_FRAME_LIMIT})`]);
  verdicts.push([stats.frameSequence === firstHit && stats.killsUnscored === 1, `(a) hit frame ${stats.frameSequence} contact kills (killsUnscored) ${stats.killsUnscored} (need exactly 1)`]);
  verdicts.push([stats.killsSinceLastRead === 0, `(a) hit frame scored kills ${stats.killsSinceLastRead} (need 0: contact never scores)`]);
  verdicts.push([stats.aliveTotal <= aliveBefore - 1, `(a) alive ${aliveBefore} -> ${stats.aliveTotal} (need a drop of at least 1)`]);
  if (!(firstHit > 0)) return { pass: false, detail: verdictLine(verdicts) };

  // (b) the latch holds without an acknowledgement and a stale acknowledgement does not release it.
  let latchHeld = true;
  for (let frame = 0; frame < LATCH_FRAMES; frame += 1) {
    stats = await harness.step();
    if (stats.playerHitSequence !== firstHit || stats.hitLatch !== 1) latchHeld = false;
  }
  const overlapWhileLatched = await harness.overlapping();
  verdicts.push([latchHeld, `(b) unacknowledged for ${LATCH_FRAMES} frames: hit sequence stayed ${firstHit} with the latch set (last ${stats.playerHitSequence}, latch ${stats.hitLatch})`]);
  verdicts.push([overlapWhileLatched > 0, `(b) agents overlapping the player while latched ${overlapWhileLatched} (need > 0)`]);

  simulation.acknowledgeHit(firstHit - 1);
  let staleHeld = true;
  for (let frame = 0; frame < STALE_ACKNOWLEDGE_FRAMES; frame += 1) {
    stats = await harness.step();
    if (stats.playerHitSequence !== firstHit || stats.hitLatch !== 1) staleHeld = false;
  }
  const overlapAfterStale = await harness.overlapping();
  verdicts.push([staleHeld, `(b) stale acknowledgement ${firstHit - 1} for ${STALE_ACKNOWLEDGE_FRAMES} frames: hit sequence stayed ${firstHit} with the latch set (last ${stats.playerHitSequence}, latch ${stats.hitLatch})`]);
  verdicts.push([overlapAfterStale > 0, `(b) agents overlapping the player after the stale acknowledgement ${overlapAfterStale} (need > 0)`]);

  simulation.acknowledgeHit(firstHit);
  const acknowledgedAt = simulation.frameSequence;
  for (let frame = 0; frame < ACKNOWLEDGE_FRAMES; frame += 1) stats = await harness.step();
  for (let frame = 0; frame < SECOND_HIT_FRAME_LIMIT && stats.playerHitSequence === firstHit; frame += 1) stats = await harness.step();
  const secondHit = stats.playerHitSequence;
  verdicts.push([secondHit > firstHit && secondHit > acknowledgedAt, `(b) second hit at frame ${secondHit} after acknowledging ${firstHit} at frame ${acknowledgedAt} (need later than both)`]);

  // (c) invulnerable.
  simulation.acknowledgeHit(secondHit);
  harness.invulnerable = true;
  let hitWhileInvulnerable = false;
  for (let frame = 0; frame < INVULNERABLE_FRAMES; frame += 1) {
    stats = await harness.step();
    if (stats.playerHitSequence !== secondHit) hitWhileInvulnerable = true;
  }
  const overlapWhileInvulnerable = await harness.overlapping();
  verdicts.push([!hitWhileInvulnerable && stats.hitLatch === 0, `(c) invulnerable ${INVULNERABLE_FRAMES} frames: hit sequence ${stats.playerHitSequence} (need ${secondHit}), latch ${stats.hitLatch} (need 0 after the acknowledgement)`]);
  verdicts.push([overlapWhileInvulnerable > 0, `(c) agents overlapping the invulnerable player ${overlapWhileInvulnerable} (need > 0)`]);

  // (d) kill-all, in a step that also spawns.
  const aliveBeforeClear = stats.aliveTotal;
  simulation.requestKillAll();
  stats = await harness.step(new Uint32Array(CLEAR_SPAWN));
  verdicts.push([stats.aliveTotal === 0, `(d) alive after kill-all ${stats.aliveTotal} (need 0)`]);
  verdicts.push([stats.killsUnscored > aliveBeforeClear, `(d) killsUnscored ${stats.killsUnscored} (need more than the ${aliveBeforeClear} alive before, spawned agents included)`]);
  verdicts.push([stats.killsSinceLastRead === 0, `(d) killsSinceLastRead ${stats.killsSinceLastRead} (need 0)`]);
  stats = await harness.step();
  verdicts.push([stats.killsUnscored === 0 && stats.aliveTotal === 0, `(d) next frame killsUnscored ${stats.killsUnscored}, alive ${stats.aliveTotal} (need 0 and 0)`]);
  verdicts.push([stats.playerHitSequence === secondHit, `(d) playerHitSequence ${stats.playerHitSequence} persists across the per-step clear (need ${secondHit})`]);

  // (e) the persistent tail survives a capacity rebuild.
  simulation = await simulation.recreateWithCapacity(GROWN_CAPACITY);
  harness.simulation = simulation;
  stats = await harness.step();
  verdicts.push([stats.playerHitSequence === secondHit, `(e) playerHitSequence after recreateWithCapacity ${stats.playerHitSequence} (need ${secondHit})`]);
  if (lostReason !== null) verdicts.push([false, `device lost: ${lostReason}`]);
  simulation.destroy();
  verdicts.push(...await runBlastCase(gpu));
  if (lostReason !== null) verdicts.push([false, `device lost: ${lostReason}`]);
  const detail = verdictLine(verdicts);
  return { pass: !detail.includes('FAIL'), detail };
}

runCheck().then(
  (result) => { window.__playerCheck = result; },
  (error) => { window.__playerCheck = { pass: false, detail: `exception: ${error.message}` }; },
);
