// Player swarm contact check (player_collide.wgsl). A 16384-slot Simulation whose species never
// move gets motionless alive agents placed exactly on chosen swarm ship positions; nothing spawns.
// The page calls setPlayerState and setSwarmShips every step like the game does, then checks:
// (a) one step with slots 0 and 37 (two agents on slot 0, one on slot 37) alive and fresh, slot 5
//     alive with no agent near it, and slot 200 dead on an agent: the hit mask has exactly bits 0
//     and 37, the step counts 2 contact kills (one toucher per ship) in killsUnscored and none
//     scored, and the agents on slots 0 (one of two) and 37 are dead while slot 200's agent lives;
// (b) the next step with the same ships (no longer fresh): bits 0 and 37 stay set (persistent) and
//     nothing more dies, so a hit ship stays hit until the CPU uploads it dead;
// (c) slot 0 uploaded dead clears bit 0 and kills nothing (its second agent lives); uploaded again
//     alive and fresh, it hits that agent: bit 0 set again, one kill;
// (d) disarmed (setPlayerState invulnerable): a fresh ship on a new agent sets no bit and kills
//     nothing;
// (e) requestKillAll in a step that also spawns (so spawn-in agents exist when kill-all runs):
//     aliveTotal 0, killsUnscored > 0, killsSinceLastRead 0; the next frame killsUnscored is back
//     to 0 while the hit mask persists across the per-step clear;
// (f) recreateWithCapacity carries the persistent tail: the hit mask survives the rebuild;
// (g) the pickup blast (owner ruling R22) through a real Game (fake renderer and input) on a fresh
//     simulation whose species never move: after the start clear, BLAST_AGENT_COUNT agents seeded
//     on rings from 0.3 to 3 around the point and a pickup under it, one update collects it. Every
//     seeded agent inside pickupBlastRadius dies and every one outside lives, the blast step's
//     stats count them all in killsUnscored and none in killsSinceLastRead, the score stays 0,
//     and the next step kills nothing.
import { createGpuContext } from '/src/gpu/device.js';
import { AGENT_FLAG_ALIVE, AGENT_OFFSETS, AGENT_STRIDE_BYTES, ARENA_HEIGHT, ARENA_WIDTH, MAXIMUM_SWARM_SHIPS, SPECIES_COUNT } from '/src/sim/layout.js';
import { Simulation } from '/src/sim/simulation.js';
import { Game } from '/src/game/game.js';
import { SWARM_SHIP_RADIUS } from '/src/game/player-swarm.js';
import { InputState } from '/src/input/input.js';
import { defaultSpecies, normalizeShares } from '/src/sim/species.js';

const CAPACITY = 16384;
const GROWN_CAPACITY = 32768;
const STEP_SECONDS = 1 / 60;
const CLEAR_SPAWN = [200, 0, 0, 0, 0];
const READBACK_ATTEMPTS = 20;
const CENTER = [ARENA_WIDTH / 2, ARENA_HEIGHT / 2];
// Ship positions for the cases, far apart so no ship reaches another's agents.
const SPOTS = {
  slotZero: [4, 3],
  slotThirtySeven: [6, 3],
  slotFive: [8, 3],
  slotTwoHundred: [10, 3],
  disarmed: [12, 3],
};
// Agent slots: two on slot 0's spot, one each on slot 37's, slot 200's and the disarmed spot.
const AGENTS = [
  ['slotZero', 0], ['slotZero', 1], ['slotThirtySeven', 2], ['slotTwoHundred', 3], ['disarmed', 4],
];

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

function maskBits(mask) {
  const bits = [];
  mask.forEach((word, wordIndex) => {
    for (let bit = 0; bit < 32; bit += 1) if (((word >>> bit) & 1) === 1) bits.push(wordIndex * 32 + bit);
  });
  return bits;
}

// One swarm table entry per slot; ships maps a slot to { spot, fresh }.
function swarmTable(ships) {
  return Array.from({ length: MAXIMUM_SWARM_SHIPS }, (_, slot) => {
    const ship = ships[slot];
    if (ship === undefined) return { x: 0, y: 0, alive: false, fresh: false };
    const [x, y] = SPOTS[ship.spot];
    return { x, y, alive: ship.alive !== false, fresh: ship.fresh === true };
  });
}

class Harness {
  constructor(device, simulation) {
    this.device = device;
    this.simulation = simulation;
    this.collected = new Map();
    this.invulnerable = false;
  }

  seedAgents() {
    const bytes = new ArrayBuffer(this.simulation.capacity * AGENT_STRIDE_BYTES);
    const view = new DataView(bytes);
    for (const [spot, slot] of AGENTS) {
      const base = slot * AGENT_STRIDE_BYTES;
      view.setFloat32(base + AGENT_OFFSETS.position, SPOTS[spot][0], true);
      view.setFloat32(base + AGENT_OFFSETS.position + 4, SPOTS[spot][1], true);
      view.setUint32(base + AGENT_OFFSETS.species, 0, true);
      view.setUint32(base + AGENT_OFFSETS.flags, AGENT_FLAG_ALIVE, true);
    }
    this.device.queue.writeBuffer(this.simulation.agentsBuffer, 0, bytes);
  }

  // One step with this swarm table (player state set first, as the game does), submitted and
  // awaited; returns its stats.
  async step(ships = {}, spawnPerSpecies = new Uint32Array(SPECIES_COUNT)) {
    this.simulation.setPlayerState({ x: CENTER[0], y: CENTER[1], invulnerable: this.invulnerable });
    this.simulation.setSwarmShips(swarmTable(ships), SWARM_SHIP_RADIUS);
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

  // Alive flags of the seeded agent slots, in AGENTS order.
  async seededAlive() {
    const view = new DataView(await readBuffer(this.device, this.simulation.agentsBuffer));
    return AGENTS.map(([, slot]) => (view.getUint32(slot * AGENT_STRIDE_BYTES + AGENT_OFFSETS.flags, true) & AGENT_FLAG_ALIVE) !== 0);
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
  const simulation = await Simulation.create(gpu, { capacity: BLAST_CAPACITY, species, shares: normalizeShares([1, 1, 1, 1, 1]) });
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
  if (blastStats === undefined || nextStats === undefined) return [[false, `(g) no stats for the blast step ${blastSequence} or the one after it`]];
  const killed = distances.filter((distance, slot) => !alive[slot]).length;
  return [
    [game.state.armed === 'scatter', `(g) the pickup was collected (armed ${game.state.armed})`],
    [inside > 0 && aliveInside === 0, `(g) alive agents inside the blast radius ${radius}: ${aliveInside} of ${inside} (need 0)`],
    [deadOutside === 0, `(g) dead agents outside the blast radius ${deadOutside} (need 0)`],
    [blastStats.killsUnscored === killed && blastStats.killsSinceLastRead === 0, `(g) blast step killsUnscored ${blastStats.killsUnscored} (need ${killed}), killsSinceLastRead ${blastStats.killsSinceLastRead} (need 0)`],
    [nextStats.killsUnscored === 0 && nextStats.killsSinceLastRead === 0, `(g) next step kills ${nextStats.killsUnscored} unscored, ${nextStats.killsSinceLastRead} scored (need 0 and 0)`],
    [score === 0, `(g) score after the blast ${score} (need 0)`],
  ];
}

async function runCheck() {
  const gpu = await createGpuContext(document.getElementById('canvas'));
  const { device } = gpu;
  let lostReason = null;
  device.lost.then((info) => { lostReason = info.message || info.reason || 'lost'; });
  device.addEventListener('uncapturederror', (event) => { console.error(`uncaptured WebGPU error: ${event.error.message}`); });

  const still = defaultSpecies().map((row) => ({ ...row, maximumSpeed: 0 }));
  let simulation = await Simulation.create(gpu, { capacity: CAPACITY, species: still, shares: normalizeShares([1, 1, 1, 1, 1]) });
  const harness = new Harness(device, simulation);
  harness.seedAgents();
  const verdicts = [];
  const ships = {
    0: { spot: 'slotZero', fresh: true },
    37: { spot: 'slotThirtySeven', fresh: true },
    5: { spot: 'slotFive', fresh: true },
    200: { spot: 'slotTwoHundred', alive: false },
  };

  // (a) hits on the fresh ships.
  let stats = await harness.step(ships);
  let alive = await harness.seededAlive();
  verdicts.push([maskBits(stats.swarmHitMask).join(',') === '0,37', `(a) hit mask bits ${maskBits(stats.swarmHitMask).join(',')} (need 0,37)`]);
  verdicts.push([stats.killsUnscored === 2 && stats.killsSinceLastRead === 0, `(a) contact kills ${stats.killsUnscored} unscored, ${stats.killsSinceLastRead} scored (need 2 and 0)`]);
  verdicts.push([alive.join(',') === 'false,true,false,true,true' || alive.join(',') === 'true,false,false,true,true', `(a) seeded agents alive ${alive.join(',')} (need one of slot 0's two dead, slot 37's dead, the rest alive)`]);

  // (b) the bits persist and a hit ship stays hit.
  const steady = { 0: { spot: 'slotZero' }, 37: { spot: 'slotThirtySeven' }, 5: { spot: 'slotFive' } };
  stats = await harness.step(steady);
  verdicts.push([maskBits(stats.swarmHitMask).join(',') === '0,37' && stats.killsUnscored === 0, `(b) next step bits ${maskBits(stats.swarmHitMask).join(',')}, kills ${stats.killsUnscored} (need 0,37 and 0)`]);

  // (c) dead clears the bit; alive and fresh again hits the second agent.
  stats = await harness.step({ 37: { spot: 'slotThirtySeven' }, 5: { spot: 'slotFive' } });
  verdicts.push([maskBits(stats.swarmHitMask).join(',') === '37' && stats.killsUnscored === 0, `(c) slot 0 dead: bits ${maskBits(stats.swarmHitMask).join(',')}, kills ${stats.killsUnscored} (need 37 and 0)`]);
  stats = await harness.step({ ...steady, 0: { spot: 'slotZero', fresh: true } });
  alive = await harness.seededAlive();
  verdicts.push([maskBits(stats.swarmHitMask).join(',') === '0,37' && stats.killsUnscored === 1 && !alive[0] && !alive[1], `(c) slot 0 fresh again: bits ${maskBits(stats.swarmHitMask).join(',')}, kills ${stats.killsUnscored}, slot 0 agents alive ${alive[0]},${alive[1]} (need 0,37, 1 and both dead)`]);

  // (d) disarmed: no bit, no kill.
  harness.invulnerable = true;
  stats = await harness.step({ ...steady, 9: { spot: 'disarmed', fresh: true } });
  alive = await harness.seededAlive();
  verdicts.push([!maskBits(stats.swarmHitMask).includes(9) && stats.killsUnscored === 0 && alive[4], `(d) disarmed: bits ${maskBits(stats.swarmHitMask).join(',')}, kills ${stats.killsUnscored}, agent alive ${alive[4]} (need no bit 9, 0 and true)`]);
  harness.invulnerable = false;

  // (e) kill-all, in a step that also spawns.
  const aliveBeforeClear = stats.aliveTotal;
  simulation.requestKillAll();
  stats = await harness.step(steady, new Uint32Array(CLEAR_SPAWN));
  verdicts.push([stats.aliveTotal === 0, `(e) alive after kill-all ${stats.aliveTotal} (need 0)`]);
  verdicts.push([stats.killsUnscored > aliveBeforeClear, `(e) killsUnscored ${stats.killsUnscored} (need more than the ${aliveBeforeClear} alive before, spawned agents included)`]);
  verdicts.push([stats.killsSinceLastRead === 0, `(e) killsSinceLastRead ${stats.killsSinceLastRead} (need 0)`]);
  stats = await harness.step(steady);
  verdicts.push([stats.killsUnscored === 0 && stats.aliveTotal === 0, `(e) next frame killsUnscored ${stats.killsUnscored}, alive ${stats.aliveTotal} (need 0 and 0)`]);
  verdicts.push([maskBits(stats.swarmHitMask).join(',') === '0,37', `(e) hit mask ${maskBits(stats.swarmHitMask).join(',')} persists across the per-step clear (need 0,37)`]);

  // (f) the persistent tail survives a capacity rebuild.
  simulation = await simulation.recreateWithCapacity(GROWN_CAPACITY);
  harness.simulation = simulation;
  stats = await harness.step(steady);
  verdicts.push([maskBits(stats.swarmHitMask).join(',') === '0,37', `(f) hit mask after recreateWithCapacity ${maskBits(stats.swarmHitMask).join(',')} (need 0,37)`]);
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
