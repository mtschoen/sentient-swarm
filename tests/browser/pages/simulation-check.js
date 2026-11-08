// Steps a 65536-slot Simulation fed by SpawnPressure for 300 frames at dt 1/60, awaiting the GPU
// and polling the stats ring after every submit (stats lag one step), and checks: (a) the alive total tracks the ramping target (0.6 to 1.02
// of it) and never exceeds what was requested (no double-spent budget); (b) every species holds
// its share within 10 percent relative; (c) the read-back frameSequence lags the CPU frame by at
// most 3; (d) after frame 1 every agent was spawned that frame: it sits at least ARENA_WIDTH / 4
// from the player and within the default spawn band of a wall (task C0b) with 29 spawn-in frames left, in-range species, phase and hueJitter, and zero
// velocity unless integrate's wall spring already pushed it (inside WALL_MARGIN of an edge);
// (e) recreateWithCapacity(131072) keeps at least 95 percent of the alive agents after one more step;
// (f) a one-frame debug kill of radius 2 at the arena center, with zero spawning, reports kills, drops
// aliveTotal by exactly that many, reports zero kills a frame later, fills at least DEFAULT_KILL_BURST_PARTICLES particle slots
// per kill (12, the default burst; capped at the pool capacity) all within 2.5 of the center, and adds threat near the center;
// (g) shrinking a 131072-slot simulation whose only alive agents sit in slots 100000 and up to
// 65536 slots keeps every one of them (compaction, not a slot prefix);
// (i) kills in stats frames the old instance never read back count after a capacity change: with
// a change prepared (prepareCapacity, also to a new particle budget), a debug kill step is
// submitted and committed (commitCapacity) with no readback in between; the new instance's first
// stats report exactly the agents removed as kills;
// (j) the density readback (task C6a): after one step over a seeded cluster the first map matches the summed
// species channels of the coarse field (readCoarseField), the second map arrives only on the 16th step, and a
// capacity swap keeps sampling the same map;
// (h) main.js's cadence: one readStats per step with no await between steps, a 4-step frame every
// CADENCE_BURST_INTERVAL frames, rAF between frames; stats then lag 2 or more steps (asserted, so
// the check cannot fall back to the lag-1 case), and the peak alive / target ratio over the run,
// target taken at each step's request, stays at or below 1.05.
import { createGpuContext } from '/src/gpu/device.js';
import { AGENT_FLAG_ALIVE, AGENT_OFFSETS, AGENT_STRIDE_BYTES, ARENA_HEIGHT, ARENA_WIDTH, COARSE_COLUMNS, COARSE_ROWS, SPECIES_COUNT } from '/src/sim/layout.js';
import { normalizeShares } from '/src/sim/species.js';
import { SpawnPressure } from '/src/sim/spawner.js';
import { Simulation } from '/src/sim/simulation.js';
import { DENSITY_READBACK_INTERVAL } from '/src/sim/density-readback.js';
import { PARTICLE_HEADER_BYTES, PARTICLE_STRIDE_BYTES } from '/src/sim/particles.js';
import { DEFAULT_KILL_BURST_PARTICLES, DEFAULT_SPAWN_BAND_WIDTH } from '/src/sim/params.js';

const INITIAL_CAPACITY = 65536;
const GROWN_CAPACITY = 131072;
const FRAME_COUNT = 300;
const STEP_SECONDS = 1 / 60;
const SPAWN_FRAMES = 30;
const MAXIMUM_SEQUENCE_LAG = 3;
const PLAYER = [ARENA_WIDTH / 2, ARENA_HEIGHT / 2];
const READBACK_ATTEMPTS = 20;
const PHASE_TOLERANCE = 1e-5;
// integrate.wgsl's wall margin; integrate runs in the spawn frame and pushes agents inside it.
const WALL_MARGIN = 0.5;
const KILL_RADIUS = 2;
const KILL_FRAMES_TO_WAIT = 3;
const PARTICLES_PER_KILL = DEFAULT_KILL_BURST_PARTICLES;
// Particle struct (common.wgsl): position, velocity, color, age at 20, lifetime at 24, after the
// ParticlePool header (the spawn cursor and padding).
const PARTICLE_AGE_OFFSET = 20;
const PARTICLE_LIFETIME_OFFSET = 24;
const PARTICLE_SPREAD_LIMIT = 2.5;
const THREAT_FIXED_POINT_SCALE = 256;
const SHRINK_FROM_CAPACITY = 131072;
const SHRINK_TO_CAPACITY = 65536;
const SHRINK_FIRST_SLOT = 100000;
const SHRINK_AGENT_COUNT = 1000;
const SWAP_PARTICLE_CAPACITY = 32768;
const CADENCE_FRAMES = 300;
// Gate check (task C0b2): two emitting gates, each favoring one species with full bias, so every
// species 0 spawn lands at the first gate and every species 1 spawn at the second; a spawn moves
// by its outward ejection (at most 1.6 world units per second) for one step before the readback.
const GATE_CHECK_CAPACITY = 16384;
const GATE_CHECK_GATES = [{ x: 3, y: 2, radius: 0.6, emit: 1, species: 0 }, { x: 13, y: 7, radius: 0.6, emit: 1, species: 1 }];
const GATE_CHECK_SPAWNS = 400;
const GATE_EJECT_REACH = 1.6 * STEP_SECONDS + 1e-4;
const CADENCE_BURST_INTERVAL = 50;
const CADENCE_BURST_STEPS = 4;
const CADENCE_MAXIMUM_RATIO = 1.05;
const CADENCE_MINIMUM_LAG = 2;

// Steps once, submits, and waits for the GPU so the stats ring can map; returns the frame's step.
async function submitStep(device, simulation, spawnPerSpecies, spawnGates = null) {
  const encoder = device.createCommandEncoder({ label: 'simulation-check-frame' });
  simulation.step(encoder, STEP_SECONDS, spawnPerSpecies, spawnGates);
  device.queue.submit([encoder.finish()]);
  simulation.afterSubmit();
  await device.queue.onSubmittedWorkDone();
}

// Drains every ready ring slot and returns the newest stats, or previous when none is ready.
function drainStats(simulation, previous) {
  let latest = previous;
  for (let stats = simulation.readStats(); stats !== null; stats = simulation.readStats()) {
    if (latest === null || stats.frameSequence > latest.frameSequence) latest = stats;
  }
  return latest;
}

async function readBuffer(device, source) {
  const staging = device.createBuffer({ size: source.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const encoder = device.createCommandEncoder({ label: 'simulation-check-readback' });
  encoder.copyBufferToBuffer(source, 0, staging, 0, source.size);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const copy = staging.getMappedRange().slice(0);
  staging.unmap();
  staging.destroy();
  return copy;
}

// Returns { failure } when an agent spawned this frame breaks the spawn rules, else { summary }.
function spawnPlacement(agentBytes) {
  const view = new DataView(agentBytes);
  let spawning = 0;
  let closest = Infinity;
  for (let base = 0; base < agentBytes.byteLength; base += AGENT_STRIDE_BYTES) {
    const flags = view.getUint32(base + AGENT_OFFSETS.flags, true);
    const spawnFrames = (flags >>> 8) & 0xff;
    if ((flags & AGENT_FLAG_ALIVE) === 0) continue;
    spawning += 1;
    const x = view.getFloat32(base + AGENT_OFFSETS.position, true);
    const y = view.getFloat32(base + AGENT_OFFSETS.position + 4, true);
    const velocity = [view.getFloat32(base + AGENT_OFFSETS.velocity, true), view.getFloat32(base + AGENT_OFFSETS.velocity + 4, true)];
    const species = view.getUint32(base + AGENT_OFFSETS.species, true);
    const phase = view.getFloat32(base + AGENT_OFFSETS.phase, true);
    const hueJitter = view.getFloat32(base + AGENT_OFFSETS.hueJitter, true);
    const distance = Math.hypot(x - PLAYER[0], y - PLAYER[1]);
    closest = Math.min(closest, distance);
    const slot = base / AGENT_STRIDE_BYTES;
    if (distance < ARENA_WIDTH / 4) return { failure: `slot ${slot} spawned ${distance.toFixed(3)} from the player` };
    if (x < 0 || x > ARENA_WIDTH || y < 0 || y > ARENA_HEIGHT) return { failure: `slot ${slot} spawned outside the arena at (${x}, ${y})` };
    const wallDistance = Math.min(x, y, ARENA_WIDTH - x, ARENA_HEIGHT - y);
    if (wallDistance > DEFAULT_SPAWN_BAND_WIDTH) return { failure: `slot ${slot} spawned ${wallDistance.toFixed(3)} from the nearest wall, outside the ${DEFAULT_SPAWN_BAND_WIDTH} band` };
    const insideMargin = wallDistance < WALL_MARGIN;
    if (!insideMargin && (velocity[0] !== 0 || velocity[1] !== 0)) return { failure: `slot ${slot} has velocity ${velocity} in its spawn frame` };
    if (spawnFrames !== SPAWN_FRAMES - 1) return { failure: `slot ${slot} has ${spawnFrames} spawn-in frames after integrate, expected ${SPAWN_FRAMES - 1}` };
    if (species >= SPECIES_COUNT) return { failure: `slot ${slot} has species ${species}` };
    // integrate.wgsl wraps phase in f32, so allow rounding at both ends of [0, tau).
    if (!(phase >= -PHASE_TOLERANCE && phase < Math.PI * 2 + PHASE_TOLERANCE)) return { failure: `slot ${slot} has phase ${phase}` };
    if (!(hueJitter >= -1 && hueJitter <= 1)) return { failure: `slot ${slot} has hueJitter ${hueJitter}` };
  }
  if (spawning === 0) return { failure: 'no agent spawned' };
  return { summary: `${spawning} agents spawned in frame 1, closest ${closest.toFixed(3)} from the player (need >= ${ARENA_WIDTH / 4})` };
}

// Drains every ready ring slot into collected, keyed by frameSequence.
function collectStats(simulation, collected) {
  for (const stats of simulation.readAllStats()) collected.set(stats.frameSequence, stats);
}

async function waitForStats(device, simulation, collected, sequence) {
  for (let attempt = 0; attempt < READBACK_ATTEMPTS && !collected.has(sequence); attempt += 1) {
    collectStats(simulation, collected);
    if (!collected.has(sequence)) await device.queue.onSubmittedWorkDone();
  }
  return collected.get(sequence) ?? null;
}

// Counts live particles (lifetime above 0 and age below it) and the farthest one from center.
function liveParticles(particleBytes, center) {
  const view = new DataView(particleBytes);
  let count = 0;
  let farthest = 0;
  for (let base = PARTICLE_HEADER_BYTES; base < particleBytes.byteLength; base += PARTICLE_STRIDE_BYTES) {
    const age = view.getFloat32(base + PARTICLE_AGE_OFFSET, true);
    const lifetime = view.getFloat32(base + PARTICLE_LIFETIME_OFFSET, true);
    if (!(lifetime > 0 && age < lifetime)) continue;
    count += 1;
    farthest = Math.max(farthest, Math.hypot(view.getFloat32(base, true) - center[0], view.getFloat32(base + 4, true) - center[1]));
  }
  return { count, farthest };
}

// Sum of the threat accumulator over coarse cells within 3 world units of center, in threat units.
function threatNearCenter(accumulatorBytes, center) {
  const cells = new Uint32Array(accumulatorBytes);
  let total = 0;
  for (let index = 0; index < cells.length; index += 1) {
    const x = ((index % COARSE_COLUMNS) + 0.5) / COARSE_COLUMNS * ARENA_WIDTH;
    const y = (Math.floor(index / COARSE_COLUMNS) + 0.5) / COARSE_ROWS * ARENA_HEIGHT;
    if (Math.hypot(x - center[0], y - center[1]) <= KILL_RADIUS + 1) total += cells[index];
  }
  return total / THREAT_FIXED_POINT_SCALE;
}

// Arms the debug kill for one zero-spawn frame and returns what the check asserts on.
async function runKillCheck(device, simulation) {
  const zeroSpawns = () => new Uint32Array(SPECIES_COUNT);
  const collected = new Map();
  await submitStep(device, simulation, zeroSpawns());
  const baseline = await waitForStats(device, simulation, collected, simulation.frameSequence);
  if (baseline === null) return { pass: false, detail: 'no baseline stats before the kill' };

  simulation.setDebugKill(PLAYER[0], PLAYER[1], KILL_RADIUS);
  await submitStep(device, simulation, zeroSpawns());
  const killSequence = simulation.frameSequence;
  const threatBytes = await readBuffer(device, simulation.field.buffers.threatAccumulator);
  const particleBytes = await readBuffer(device, simulation.particlePool.buffers.particles);
  for (let frame = 0; frame < KILL_FRAMES_TO_WAIT; frame += 1) {
    await submitStep(device, simulation, zeroSpawns());
    collectStats(simulation, collected);
  }
  const kill = await waitForStats(device, simulation, collected, killSequence);
  const later = await waitForStats(device, simulation, collected, killSequence + 1);
  if (kill === null || later === null) return { pass: false, detail: 'no stats for the kill frame or the frame after it' };

  const particles = liveParticles(particleBytes, PLAYER);
  const threat = threatNearCenter(threatBytes, PLAYER);
  const expectedParticles = Math.min(PARTICLES_PER_KILL * kill.killsSinceLastRead, simulation.particlePool.capacity);
  const removed = baseline.aliveTotal - kill.aliveTotal;
  const verdicts = [
    [kill.killsSinceLastRead > 0, `kills ${kill.killsSinceLastRead} (need > 0)`],
    [removed === kill.killsSinceLastRead, `alive ${baseline.aliveTotal} before and ${kill.aliveTotal} after, removed ${removed} (need exactly the kills)`],
    [later.killsSinceLastRead === 0, `kills the next frame ${later.killsSinceLastRead} (need 0, the arm lasts one frame)`],
    [particles.count >= expectedParticles, `live particles ${particles.count} (need >= ${expectedParticles})`],
    [particles.farthest <= PARTICLE_SPREAD_LIMIT, `farthest particle ${particles.farthest.toFixed(3)} from center (need <= ${PARTICLE_SPREAD_LIMIT})`],
    [threat > 0, `threat near center ${threat.toFixed(1)} units (need > 0)`],
  ];
  return {
    pass: verdicts.every(([ok]) => ok),
    detail: verdicts.map(([ok, text]) => `${ok ? 'PASS' : 'FAIL'} ${text}`).join('; '),
  };
}

// Writes count alive agents (spawn-in done, all species) on a grid over the arena from firstSlot.
function seedAgents(device, simulation, firstSlot, count) {
  const bytes = new ArrayBuffer(count * AGENT_STRIDE_BYTES);
  const view = new DataView(bytes);
  for (let agent = 0; agent < count; agent += 1) {
    const base = agent * AGENT_STRIDE_BYTES;
    view.setFloat32(base + AGENT_OFFSETS.position, 1 + (agent % 40) * 0.35, true);
    view.setFloat32(base + AGENT_OFFSETS.position + 4, 1 + Math.floor(agent / 40) * 0.28, true);
    view.setUint32(base + AGENT_OFFSETS.species, agent % SPECIES_COUNT, true);
    view.setUint32(base + AGENT_OFFSETS.flags, AGENT_FLAG_ALIVE, true);
  }
  device.queue.writeBuffer(simulation.agentsBuffer, firstSlot * AGENT_STRIDE_BYTES, bytes);
}

// Seeds SHRINK_AGENT_COUNT alive agents (spawn-in done, all species) in slots from
// SHRINK_FIRST_SLOT of a fresh simulation, steps once so the params uniform is written, shrinks it
// and counts the survivors after one more step.
async function runShrinkCheck(gpu) {
  const { device } = gpu;
  const zeroSpawns = () => new Uint32Array(SPECIES_COUNT);
  let simulation = await Simulation.create(gpu, { capacity: SHRINK_FROM_CAPACITY });
  seedAgents(device, simulation, SHRINK_FIRST_SLOT, SHRINK_AGENT_COUNT);
  const collected = new Map();
  await submitStep(device, simulation, zeroSpawns());
  const before = await waitForStats(device, simulation, collected, simulation.frameSequence);
  simulation = await simulation.recreateWithCapacity(SHRINK_TO_CAPACITY);
  await submitStep(device, simulation, zeroSpawns());
  const after = await waitForStats(device, simulation, collected, simulation.frameSequence);
  simulation.destroy();
  const pass = before?.aliveTotal === SHRINK_AGENT_COUNT && after?.aliveTotal === SHRINK_AGENT_COUNT;
  return {
    pass,
    detail: `${pass ? 'PASS' : 'FAIL'} shrink ${SHRINK_FROM_CAPACITY} -> ${SHRINK_TO_CAPACITY} with ${SHRINK_AGENT_COUNT} alive agents from slot ${SHRINK_FIRST_SLOT}: alive ${before?.aliveTotal ?? 'none'} before, ${after?.aliveTotal ?? 'none'} after (need all ${SHRINK_AGENT_COUNT})`,
  };
}

// (i) Regression for the Plan A minor "kills not yet read back from the old simulation are lost
// across a capacity swap".
async function runSwapKillCheck(gpu) {
  const { device } = gpu;
  const zeroSpawns = () => new Uint32Array(SPECIES_COUNT);
  let simulation = await Simulation.create(gpu, { capacity: INITIAL_CAPACITY });
  simulation.setPlayer(PLAYER[0], PLAYER[1]);
  seedAgents(device, simulation, 0, SHRINK_AGENT_COUNT);
  const collected = new Map();
  await submitStep(device, simulation, zeroSpawns());
  const before = await waitForStats(device, simulation, collected, simulation.frameSequence);
  const prepared = await simulation.prepareCapacity(GROWN_CAPACITY, { particleCapacity: SWAP_PARTICLE_CAPACITY });
  simulation.setDebugKill(PLAYER[0], PLAYER[1], KILL_RADIUS);
  await submitStep(device, simulation, zeroSpawns());
  simulation = simulation.commitCapacity(prepared);
  await submitStep(device, simulation, zeroSpawns());
  const after = await waitForStats(device, simulation, new Map(), simulation.frameSequence);
  const particleCapacity = simulation.particlePool.capacity;
  simulation.destroy();
  const removed = (before?.aliveTotal ?? 0) - (after?.aliveTotal ?? 0);
  const pass = before !== null && after !== null && removed > 0 && after.killsSinceLastRead === removed && particleCapacity === SWAP_PARTICLE_CAPACITY;
  return {
    pass,
    detail: `${pass ? 'PASS' : 'FAIL'} unread kills across a swap ${INITIAL_CAPACITY} -> ${GROWN_CAPACITY}: alive ${before?.aliveTotal ?? 'none'} before, ${after?.aliveTotal ?? 'none'} after, removed ${removed}, kills read from the new instance ${after?.killsSinceLastRead ?? 'none'} (need equal and > 0), particle budget ${particleCapacity} (need ${SWAP_PARTICLE_CAPACITY})`,
  };
}

async function pollUntilMaps(device, simulation, count) {
  for (let attempt = 0; attempt < READBACK_ATTEMPTS && simulation.densityReadback.mapsReceived < count; attempt += 1) {
    await device.queue.onSubmittedWorkDone();
    simulation.pollDensity();
  }
  return simulation.densityReadback.mapsReceived;
}

// (j) The density readback against the coarse field it summarizes.
async function runDensityCheck(gpu) {
  const { device } = gpu;
  const zeroSpawns = () => new Uint32Array(SPECIES_COUNT);
  let simulation = await Simulation.create(gpu, { capacity: INITIAL_CAPACITY });
  simulation.setPlayer(PLAYER[0], PLAYER[1]);
  const clusterCount = 600;
  const bytes = new ArrayBuffer(clusterCount * AGENT_STRIDE_BYTES);
  const view = new DataView(bytes);
  for (let agent = 0; agent < clusterCount; agent += 1) {
    const base = agent * AGENT_STRIDE_BYTES;
    view.setFloat32(base + AGENT_OFFSETS.position, 3 + (agent % 20) * 0.02, true);
    view.setFloat32(base + AGENT_OFFSETS.position + 4, 4 + Math.floor(agent / 20) * 0.02, true);
    view.setUint32(base + AGENT_OFFSETS.species, agent % SPECIES_COUNT, true);
    view.setUint32(base + AGENT_OFFSETS.flags, AGENT_FLAG_ALIVE, true);
  }
  device.queue.writeBuffer(simulation.agentsBuffer, 0, bytes);
  const beforeFirst = simulation.densityAt(3.2, 4.2);
  await submitStep(device, simulation, zeroSpawns());
  const field = await simulation.readCoarseField();
  const first = await pollUntilMaps(device, simulation, 1);
  const cellColumn = Math.floor(3.2 / ARENA_WIDTH * COARSE_COLUMNS);
  const cellRow = Math.floor(4.2 / ARENA_HEIGHT * COARSE_ROWS);
  const cell = cellRow * COARSE_COLUMNS + cellColumn;
  let expectedSum = 0;
  for (let channel = 0; channel < SPECIES_COUNT; channel += 1) expectedSum += field[cell * 8 + channel];
  let largestError = 0;
  for (let index = 0; index < COARSE_COLUMNS * COARSE_ROWS; index += 1) {
    let sum = 0;
    for (let channel = 0; channel < SPECIES_COUNT; channel += 1) sum += field[index * 8 + channel];
    largestError = Math.max(largestError, Math.abs(sum - simulation.densityReadback.map[index]));
  }
  const nearCluster = simulation.densityAt(3.2, 4.2);
  const farCorner = simulation.densityAt(15, 8.5);
  for (let step = 0; step < DENSITY_READBACK_INTERVAL - 1; step += 1) await submitStep(device, simulation, zeroSpawns());
  const beforeSecond = await pollUntilMaps(device, simulation, 2);
  await submitStep(device, simulation, zeroSpawns());
  const second = await pollUntilMaps(device, simulation, 2);
  const beforeSwap = simulation.densityAt(3.2, 4.2);
  simulation = await simulation.recreateWithCapacity(GROWN_CAPACITY);
  const afterSwap = simulation.densityAt(3.2, 4.2);
  simulation.destroy();
  const pass = beforeFirst === 0 && first === 1 && expectedSum > 1 && largestError < 1e-3 && nearCluster > 5 * farCorner
    && beforeSecond === 1 && second === 2 && afterSwap === beforeSwap && afterSwap > 0;
  return {
    pass,
    detail: `${pass ? 'PASS' : 'FAIL'} density readback: 0 before the first map (${beforeFirst}), maps ${first} after step 1, largest per-cell error vs the coarse field ${largestError.toExponential(2)} (need < 1e-3), cluster ${nearCluster.toFixed(2)} vs far corner ${farCorner.toFixed(3)} (need 5x), maps ${beforeSecond} after step ${DENSITY_READBACK_INTERVAL} (need 1) and ${second} after step ${DENSITY_READBACK_INTERVAL + 1} (need 2), swap keeps the sample (${beforeSwap.toFixed(3)} then ${afterSwap.toFixed(3)})`,
  };
}

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

// (h) Runs main.js's update cadence on a fresh simulation and returns the peak ratio and lag.
async function runCadenceCheck(gpu) {
  const { device } = gpu;
  const shares = normalizeShares([1, 1, 1, 1, 1]);
  const simulation = await Simulation.create(gpu, { capacity: INITIAL_CAPACITY, shares });
  simulation.setPlayer(PLAYER[0], PLAYER[1]);
  const pressure = new SpawnPressure({ capacity: INITIAL_CAPACITY });
  const targetBySequence = new Map();
  let lastStats = null;
  let peak = { ratio: 0, sequence: 0 };
  let maximumLag = 0;
  for (let frame = 1; frame <= CADENCE_FRAMES; frame += 1) {
    const steps = frame % CADENCE_BURST_INTERVAL === 0 ? CADENCE_BURST_STEPS : 1;
    for (let step = 0; step < steps; step += 1) {
      const sequence = simulation.frameSequence + 1;
      const spawnPerSpecies = pressure.update(STEP_SECONDS, lastStats, shares, sequence);
      targetBySequence.set(sequence, pressure.targetAlive);
      const encoder = device.createCommandEncoder({ label: 'simulation-check-cadence' });
      simulation.step(encoder, STEP_SECONDS, spawnPerSpecies);
      device.queue.submit([encoder.finish()]);
      simulation.afterSubmit();
      const frames = simulation.readAllStats();
      for (const stats of frames) {
        const ratio = stats.aliveTotal / targetBySequence.get(stats.frameSequence);
        if (ratio > peak.ratio) peak = { ratio, sequence: stats.frameSequence };
      }
      if (frames.length > 0) lastStats = frames[frames.length - 1];
      maximumLag = Math.max(maximumLag, simulation.frameSequence - (lastStats?.frameSequence ?? 0));
    }
    await nextAnimationFrame();
  }
  simulation.destroy();
  const pass = lastStats !== null && peak.ratio <= CADENCE_MAXIMUM_RATIO && maximumLag >= CADENCE_MINIMUM_LAG;
  return {
    pass,
    detail: `${pass ? 'PASS' : 'FAIL'} main.js cadence over ${CADENCE_FRAMES} frames (a ${CADENCE_BURST_STEPS}-step frame every ${CADENCE_BURST_INTERVAL}): peak alive / target ${peak.ratio.toFixed(3)} at step ${peak.sequence} (need <= ${CADENCE_MAXIMUM_RATIO}), maximum stats lag ${maximumLag} steps (need >= ${CADENCE_MINIMUM_LAG})`,
  };
}

async function runCheck() {
  const gpu = await createGpuContext(document.getElementById('canvas'));
  const { device } = gpu;
  let lostReason = null;
  device.lost.then((info) => { lostReason = info.message || info.reason || 'lost'; });
  device.addEventListener('uncapturederror', (event) => { console.error(`uncaptured WebGPU error: ${event.error.message}`); });

  const shares = normalizeShares([1, 1, 1, 1, 1]);
  let simulation = await Simulation.create(gpu, { capacity: INITIAL_CAPACITY, shares });
  simulation.setPlayer(PLAYER[0], PLAYER[1]);
  const pressure = new SpawnPressure({ capacity: INITIAL_CAPACITY });
  let latest = null;
  let requested = 0;
  let maximumLag = 0;
  let placement = null;
  for (let frame = 1; frame <= FRAME_COUNT; frame += 1) {
    const spawnPerSpecies = pressure.update(STEP_SECONDS, latest, shares, simulation.frameSequence + 1);
    requested += spawnPerSpecies.reduce((sum, count) => sum + count, 0);
    await submitStep(device, simulation, spawnPerSpecies);
    if (frame === 1) placement = spawnPlacement(await readBuffer(device, simulation.agentsBuffer));
    latest = drainStats(simulation, latest);
    if (frame > MAXIMUM_SEQUENCE_LAG) maximumLag = Math.max(maximumLag, frame - (latest?.frameSequence ?? 0));
  }
  if (lostReason !== null) return { pass: false, detail: `device lost: ${lostReason}` };
  if (latest === null) return { pass: false, detail: 'readStats() never returned stats' };

  const target = pressure.targetAlive;
  const ratio = latest.aliveTotal / target;
  const aliveOk = ratio >= 0.6 && ratio <= 1.02 && latest.aliveTotal <= requested;
  const speciesErrors = Array.from(latest.alivePerSpecies, (count, species) => {
    const expected = shares[species] * latest.aliveTotal;
    return Math.abs(count - expected) / expected;
  });
  const speciesSum = latest.alivePerSpecies.reduce((sum, count) => sum + count, 0);
  const speciesOk = speciesErrors.every((error) => error <= 0.1) && speciesSum === latest.aliveTotal;
  const lagOk = maximumLag <= MAXIMUM_SEQUENCE_LAG && FRAME_COUNT - latest.frameSequence <= MAXIMUM_SEQUENCE_LAG;

  const previousAlive = latest.aliveTotal;
  simulation = await simulation.recreateWithCapacity(GROWN_CAPACITY);
  await submitStep(device, simulation, new Uint32Array(SPECIES_COUNT));
  let grown = null;
  for (let attempt = 0; attempt < READBACK_ATTEMPTS && grown === null; attempt += 1) {
    grown = drainStats(simulation, null);
    if (grown === null) await device.queue.onSubmittedWorkDone();
  }
  if (lostReason !== null) return { pass: false, detail: `device lost after recreate: ${lostReason}` };
  const grownOk = grown !== null && grown.aliveTotal >= 0.95 * previousAlive && grown.frameSequence === FRAME_COUNT + 1 && simulation.capacity === GROWN_CAPACITY;

  const verdict = (pass) => (pass ? 'PASS' : 'FAIL');
  const details = [
    `${verdict(aliveOk)} alive ${latest.aliveTotal} of target ${target.toFixed(0)} (ratio ${ratio.toFixed(3)}, need 0.6 to 1.02), requested ${requested}`,
    `${verdict(speciesOk)} per species [${Array.from(latest.alivePerSpecies).join(' ')}] relative error [${speciesErrors.map((error) => (error * 100).toFixed(1) + '%').join(' ')}] (need <= 10%)`,
    `${verdict(lagOk)} frameSequence ${latest.frameSequence} after ${FRAME_COUNT} frames, maximum lag ${maximumLag} (need <= ${MAXIMUM_SEQUENCE_LAG})`,
    `${verdict(placement.failure === undefined)} spawn placement ${placement.failure ?? placement.summary}`,
    `${verdict(grownOk)} after recreateWithCapacity(${GROWN_CAPACITY}) alive ${grown?.aliveTotal ?? 'none'} of ${previousAlive} (need >= 95%), frameSequence ${grown?.frameSequence ?? 'none'} (need ${FRAME_COUNT + 1})`,
  ];
  const killResult = await runKillCheck(device, simulation);
  if (lostReason !== null) return { pass: false, detail: `device lost during the kill check: ${lostReason}` };
  details.push(killResult.detail);
  simulation.destroy();
  const shrinkResult = await runShrinkCheck(gpu);
  if (lostReason !== null) return { pass: false, detail: `device lost during the shrink check: ${lostReason}` };
  details.push(shrinkResult.detail);
  const swapKillResult = await runSwapKillCheck(gpu);
  if (lostReason !== null) return { pass: false, detail: `device lost during the swap kill check: ${lostReason}` };
  details.push(swapKillResult.detail);
  const gateResult = await runGateCheck(gpu);
  if (lostReason !== null) return { pass: false, detail: `device lost during the gate check: ${lostReason}` };
  details.push(gateResult.detail);
  const densityResult = await runDensityCheck(gpu);
  if (lostReason !== null) return { pass: false, detail: `device lost during the density check: ${lostReason}` };
  details.push(densityResult.detail);
  const cadenceResult = await runCadenceCheck(gpu);
  if (lostReason !== null) return { pass: false, detail: `device lost during the cadence check: ${lostReason}` };
  details.push(cadenceResult.detail);
  const pass = aliveOk && speciesOk && lagOk && placement.failure === undefined && grownOk && killResult.pass && shrinkResult.pass && swapKillResult.pass && gateResult.pass && densityResult.pass && cadenceResult.pass;
  return { pass, detail: details.join('; ') };
}

// Steps once with GATE_CHECK_GATES and GATE_CHECK_SPAWNS of species 0 and 1 each, then checks
// every alive agent lies within its species' gate radius plus one step of ejection.
async function runGateCheck(gpu) {
  const { device } = gpu;
  const simulation = await Simulation.create(gpu, { capacity: GATE_CHECK_CAPACITY });
  simulation.setPlayer(ARENA_WIDTH / 2, ARENA_HEIGHT / 2);
  const spawnPerSpecies = Uint32Array.from({ length: SPECIES_COUNT }, (unused, species) => (species < 2 ? GATE_CHECK_SPAWNS : 0));
  await submitStep(device, simulation, spawnPerSpecies, { gates: GATE_CHECK_GATES, speciesBias: 1 });
  const view = new DataView(await readBuffer(device, simulation.agentsBuffer));
  simulation.destroy();
  const counts = [0, 0];
  let farthest = 0;
  for (let base = 0; base < view.byteLength; base += AGENT_STRIDE_BYTES) {
    if ((view.getUint32(base + AGENT_OFFSETS.flags, true) & AGENT_FLAG_ALIVE) === 0) continue;
    const species = view.getUint32(base + AGENT_OFFSETS.species, true);
    const gate = GATE_CHECK_GATES[species];
    if (gate === undefined) return { pass: false, detail: `FAIL gate spawn of species ${species}, only 0 and 1 were requested` };
    const distance = Math.hypot(view.getFloat32(base + AGENT_OFFSETS.position, true) - gate.x, view.getFloat32(base + AGENT_OFFSETS.position + 4, true) - gate.y);
    farthest = Math.max(farthest, distance - gate.radius);
    counts[species] += 1;
  }
  const pass = counts[0] === GATE_CHECK_SPAWNS && counts[1] === GATE_CHECK_SPAWNS && farthest <= GATE_EJECT_REACH;
  return { pass, detail: `${pass ? 'PASS' : 'FAIL'} gate spawns ${counts.join(' and ')} of ${GATE_CHECK_SPAWNS} per species, farthest ${Math.max(0, farthest).toFixed(4)} past its own gate's radius (need <= ${GATE_EJECT_REACH.toFixed(4)})` };
}

runCheck().then(
  (result) => { window.__simulationCheck = result; },
  (error) => { window.__simulationCheck = { pass: false, detail: `exception: ${error.message}` }; },
);
