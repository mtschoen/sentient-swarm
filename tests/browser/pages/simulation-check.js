// Steps a 65536-slot Simulation fed by SpawnPressure for 300 frames at dt 1/60, awaiting the GPU
// and polling the stats ring after every submit (stats lag one step), and checks: (a) the alive total tracks the ramping target (0.6 to 1.02
// of it) and never exceeds what was requested (no double-spent budget); (b) every species holds
// its share within 10 percent relative; (c) the read-back frameSequence lags the CPU frame by at
// most 3; (d) after frame 1 every agent was spawned that frame: it sits at least ARENA_WIDTH / 4
// from the player with 29 spawn-in frames left, in-range species, phase and hueJitter, and zero
// velocity unless integrate's wall spring already pushed it (inside WALL_MARGIN of an edge);
// (e) recreateWithCapacity(131072) keeps at least 95 percent of the alive agents after one more step;
// (f) a one-frame debug kill of radius 2 at the arena center, with zero spawning, reports kills, drops
// aliveTotal by exactly that many, reports zero kills a frame later, fills at least 6 particle slots
// per kill (capped at the pool capacity) all within 2.5 of the center, and adds threat near the center;
// (g) shrinking a 131072-slot simulation whose only alive agents sit in slots 100000 and up to
// 65536 slots keeps every one of them (compaction, not a slot prefix);
// (h) main.js's cadence: one readStats per step with no await between steps, a 4-step frame every
// CADENCE_BURST_INTERVAL frames, rAF between frames; stats then lag 2 or more steps (asserted, so
// the check cannot fall back to the lag-1 case), and the peak alive / target ratio over the run,
// target taken at each step's request, stays at or below 1.05.
import { createGpuContext } from '/src/gpu/device.js';
import { AGENT_FLAG_ALIVE, AGENT_OFFSETS, AGENT_STRIDE_BYTES, ARENA_HEIGHT, ARENA_WIDTH, COARSE_COLUMNS, COARSE_ROWS, SPECIES_COUNT } from '/src/sim/layout.js';
import { normalizeShares } from '/src/sim/species.js';
import { SpawnPressure } from '/src/sim/spawner.js';
import { Simulation } from '/src/sim/simulation.js';
import { PARTICLE_STRIDE_BYTES } from '/src/sim/particles.js';

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
const PARTICLES_PER_KILL = 6;
// Particle struct (common.wgsl): position, velocity, color, age at 20, lifetime at 24.
const PARTICLE_AGE_OFFSET = 20;
const PARTICLE_LIFETIME_OFFSET = 24;
const PARTICLE_SPREAD_LIMIT = 2.5;
const THREAT_FIXED_POINT_SCALE = 256;
const SHRINK_FROM_CAPACITY = 131072;
const SHRINK_TO_CAPACITY = 65536;
const SHRINK_FIRST_SLOT = 100000;
const SHRINK_AGENT_COUNT = 1000;
const CADENCE_FRAMES = 300;
const CADENCE_BURST_INTERVAL = 50;
const CADENCE_BURST_STEPS = 4;
const CADENCE_MAXIMUM_RATIO = 1.05;
const CADENCE_MINIMUM_LAG = 2;

// Steps once, submits, and waits for the GPU so the stats ring can map; returns the frame's step.
async function submitStep(device, simulation, spawnPerSpecies) {
  const encoder = device.createCommandEncoder({ label: 'simulation-check-frame' });
  simulation.step(encoder, STEP_SECONDS, spawnPerSpecies);
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
    const insideMargin = Math.min(x, y, ARENA_WIDTH - x, ARENA_HEIGHT - y) < WALL_MARGIN;
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
  for (let base = 0; base < particleBytes.byteLength; base += PARTICLE_STRIDE_BYTES) {
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

// Seeds SHRINK_AGENT_COUNT alive agents (spawn-in done, all species) in slots from
// SHRINK_FIRST_SLOT of a fresh simulation, steps once so the params uniform is written, shrinks it
// and counts the survivors after one more step.
async function runShrinkCheck(gpu) {
  const { device } = gpu;
  const zeroSpawns = () => new Uint32Array(SPECIES_COUNT);
  let simulation = await Simulation.create(gpu, { capacity: SHRINK_FROM_CAPACITY });
  const bytes = new ArrayBuffer(SHRINK_AGENT_COUNT * AGENT_STRIDE_BYTES);
  const view = new DataView(bytes);
  for (let agent = 0; agent < SHRINK_AGENT_COUNT; agent += 1) {
    const base = agent * AGENT_STRIDE_BYTES;
    view.setFloat32(base + AGENT_OFFSETS.position, 1 + (agent % 40) * 0.35, true);
    view.setFloat32(base + AGENT_OFFSETS.position + 4, 1 + Math.floor(agent / 40) * 0.28, true);
    view.setUint32(base + AGENT_OFFSETS.species, agent % SPECIES_COUNT, true);
    view.setUint32(base + AGENT_OFFSETS.flags, AGENT_FLAG_ALIVE, true);
  }
  device.queue.writeBuffer(simulation.agentsBuffer, SHRINK_FIRST_SLOT * AGENT_STRIDE_BYTES, bytes);
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
  const cadenceResult = await runCadenceCheck(gpu);
  if (lostReason !== null) return { pass: false, detail: `device lost during the cadence check: ${lostReason}` };
  details.push(cadenceResult.detail);
  const pass = aliveOk && speciesOk && lagOk && placement.failure === undefined && grownOk && killResult.pass && shrinkResult.pass && cadenceResult.pass;
  return { pass, detail: details.join('; ') };
}

runCheck().then(
  (result) => { window.__simulationCheck = result; },
  (error) => { window.__simulationCheck = { pass: false, detail: `exception: ${error.message}` }; },
);
