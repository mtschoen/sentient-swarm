// Over 500 lines: every projectile case shares the one seeded harness and readback helpers here.
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
// (d) a pulseOrb fired into the block converts to a pulseRing (its slot reads the pulseRing
//     kind); 0.1 s later kills exist beyond 0.3 of the detonation point and every agent beyond
//     the ring radius plus 0.1 is alive while no agent within the ring radius is (the band
//     sweeps without gaps); the ring slot is dead after its lifetime; stats ringsThisFrame is 1
//     in the detonation step only, with lastRingX and lastRingY at the ring;
// (e) a sidewinder flying along the block's lower edge turns toward the block (positive y
//     velocity) and keeps its speed;
// (f) swept beam: agents spread uniformly over radii 1 to 6 from the ship at (4, 4.5) and angles
//     within 70 degrees of +x; the beam holds at -45 degrees for one step, then jumps to +45 for
//     one step. Every one of 18 angular bins across the 90 degree wedge has kills, no agent inside
//     the wedge survives, and every agent farther than the half width from the wedge survives.
//     Control: a straight beam at 0 degrees for one step, then (reseeded) 0 then 1 degree: the
//     1 degree sweep kills exactly the agents within the half width of its sector, which is no
//     more than the straight beam plus the sliver and the padding past its far edge. Prints the
//     histogram.
// (g) one base-gun energy ball (WEAPON_TYPES.base tier 1) fired diagonally (the capsule walk's
//     widest heading) through the block kills along a tunnel: no alive agent within its radius of
//     the path (no cell skipped by CAPSULE_CELL_BUDGET), no dead agent beyond its kill reach, and
//     kills farther than twice the Plan B bullet's reach (0.04 + 0.02) from the path, so the
//     tunnel is at least twice the old one wide.
// (h) lab base gun kill budget (task C6b): with setBaseKillBudget(7) the same energy ball kills
//     exactly 7 and its slot dies at once; the budget then returns to 0 (unlimited).
// (i) lab beam sweep budget: with setBeamSweepThreshold(15) the (f) sweep of 90 degrees in one
//     step has reach scale 0.25 (the floor), so off the first step's full-length line no agent
//     dies farther than the reach limit plus the half width from the ship, and some die inside it.
// (j) final pulse orb segment: an orb that expires on its first step still kills an agent on the
//     segment it flew that step, before it converts to a ring.
// (k) beam reversal: a ship at the arena center with agents spread uniformly over radii 1 to 4 on
//     the full circle; the beam holds at +x for one step, then points exactly -x (and, reseeded,
//     -x then +x): a 180 degree turn in one step. Each reversal takes the counterclockwise half
//     disc from the previous direction, so it kills the half below then the half above, 18 bins of
//     10 degrees each with no empty bin, no alive agent inside the half, no dead agent farther than
//     the half width from it (the padding along the shared diameter).
// (l) mixed bullets: two overlapping bullets of different radius and speed spawned in one frame kill
//     exactly the union of the two kill sets each makes alone (the sets differ both ways: the wide
//     slow one kills the wider tunnel, the narrow fast one kills farther along), with the alive drop
//     equal to the kills and one particle burst per killed agent.
// Every case also asserts the stats kills sum equals the alive count drop (exact counting).
import { createGpuContext } from '/src/gpu/device.js';
import { Projectiles } from '/src/game/projectiles.js';
import { AGENT_FLAG_ALIVE, AGENT_OFFSETS, AGENT_STRIDE_BYTES, ARENA_HEIGHT, ARENA_WIDTH, PROJECTILE_FLAG_ALIVE, SPECIES_COUNT } from '/src/sim/layout.js';
import { Simulation } from '/src/sim/simulation.js';
import { DEFAULT_KILL_BURST_PARTICLES, DEFAULT_KILL_FRAGMENT_PARTICLES } from '/src/sim/params.js';
import { defaultSpecies } from '/src/sim/species.js';
import { PROJECTILE_KINDS, WEAPON_TYPES } from '/src/game/weaponTypes.js';

const CAPACITY = 65536;
const AGENT_COUNT = 10000;
const BLOCK_HALF_SIZE = 1;
const STEP_SECONDS = 1 / 60;
const READBACK_ATTEMPTS = 20;
const PROJECTILE_STRIDE_BYTES = 48;
const PROJECTILE_OFFSETS = { position: 0, velocity: 16, radius: 24, lifetime: 28, kind: 32, flags: 36 };
const ARENA_INSET = 0.001;
// Every kill's burst: params.killBurstParticles at its default (the pool has room for all of them here).
const PROJECTILE_KILL_PARTICLES = DEFAULT_KILL_BURST_PARTICLES + DEFAULT_KILL_FRAGMENT_PARTICLES;
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
    const positions = Array.from({ length: AGENT_COUNT }, () => [
      Math.min(ARENA_WIDTH - ARENA_INSET, Math.max(ARENA_INSET, center[0] + (random() * 2 - 1) * BLOCK_HALF_SIZE)),
      Math.min(ARENA_HEIGHT - ARENA_INSET, Math.max(ARENA_INSET, center[1] + (random() * 2 - 1) * BLOCK_HALF_SIZE)),
    ]);
    return this.seedPositions(positions, random);
  }

  // Writes the given [x, y] positions as alive agents (at most AGENT_COUNT), every other slot dead.
  seedPositions(positions, random = seededRandom(54321)) {
    const bytes = new ArrayBuffer(CAPACITY * AGENT_STRIDE_BYTES);
    const view = new DataView(bytes);
    positions.forEach(([x, y], slot) => {
      const base = slot * AGENT_STRIDE_BYTES;
      view.setFloat32(base + AGENT_OFFSETS.position, x, true);
      view.setFloat32(base + AGENT_OFFSETS.position + 4, y, true);
      view.setUint32(base + AGENT_OFFSETS.species, 0, true);
      view.setUint32(base + AGENT_OFFSETS.flags, AGENT_FLAG_ALIVE, true);
      view.setFloat32(base + AGENT_OFFSETS.hueJitter, random() * 2 - 1, true);
    });
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
      alive: (view.getUint32(base + PROJECTILE_OFFSETS.flags, true) & PROJECTILE_FLAG_ALIVE) !== 0,
    };
  }
}

// One case's result: pass only when every verdict holds; detail is the PASS or FAIL text.
function verdictLine(verdicts) {
  return {
    pass: verdicts.every(([ok]) => ok),
    detail: verdicts.map(([ok, text]) => `${ok ? 'PASS' : 'FAIL'} ${text}`).join('; '),
  };
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
  const slot = harness.projectiles.queueSpawn(sweepSpawn(PROJECTILE_KINDS.rail));
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
  harness.projectiles.queueSpawn(sweepSpawn(PROJECTILE_KINDS.bullet));
  const single = await harness.steps(SWEEP_FRAMES);
  harness.seedBlock(CENTER);
  harness.projectiles.queueSpawn(sweepSpawn(PROJECTILE_KINDS.bullet));
  harness.projectiles.queueSpawn(sweepSpawn(PROJECTILE_KINDS.bullet));
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

// (l) Two overlapping bullets that differ in radius and speed: the first is narrow and fast (it
// flies 6 units through the block), the second wide and slow (3 units, so it dies at the block's
// middle), so neither kill set contains the other.
const MIXED_NARROW = { ...sweepSpawn(PROJECTILE_KINDS.bullet) };
const MIXED_WIDE = {
  ...sweepSpawn(PROJECTILE_KINDS.bullet),
  radius: 0.12,
  lifetime: 0.2,
  velocityX: SWEEP_DIRECTION[0] * 15,
  velocityY: SWEEP_DIRECTION[1] * 15,
};

async function killedSlots(harness, spawns) {
  harness.seedBlock(CENTER);
  for (const spawn of spawns) harness.projectiles.queueSpawn(spawn);
  const cursorBefore = await harness.particleCursor();
  const kills = await harness.steps(SWEEP_FRAMES);
  const cursorDelta = ((await harness.particleCursor()) - cursorBefore) >>> 0;
  const alive = await harness.aliveFlags();
  return { kills, cursorDelta, alive, killed: new Set(alive.flatMap((flag, slot) => (flag ? [] : [slot]))) };
}

async function runMixedBulletsCase(harness) {
  const narrow = await killedSlots(harness, [MIXED_NARROW]);
  const wide = await killedSlots(harness, [MIXED_WIDE]);
  const both = await killedSlots(harness, [MIXED_NARROW, MIXED_WIDE]);
  const union = new Set([...narrow.killed, ...wide.killed]);
  const sameSet = both.killed.size === union.size && [...union].every((slot) => both.killed.has(slot));
  const wideOnly = [...wide.killed].filter((slot) => !narrow.killed.has(slot)).length;
  const narrowOnly = [...narrow.killed].filter((slot) => !wide.killed.has(slot)).length;
  return verdictLine([
    [wideOnly > 0 && narrowOnly > 0, `(l) the kill sets differ both ways: ${wideOnly} only the wide bullet's, ${narrowOnly} only the narrow one's (need both > 0)`],
    [sameSet, `(l) the pair kills ${both.killed.size}, the union of the two alone is ${union.size} (${narrow.killed.size} and ${wide.killed.size}; need the same agents)`],
    [both.kills === both.killed.size, `(l) stats kills ${both.kills} equal the alive drop ${both.killed.size}`],
    [both.cursorDelta === PROJECTILE_KILL_PARTICLES * both.kills, `(l) particle cursor advanced ${both.cursorDelta} for the pair (need ${PROJECTILE_KILL_PARTICLES} per kill, ${PROJECTILE_KILL_PARTICLES * both.kills})`],
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
  const slot = harness.projectiles.queueSpawn({ x: 5, y: CENTER[1], velocityX: 3, velocityY: 0, radius: 0.05, lifetime: 2, kind: PROJECTILE_KINDS.pulseOrb, extra: 20 });
  let kills = 0;
  let projectile = null;
  let ringsBefore = 0;
  for (let frame = 0; frame < ORB_FRAME_LIMIT; frame += 1) {
    kills += await harness.step();
    projectile = await harness.projectileSlot(slot);
    if (projectile.kind === PROJECTILE_KINDS.pulseRing) break;
    ringsBefore += harness.lastStats.ringsThisFrame;
  }
  if (projectile.kind !== PROJECTILE_KINDS.pulseRing) return verdictLine([[false, `(d) orb slot ${slot} still kind ${projectile.kind} after ${ORB_FRAME_LIMIT} frames (need ${PROJECTILE_KINDS.pulseRing})`]]);
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
    [projectile.kind === PROJECTILE_KINDS.pulseRing, `(d) orb converted to a ring at (${detonation[0].toFixed(2)}, ${detonation[1].toFixed(2)})`],
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
// Relative: the SwiftShader adapter measured 1.9975 against 2.0000 (hardware gives 2.0000).
const SIDEWINDER_SPEED_TOLERANCE = 0.005;

async function runSidewinderCase(harness) {
  harness.seedBlock(CENTER);
  const slot = harness.projectiles.queueSpawn({ x: 7.5, y: 3.3, velocityX: SIDEWINDER_SPEED, velocityY: 0, radius: 0.02, lifetime: 1, kind: PROJECTILE_KINDS.sidewinder, extra: 2 });
  await harness.steps(SIDEWINDER_FRAMES);
  const sidewinder = await harness.projectileSlot(slot);
  const speed = Math.hypot(...sidewinder.velocity);
  return verdictLine([
    [sidewinder.velocity[1] > 0.1 * SIDEWINDER_SPEED, `(e) sidewinder velocity (${sidewinder.velocity.map((value) => value.toFixed(3)).join(', ')}) turned toward the block`],
    [Math.abs(speed - SIDEWINDER_SPEED) < SIDEWINDER_SPEED * SIDEWINDER_SPEED_TOLERANCE, `(e) sidewinder speed ${speed.toFixed(4)} kept`],
  ]);
}

const SWEEP_ORIGIN = [4, 4.5];
const SWEEP_HALF_WIDTH = 0.1;
const WEDGE_FIRST_DEGREES = -45;
const WEDGE_LAST_DEGREES = 45;
const SEED_MARGIN_DEGREES = 25;
const WEDGE_BINS = 18;
const SWEEP_RADII = [1, 6];
// Float tolerance on the half width when splitting agents into must-die and must-live sets.
const SWEEP_TOLERANCE = 1e-4;
const toRadians = (degrees) => (degrees * Math.PI) / 180;

// Positions uniform by area over radii SWEEP_RADII and the wedge widened by SEED_MARGIN_DEGREES,
// inside the arena, rounded to float32 like the agents buffer.
function wedgePositions() {
  const random = seededRandom(777);
  const positions = [];
  while (positions.length < AGENT_COUNT) {
    const radius = Math.sqrt(SWEEP_RADII[0] ** 2 + random() * (SWEEP_RADII[1] ** 2 - SWEEP_RADII[0] ** 2));
    const angle = toRadians(WEDGE_FIRST_DEGREES - SEED_MARGIN_DEGREES + random() * (WEDGE_LAST_DEGREES - WEDGE_FIRST_DEGREES + 2 * SEED_MARGIN_DEGREES));
    const x = Math.fround(SWEEP_ORIGIN[0] + Math.cos(angle) * radius);
    const y = Math.fround(SWEEP_ORIGIN[1] + Math.sin(angle) * radius);
    if (x > ARENA_INSET && x < ARENA_WIDTH - ARENA_INSET && y > ARENA_INSET && y < ARENA_HEIGHT - ARENA_INSET) positions.push([x, y]);
  }
  return positions;
}

const angleOf = (position) => Math.atan2(position[1] - SWEEP_ORIGIN[1], position[0] - SWEEP_ORIGIN[0]);

// Distance from position to the sector from the origin between the angles (radians, first below
// last, under 180 degrees apart) out to a radius past every seeded agent: 0 inside, else the
// distance to the nearer edge ray.
function distanceToWedge(position, first, last) {
  const angle = angleOf(position);
  if (angle >= first && angle <= last) return 0;
  const reach = 100;
  const edge = (theta) => [SWEEP_ORIGIN[0] + Math.cos(theta) * reach, SWEEP_ORIGIN[1] + Math.sin(theta) * reach];
  return Math.min(distanceToSegment(position, SWEEP_ORIGIN, edge(first)), distanceToSegment(position, SWEEP_ORIGIN, edge(last)));
}

async function fireBeamSteps(harness, anglesDegrees) {
  let kills = 0;
  for (const degrees of anglesDegrees) {
    const angle = toRadians(degrees);
    harness.projectiles.setBeam({ x: SWEEP_ORIGIN[0], y: SWEEP_ORIGIN[1], directionX: Math.cos(angle), directionY: Math.sin(angle), halfWidth: SWEEP_HALF_WIDTH });
    kills += await harness.step();
  }
  harness.projectiles.setBeam(null);
  kills += await harness.step();
  return kills;
}

async function runSweptBeamCase(harness) {
  const positions = wedgePositions();
  harness.seedPositions(positions);
  const kills = await fireBeamSteps(harness, [WEDGE_FIRST_DEGREES, WEDGE_LAST_DEGREES]);
  const alive = await harness.aliveFlags();
  const first = toRadians(WEDGE_FIRST_DEGREES);
  const last = toRadians(WEDGE_LAST_DEGREES);
  const histogram = new Array(WEDGE_BINS).fill(0);
  positions.forEach((position, index) => {
    const fraction = (angleOf(position) - first) / (last - first);
    if (!alive[index] && fraction >= 0 && fraction < 1) histogram[Math.floor(fraction * WEDGE_BINS)] += 1;
  });
  const distances = positions.map((position) => distanceToWedge(position, first, last));
  const aliveInside = distances.filter((distance, index) => alive[index] && distance === 0).length;
  const deadOutside = distances.filter((distance, index) => !alive[index] && distance > SWEEP_HALF_WIDTH + SWEEP_TOLERANCE).length;
  const dropped = alive.filter((flag) => !flag).length;

  harness.seedPositions(positions);
  const straight = await fireBeamSteps(harness, [0]);
  harness.seedPositions(positions);
  const narrow = await fireBeamSteps(harness, [0, 1]);
  const narrowDistances = positions.map((position) => distanceToWedge(position, 0, toRadians(1)));
  const mustDie = narrowDistances.filter((distance) => distance <= SWEEP_HALF_WIDTH - SWEEP_TOLERANCE).length;
  const mayDie = narrowDistances.filter((distance) => distance <= SWEEP_HALF_WIDTH + SWEEP_TOLERANCE).length;
  // The sweep's addition: agents within the half width of the 1 degree sector (the sliver plus the
  // padding past its far edge) that the straight beam at 0 degrees leaves alive.
  const added = positions.filter((position, index) => narrowDistances[index] <= SWEEP_HALF_WIDTH + SWEEP_TOLERANCE && distanceToWedge(position, 0, 0) > SWEEP_HALF_WIDTH - SWEEP_TOLERANCE).length;
  return verdictLine([
    [histogram.every((count) => count > 0), `(f) swept kill histogram over ${WEDGE_BINS} bins of ${(WEDGE_LAST_DEGREES - WEDGE_FIRST_DEGREES) / WEDGE_BINS} degrees [${histogram.join(' ')}] (need no empty bin)`],
    [aliveInside === 0, `(f) alive agents inside the swept wedge ${aliveInside} (need 0)`],
    [deadOutside === 0, `(f) dead agents beyond the half width ${SWEEP_HALF_WIDTH} of the wedge ${deadOutside} (need 0)`],
    [dropped === kills, `(f) alive drop ${dropped} equals kills ${kills}`],
    [narrow >= mustDie && narrow <= mayDie, `(f) 1 degree sweep kills ${narrow} (need the ${mustDie} to ${mayDie} agents within the half width of its sector)`],
    [straight > 0 && narrow <= straight + added, `(f) 1 degree sweep kills ${narrow}, straight beam ${straight} plus the sliver and padding's ${added} (need no more)`],
  ]);
}

// The Plan B base bullet's kill reach: radius 0.04 plus CAPSULE_KILL_MARGIN 0.02.
const OLD_BULLET_REACH = 0.06;
const KILL_MARGIN = 0.02;
const REACH_TOLERANCE = 1e-3;
const BALL_ANGLE = Math.PI / 4;
const BALL_FRAME_LIMIT = 240;

async function runEnergyBallCase(harness) {
  const positions = harness.seedBlock(CENTER);
  const ball = WEAPON_TYPES.base.tiers[0];
  const direction = [Math.cos(BALL_ANGLE), Math.sin(BALL_ANGLE)];
  const start = [CENTER[0] - direction[0] * 2.5, CENTER[1] - direction[1] * 2.5];
  const pathEnd = [start[0] + direction[0] * 20, start[1] + direction[1] * 20];
  const slot = harness.projectiles.queueSpawn({
    x: start[0], y: start[1], velocityX: direction[0] * ball.speed, velocityY: direction[1] * ball.speed,
    radius: ball.radius, lifetime: ball.lifetime, kind: PROJECTILE_KINDS.bullet,
  });
  let kills = 0;
  let frames = 0;
  for (; frames < BALL_FRAME_LIMIT; frames += 1) {
    kills += await harness.step();
    if (!(await harness.projectileSlot(slot)).alive) break;
  }
  const alive = await harness.aliveFlags();
  const distances = positions.map((position) => distanceToSegment(position, start, pathEnd));
  const reach = ball.radius + KILL_MARGIN;
  const aliveInside = distances.filter((distance, index) => alive[index] && distance <= ball.radius).length;
  const deadOutside = distances.filter((distance, index) => !alive[index] && distance > reach + REACH_TOLERANCE).length;
  const widest = distances.reduce((maximum, distance, index) => (alive[index] ? maximum : Math.max(maximum, distance)), 0);
  const dropped = alive.filter((flag) => !flag).length;
  return verdictLine([
    [frames < BALL_FRAME_LIMIT, `(g) energy ball (radius ${ball.radius}, speed ${ball.speed}) dead after ${frames} frames (need under ${BALL_FRAME_LIMIT})`],
    [kills > 0 && dropped === kills, `(g) energy ball kills ${kills}, alive drop ${dropped} (need equal and > 0)`],
    [aliveInside === 0, `(g) alive agents within the ball radius of its path ${aliveInside} (need 0)`],
    [deadOutside === 0, `(g) dead agents beyond the kill reach ${reach.toFixed(3)} ${deadOutside} (need 0)`],
    [widest > 2 * OLD_BULLET_REACH, `(g) tunnel half width ${widest.toFixed(3)}, ${(widest / OLD_BULLET_REACH).toFixed(2)} times the old bullet reach (need over 2)`],
  ]);
}

const BUDGET_KILLS = 7;

async function runKillBudgetCase(harness) {
  harness.seedBlock(CENTER);
  harness.projectiles.setBaseKillBudget(BUDGET_KILLS);
  const ball = WEAPON_TYPES.base.tiers[0];
  const direction = [Math.cos(BALL_ANGLE), Math.sin(BALL_ANGLE)];
  const slot = harness.projectiles.queueSpawn({
    x: CENTER[0] - direction[0] * 1.5, y: CENTER[1] - direction[1] * 1.5, velocityX: direction[0] * ball.speed, velocityY: direction[1] * ball.speed,
    radius: ball.radius, lifetime: ball.lifetime, kind: PROJECTILE_KINDS.bullet,
  });
  let kills = 0;
  let frames = 0;
  for (; frames < BALL_FRAME_LIMIT; frames += 1) {
    kills += await harness.step();
    if (!(await harness.projectileSlot(slot)).alive) break;
  }
  harness.projectiles.setBaseKillBudget(0);
  const dropped = (await harness.aliveFlags()).filter((flag) => !flag).length;
  return verdictLine([
    [kills === BUDGET_KILLS && dropped === kills, `(h) budgeted ball kills ${kills}, alive drop ${dropped} (need ${BUDGET_KILLS})`],
    [frames < 10, `(h) budgeted ball dead after ${frames + 1} frames (need under 11, it dies when the budget is spent)`],
  ]);
}

const SWEEP_BUDGET_DEGREES = 15;
const SWEEP_MINIMUM_SCALE = 0.25;

async function runSweepBudgetCase(harness) {
  const positions = wedgePositions();
  harness.seedPositions(positions);
  harness.projectiles.setBeamSweepThreshold(SWEEP_BUDGET_DEGREES);
  const kills = await fireBeamSteps(harness, [WEDGE_FIRST_DEGREES, WEDGE_LAST_DEGREES]);
  harness.projectiles.setBeamSweepThreshold(0);
  const alive = await harness.aliveFlags();
  const last = toRadians(WEDGE_LAST_DEGREES);
  // distanceToArenaEdge along the current (last) direction from the ship.
  const edge = Math.min((ARENA_WIDTH - SWEEP_ORIGIN[0]) / Math.cos(last), (ARENA_HEIGHT - SWEEP_ORIGIN[1]) / Math.sin(last));
  const limit = SWEEP_MINIMUM_SCALE * edge;
  // The first step is a line at full reach (no previous direction): agents on its ray may die.
  const first = toRadians(WEDGE_FIRST_DEGREES);
  const firstLength = Math.min((ARENA_WIDTH - SWEEP_ORIGIN[0]) / Math.cos(first), SWEEP_ORIGIN[1] / -Math.sin(first));
  const firstEnd = [SWEEP_ORIGIN[0] + Math.cos(first) * firstLength, SWEEP_ORIGIN[1] + Math.sin(first) * firstLength];
  const farDead = positions.filter((position, index) => !alive[index]
    && distanceToSegment(position, SWEEP_ORIGIN, firstEnd) > SWEEP_HALF_WIDTH + SWEEP_TOLERANCE
    && Math.hypot(position[0] - SWEEP_ORIGIN[0], position[1] - SWEEP_ORIGIN[1]) > limit + SWEEP_HALF_WIDTH + SWEEP_TOLERANCE).length;
  const dropped = alive.filter((flag) => !flag).length;
  return verdictLine([
    [kills > 0 && dropped === kills, `(i) sweep budget kills ${kills}, alive drop ${dropped} (need equal and > 0)`],
    [farDead === 0, `(i) dead agents past the reach limit ${limit.toFixed(3)} plus the half width ${farDead} (need 0)`],
  ]);
}

const FINAL_SEGMENT_SPEED = 30;
const FINAL_SEGMENT_START = [4, 4.5];
const FINAL_SEGMENT_AGENT_OFFSET = 0.1;

// (j) An orb that expires in its first step converts to a ring there; the segment it flew on that
// step (0.5 long, far longer than the ring's start radius) must still kill the agent on it.
async function runFinalSegmentCase(harness) {
  harness.seedPositions([[FINAL_SEGMENT_START[0] + FINAL_SEGMENT_AGENT_OFFSET, FINAL_SEGMENT_START[1]]]);
  harness.projectiles.queueSpawn({ x: FINAL_SEGMENT_START[0], y: FINAL_SEGMENT_START[1], velocityX: FINAL_SEGMENT_SPEED, velocityY: 0, radius: 0.05, lifetime: 0.001, kind: PROJECTILE_KINDS.pulseOrb, extra: 1000 });
  const kills = await harness.step();
  const alive = await harness.aliveFlags();
  return verdictLine([
    [kills === 1 && !alive[0], `(j) pulse orb kills agents on its final segment: kills ${kills}, agent alive ${alive[0]} (need 1, false)`],
  ]);
}

const REVERSAL_RADII = [1, 4];
const REVERSAL_BINS = 18;

// Positions uniform by area over radii REVERSAL_RADII on the full circle around the arena center.
function ringPositions() {
  const random = seededRandom(4242);
  return Array.from({ length: AGENT_COUNT }, () => {
    const radius = Math.sqrt(REVERSAL_RADII[0] ** 2 + random() * (REVERSAL_RADII[1] ** 2 - REVERSAL_RADII[0] ** 2));
    const angle = random() * 2 * Math.PI;
    return [Math.fround(CENTER[0] + Math.cos(angle) * radius), Math.fround(CENTER[1] + Math.sin(angle) * radius)];
  });
}

// One beam step along `first`, then one along `second` (exact unit vectors, so the turn is exactly
// 180 degrees), then the frame after the beam stops; returns the kills.
async function fireBeamDirections(harness, first, second) {
  let kills = 0;
  for (const [directionX, directionY] of [first, second]) {
    harness.projectiles.setBeam({ x: CENTER[0], y: CENTER[1], directionX, directionY, halfWidth: SWEEP_HALF_WIDTH });
    kills += await harness.step();
  }
  harness.projectiles.setBeam(null);
  return kills + await harness.step();
}

// A reversal sweeps the counterclockwise half disc from the previous direction: from +x that is the
// half with y above the ship (side 1), from -x the half below it (side -1). Returns its verdicts.
async function reversalVerdicts(harness, positions, { label, first, second, side }) {
  harness.seedPositions(positions);
  const kills = await fireBeamDirections(harness, first, second);
  const alive = await harness.aliveFlags();
  const histogram = new Array(REVERSAL_BINS).fill(0);
  let aliveInside = 0;
  let deadOutside = 0;
  positions.forEach((position, index) => {
    const offset = (position[1] - CENTER[1]) * side;
    if (offset >= 0 && alive[index]) aliveInside += 1;
    // Outside the half disc the nearest point is on the diameter, which the beam's two rays cover.
    if (offset < 0 && !alive[index] && -offset > SWEEP_HALF_WIDTH + SWEEP_TOLERANCE) deadOutside += 1;
    if (offset > 0 && !alive[index]) {
      const fraction = Math.atan2(offset, (position[0] - CENTER[0]) * side) / Math.PI;
      histogram[Math.min(REVERSAL_BINS - 1, Math.floor(fraction * REVERSAL_BINS))] += 1;
    }
  });
  const dropped = alive.filter((flag) => !flag).length;
  return [
    [histogram.every((count) => count > 0), `(k) ${label} kill histogram over ${REVERSAL_BINS} bins [${histogram.join(' ')}] (need no empty bin)`],
    [aliveInside === 0, `(k) ${label} alive agents inside the half disc ${aliveInside} (need 0)`],
    [deadOutside === 0, `(k) ${label} dead agents beyond the half width ${SWEEP_HALF_WIDTH} of it ${deadOutside} (need 0)`],
    [dropped === kills, `(k) ${label} alive drop ${dropped} equals kills ${kills}`],
  ];
}

async function runBeamReversalCase(harness) {
  const positions = ringPositions();
  const above = await reversalVerdicts(harness, positions, { label: '+x to -x (half above the ship)', first: [1, 0], second: [-1, 0], side: 1 });
  const below = await reversalVerdicts(harness, positions, { label: '-x to +x (half below the ship)', first: [-1, 0], second: [1, 0], side: -1 });
  return verdictLine([...above, ...below]);
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
  const entries = [];
  for (const run of [runRailCase, runOverlapCase, (target) => runBeamCase(target, () => lostReason !== null), runPulseCase, runSidewinderCase, runSweptBeamCase, runEnergyBallCase, runKillBudgetCase, runSweepBudgetCase, runFinalSegmentCase, runBeamReversalCase, runMixedBulletsCase]) {
    entries.push(await run(harness));
    if (lostReason !== null) return { pass: false, detail: `device lost: ${lostReason}; ${entries.map((entry) => entry.detail).join('; ')}` };
  }
  simulation.destroy();
  projectiles.destroy();
  return { pass: entries.every((entry) => entry.pass), detail: entries.map((entry) => entry.detail).join('; ') };
}

runCheck().then(
  (result) => { window.__projectilesCheck = result; },
  (error) => { window.__projectilesCheck = { pass: false, detail: `exception: ${error.message}` }; },
);
