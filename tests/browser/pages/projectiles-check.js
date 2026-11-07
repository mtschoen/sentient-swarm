// Projectile collision check. A 65536-slot Simulation whose species all have maximumSpeed 0, so
// seeded agents never move, gets 10000 alive Chasers (species 0, no spawn-in frames) seeded in a
// 2 by 2 block from a fixed pseudo-random sequence; nothing spawns. Projectiles register as a
// Simulation pass. Each case reseeds the block and clears the projectiles, then checks:
// (a) one rail of radius 0.05 crossing the block diagonally at speed 20 for 0.3 s kills 200 to
//     2000, leaves no alive agent within 0.05 of its path, and is dead after its lifetime;
// (b) one bullet, then (reseeded) two identical bullets in the same frame on that path: the pair
//     kills exactly the single count (agents are motionless, so the kill set is geometric; no
//     double counting), and the particle pool cursor advances by PROJECTILE_KILL_PARTICLES per
//     kill (one splash per killed agent, never one per bullet);
// (c) with the block at x = 15.5 pinned against the right wall, a beam for one frame from (8, 3.5)
//     toward (16, 4.5) kills agents, leaves none within 0.09 of the ray, the frame's submit
//     completes with the device alive, and the frame after the beam is cleared kills nothing;
// (d) a pulseOrb fired into the block converts to a pulseRing (its slot reads kind 4); 0.1 s later
//     kills exist beyond 0.3 of the detonation point and every agent beyond the ring radius plus
//     0.1 is alive while no agent within the ring radius is (the band sweeps without gaps); the
//     ring slot is dead after its lifetime; stats ringsThisFrame is 1 in the detonation step only,
//     with lastRingX and lastRingY at the ring;
// (e) a sidewinder flying along the block's lower edge turns toward the block (positive y
//     velocity) and keeps its speed.
// Every case also asserts the stats kills sum equals the alive count drop (exact counting).
import { createGpuContext } from '/src/gpu/device.js';
import { Projectiles } from '/src/game/projectiles.js';
import { AGENT_FLAG_ALIVE, AGENT_OFFSETS, AGENT_STRIDE_BYTES, ARENA_HEIGHT, ARENA_WIDTH, SPECIES_COUNT } from '/src/sim/layout.js';
import { Simulation } from '/src/sim/simulation.js';
import { defaultSpecies } from '/src/sim/species.js';

const CAPACITY = 65536;
const AGENT_COUNT = 10000;
const BLOCK_HALF_SIZE = 1;
const STEP_SECONDS = 1 / 60;
const READBACK_ATTEMPTS = 20;
const KIND = { bullet: 0, rail: 2, pulseOrb: 3, pulseRing: 4 };
const PROJECTILE_STRIDE_BYTES = 48;
const PROJECTILE_OFFSETS = { position: 0, velocity: 16, radius: 24, lifetime: 28, kind: 32, flags: 36 };
const ARENA_INSET = 0.001;
// KILL_PARTICLE_COUNT in projectiles_collide.wgsl.
const PROJECTILE_KILL_PARTICLES = 4;
const CENTER = [ARENA_WIDTH / 2, ARENA_HEIGHT / 2];

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function distanceToSegment(point, start, end) {
  const along = [end[0] - start[0], end[1] - start[1]];
  const lengthSquared = along[0] * along[0] + along[1] * along[1];
  const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((point[0] - start[0]) * along[0] + (point[1] - start[1]) * along[1]) / lengthSquared));
  return Math.hypot(point[0] - start[0] - t * along[0], point[1] - start[1] - t * along[1]);
}

async function readBuffer(device, source) {
  const staging = device.createBuffer({ size: source.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const encoder = device.createCommandEncoder({ label: 'projectiles-check-readback' });
  encoder.copyBufferToBuffer(source, 0, staging, 0, source.size);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const copy = staging.getMappedRange().slice(0);
  staging.unmap();
  staging.destroy();
  return copy;
}

class Harness {
  constructor(device, simulation, projectiles) {
    this.device = device;
    this.simulation = simulation;
    this.projectiles = projectiles;
    this.collected = new Map();
  }

  // Writes AGENT_COUNT alive agents into the next step's input buffer, every other slot dead.
  // Positions are clamped just inside the arena; returns them as [x, y] pairs by slot.
  seedBlock(center) {
    const random = seededRandom(12345);
    const bytes = new ArrayBuffer(CAPACITY * AGENT_STRIDE_BYTES);
    const view = new DataView(bytes);
    const positions = [];
    for (let slot = 0; slot < AGENT_COUNT; slot += 1) {
      const x = Math.min(ARENA_WIDTH - ARENA_INSET, Math.max(ARENA_INSET, center[0] + (random() * 2 - 1) * BLOCK_HALF_SIZE));
      const y = Math.min(ARENA_HEIGHT - ARENA_INSET, Math.max(ARENA_INSET, center[1] + (random() * 2 - 1) * BLOCK_HALF_SIZE));
      const base = slot * AGENT_STRIDE_BYTES;
      view.setFloat32(base + AGENT_OFFSETS.position, x, true);
      view.setFloat32(base + AGENT_OFFSETS.position + 4, y, true);
      view.setUint32(base + AGENT_OFFSETS.species, 0, true);
      view.setUint32(base + AGENT_OFFSETS.flags, AGENT_FLAG_ALIVE, true);
      view.setFloat32(base + AGENT_OFFSETS.hueJitter, random() * 2 - 1, true);
      positions.push([x, y]);
    }
    this.device.queue.writeBuffer(this.simulation.agentsBuffer, 0, bytes);
    this.projectiles.clear();
    return positions;
  }

  // One step, submitted and awaited, then its stats (kept as lastStats); returns that frame's kills.
  async step() {
    const encoder = this.device.createCommandEncoder({ label: 'projectiles-check-frame' });
    this.simulation.step(encoder, STEP_SECONDS, new Uint32Array(SPECIES_COUNT));
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
    this.lastStats = stats;
    return stats.killsSinceLastRead;
  }

  async steps(count) {
    let kills = 0;
    for (let frame = 0; frame < count; frame += 1) kills += await this.step();
    return kills;
  }

  // Alive flags of the seeded slots in the newest agents buffer.
  async aliveFlags() {
    const view = new DataView(await readBuffer(this.device, this.simulation.agentsBuffer));
    return Array.from({ length: AGENT_COUNT }, (unused, slot) => (view.getUint32(slot * AGENT_STRIDE_BYTES + AGENT_OFFSETS.flags, true) & AGENT_FLAG_ALIVE) !== 0);
  }

  // The particle pool's spawn cursor (header word 0): every splash claims its particles here.
  async particleCursor() {
    const header = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder({ label: 'projectiles-check-cursor' });
    encoder.copyBufferToBuffer(this.simulation.particlePool.buffers.particles, 0, header, 0, 16);
    this.device.queue.submit([encoder.finish()]);
    await header.mapAsync(GPUMapMode.READ);
    const cursor = new Uint32Array(header.getMappedRange())[0];
    header.unmap();
    header.destroy();
    return cursor;
  }

  async projectileSlot(slot) {
    const view = new DataView(await readBuffer(this.device, this.projectiles.buffer));
    const base = slot * PROJECTILE_STRIDE_BYTES;
    return {
      position: [view.getFloat32(base + PROJECTILE_OFFSETS.position, true), view.getFloat32(base + PROJECTILE_OFFSETS.position + 4, true)],
      velocity: [view.getFloat32(base + PROJECTILE_OFFSETS.velocity, true), view.getFloat32(base + PROJECTILE_OFFSETS.velocity + 4, true)],
      radius: view.getFloat32(base + PROJECTILE_OFFSETS.radius, true),
      lifetime: view.getFloat32(base + PROJECTILE_OFFSETS.lifetime, true),
      kind: view.getUint32(base + PROJECTILE_OFFSETS.kind, true),
      alive: (view.getUint32(base + PROJECTILE_OFFSETS.flags, true) & 1) !== 0,
    };
  }
}

function verdictLine(verdicts) {
  return verdicts.map(([ok, text]) => `${ok ? 'PASS' : 'FAIL'} ${text}`).join('; ');
}

const SWEEP_SPEED = 20;
const SWEEP_LIFETIME = 0.3;
const SWEEP_ANGLE = 0.4;
const SWEEP_DIRECTION = [Math.cos(SWEEP_ANGLE), Math.sin(SWEEP_ANGLE)];
const SWEEP_START = [CENTER[0] - SWEEP_DIRECTION[0] * 3, CENTER[1] - SWEEP_DIRECTION[1] * 3];
const SWEEP_END = [CENTER[0] + SWEEP_DIRECTION[0] * 3, CENTER[1] + SWEEP_DIRECTION[1] * 3];
// 0.3 s of travel plus frames for the expiry to clear the slot.
const SWEEP_FRAMES = Math.ceil(SWEEP_LIFETIME / STEP_SECONDS) + 3;

function sweepSpawn(kind) {
  return {
    x: SWEEP_START[0], y: SWEEP_START[1],
    velocityX: SWEEP_DIRECTION[0] * SWEEP_SPEED, velocityY: SWEEP_DIRECTION[1] * SWEEP_SPEED,
    radius: 0.05, lifetime: SWEEP_LIFETIME, kind,
  };
}

async function runRailCase(harness) {
  const positions = harness.seedBlock(CENTER);
  const slot = harness.projectiles.queueSpawn(sweepSpawn(KIND.rail));
  const kills = await harness.steps(SWEEP_FRAMES);
  const alive = await harness.aliveFlags();
  const projectile = await harness.projectileSlot(slot);
  const dropped = alive.filter((flag) => !flag).length;
  const inGap = positions.filter((position, index) => alive[index] && distanceToSegment(position, SWEEP_START, SWEEP_END) <= 0.05).length;
  return verdictLine([
    [kills >= 200 && kills <= 2000, `(a) rail kills ${kills} (need 200 to 2000)`],
    [dropped === kills, `(a) alive drop ${dropped} equals kills`],
    [inGap === 0, `(a) alive agents within 0.05 of the path ${inGap} (need 0)`],
    [!projectile.alive, `(a) rail slot ${slot} dead after its lifetime`],
  ]);
}

async function runOverlapCase(harness) {
  harness.seedBlock(CENTER);
  harness.projectiles.queueSpawn(sweepSpawn(KIND.bullet));
  const single = await harness.steps(SWEEP_FRAMES);
  harness.seedBlock(CENTER);
  harness.projectiles.queueSpawn(sweepSpawn(KIND.bullet));
  harness.projectiles.queueSpawn(sweepSpawn(KIND.bullet));
  const cursorBefore = await harness.particleCursor();
  const double = await harness.steps(SWEEP_FRAMES);
  const cursorDelta = ((await harness.particleCursor()) - cursorBefore) >>> 0;
  const dropped = (await harness.aliveFlags()).filter((flag) => !flag).length;
  return verdictLine([
    [single > 0 && double === single, `(b) two overlapping bullets kill ${double}, one kills ${single} (need equal)`],
    [dropped === double, `(b) alive drop ${dropped} equals the pair's kills`],
    [cursorDelta === PROJECTILE_KILL_PARTICLES * double, `(b) particle cursor advanced ${cursorDelta} for the pair (need ${PROJECTILE_KILL_PARTICLES} per kill, ${PROJECTILE_KILL_PARTICLES * double})`],
  ]);
}

const WALL_CENTER = [15.5, CENTER[1]];
const BEAM_ORIGIN = [8, 3.5];
const BEAM_TARGET = [ARENA_WIDTH, 4.5];
const BEAM_HALF_WIDTH = 0.1;

async function runBeamCase(harness, isDeviceLost) {
  const positions = harness.seedBlock(WALL_CENTER);
  const length = Math.hypot(BEAM_TARGET[0] - BEAM_ORIGIN[0], BEAM_TARGET[1] - BEAM_ORIGIN[1]);
  const direction = [(BEAM_TARGET[0] - BEAM_ORIGIN[0]) / length, (BEAM_TARGET[1] - BEAM_ORIGIN[1]) / length];
  harness.projectiles.setBeam({ x: BEAM_ORIGIN[0], y: BEAM_ORIGIN[1], directionX: direction[0], directionY: direction[1], halfWidth: BEAM_HALF_WIDTH });
  const kills = await harness.step();
  harness.projectiles.setBeam(null);
  const alive = await harness.aliveFlags();
  const after = await harness.step();
  const rayEnd = [BEAM_ORIGIN[0] + direction[0] * 100, BEAM_ORIGIN[1] + direction[1] * 100];
  const inTrench = positions.filter((position, index) => alive[index] && distanceToSegment(position, BEAM_ORIGIN, rayEnd) <= 0.09).length;
  const dropped = alive.filter((flag) => !flag).length;
  return verdictLine([
    [kills > 0, `(c) beam kills ${kills} against the right wall (need > 0)`],
    [!isDeviceLost(), '(c) submit completed with the device alive'],
    [dropped === kills, `(c) alive drop ${dropped} equals kills`],
    [inTrench === 0, `(c) alive agents within 0.09 of the ray ${inTrench} (need 0)`],
    [after === 0, `(c) kills the frame after the beam cleared ${after} (need 0)`],
  ]);
}

const ORB_FRAME_LIMIT = 120;
const RING_CHECK_FRAMES = 6;
const RING_EXPIRY_FRAMES = 40;

async function runPulseCase(harness) {
  const positions = harness.seedBlock(CENTER);
  const slot = harness.projectiles.queueSpawn({ x: 5, y: CENTER[1], velocityX: 3, velocityY: 0, radius: 0.05, lifetime: 2, kind: KIND.pulseOrb, extra: 20 });
  let kills = 0;
  let projectile = null;
  let ringsBefore = 0;
  for (let frame = 0; frame < ORB_FRAME_LIMIT; frame += 1) {
    kills += await harness.step();
    projectile = await harness.projectileSlot(slot);
    if (projectile.kind === KIND.pulseRing) break;
    ringsBefore += harness.lastStats.ringsThisFrame;
  }
  if (projectile.kind !== KIND.pulseRing) return verdictLine([[false, `(d) orb slot ${slot} still kind ${projectile.kind} after ${ORB_FRAME_LIMIT} frames (need 4)`]]);
  const detonation = projectile.position;
  const ringStats = harness.lastStats;
  const ringAt = [ringStats.lastRingX, ringStats.lastRingY];
  const ringPositionError = Math.hypot(ringAt[0] - detonation[0], ringAt[1] - detonation[1]);
  kills += await harness.step();
  const ringsAfter = harness.lastStats.ringsThisFrame;
  kills += await harness.steps(RING_CHECK_FRAMES - 1);
  const ring = await harness.projectileSlot(slot);
  const alive = await harness.aliveFlags();
  const distances = positions.map((position) => Math.hypot(position[0] - detonation[0], position[1] - detonation[1]));
  const killedBeyond = distances.filter((distance, index) => !alive[index] && distance > 0.3).length;
  const deadOutside = distances.filter((distance, index) => !alive[index] && distance > ring.radius + 0.1).length;
  const aliveInside = distances.filter((distance, index) => alive[index] && distance <= ring.radius).length;
  const dropped = alive.filter((flag) => !flag).length;
  await harness.steps(RING_EXPIRY_FRAMES);
  const expired = await harness.projectileSlot(slot);
  return verdictLine([
    [true, `(d) orb converted to a ring at (${detonation[0].toFixed(2)}, ${detonation[1].toFixed(2)})`],
    [ringsBefore === 0 && ringStats.ringsThisFrame === 1 && ringsAfter === 0, `(d) stats ringsThisFrame ${ringsBefore} before, ${ringStats.ringsThisFrame} at, ${ringsAfter} after the detonation step (need 0, 1, 0)`],
    [ringPositionError < 1e-5, `(d) stats last ring position (${ringAt[0].toFixed(2)}, ${ringAt[1].toFixed(2)}) matches the ring (need within 1e-5)`],
    [killedBeyond > 0, `(d) kills beyond 0.3 of the detonation ${killedBeyond} (need > 0)`],
    [deadOutside === 0, `(d) dead agents beyond ring radius ${ring.radius.toFixed(3)} plus 0.1: ${deadOutside} (need 0)`],
    [aliveInside === 0, `(d) alive agents within the ring radius ${aliveInside} (need 0)`],
    [dropped === kills, `(d) alive drop ${dropped} equals kills ${kills}`],
    [!expired.alive, '(d) ring slot dead after its lifetime'],
  ]);
}

const SIDEWINDER_SPEED = 2;
const SIDEWINDER_FRAMES = 10;

async function runSidewinderCase(harness) {
  harness.seedBlock(CENTER);
  const slot = harness.projectiles.queueSpawn({ x: 7.5, y: 3.3, velocityX: SIDEWINDER_SPEED, velocityY: 0, radius: 0.02, lifetime: 1, kind: 5, extra: 2 });
  await harness.steps(SIDEWINDER_FRAMES);
  const sidewinder = await harness.projectileSlot(slot);
  const speed = Math.hypot(...sidewinder.velocity);
  return verdictLine([
    [sidewinder.velocity[1] > 0.1 * SIDEWINDER_SPEED, `(e) sidewinder velocity (${sidewinder.velocity.map((value) => value.toFixed(3)).join(', ')}) turned toward the block`],
    [Math.abs(speed - SIDEWINDER_SPEED) < 1e-3, `(e) sidewinder speed ${speed.toFixed(4)} kept`],
  ]);
}

async function runCheck() {
  const gpu = await createGpuContext(document.getElementById('canvas'));
  const { device } = gpu;
  let lostReason = null;
  device.lost.then((info) => { lostReason = info.message || info.reason || 'lost'; });
  device.addEventListener('uncapturederror', (event) => { console.error(`uncaptured WebGPU error: ${event.error.message}`); });

  const species = defaultSpecies().map((row) => ({ ...row, maximumSpeed: 0 }));
  const simulation = await Simulation.create(gpu, { capacity: CAPACITY, species });
  simulation.setPlayer(1, 1);
  const projectiles = await Projectiles.create(gpu, {});
  simulation.registerPass((encoder, context) => projectiles.encode(encoder, context));
  const harness = new Harness(device, simulation, projectiles);
  const lines = [];
  for (const run of [runRailCase, runOverlapCase, (target) => runBeamCase(target, () => lostReason !== null), runPulseCase, runSidewinderCase]) {
    lines.push(await run(harness));
    if (lostReason !== null) return { pass: false, detail: `device lost: ${lostReason}; ${lines.join('; ')}` };
  }
  simulation.destroy();
  projectiles.destroy();
  const detail = lines.join('; ');
  return { pass: !detail.includes('FAIL'), detail };
}

runCheck().then(
  (result) => { window.__projectilesCheck = result; },
  (error) => { window.__projectilesCheck = { pass: false, detail: `exception: ${error.message}` }; },
);
