// Steps a 65536-slot Simulation fed by SpawnPressure for 300 frames at dt 1/60, polling the stats
// ring after every submit, and checks: (a) the alive total tracks the ramping target (0.6 to 1.02
// of it) and never exceeds what was requested (no double-spent budget); (b) every species holds
// its share within 10 percent relative; (c) the read-back frameSequence lags the CPU frame by at
// most 3; (d) after frame 1 every agent was spawned that frame: it sits at least ARENA_WIDTH / 4
// from the player with 29 spawn-in frames left, in-range species, phase and hueJitter, and zero
// velocity unless integrate's wall spring already pushed it (inside WALL_MARGIN of an edge);
// (e) recreateWithCapacity(131072) keeps at least 95 percent of the alive agents after one more step.
import { createGpuContext } from '/src/gpu/device.js';
import { AGENT_FLAG_ALIVE, AGENT_OFFSETS, AGENT_STRIDE_BYTES, ARENA_HEIGHT, ARENA_WIDTH, SPECIES_COUNT } from '/src/sim/layout.js';
import { normalizeShares } from '/src/sim/species.js';
import { SpawnPressure } from '/src/sim/spawner.js';
import { Simulation } from '/src/sim/simulation.js';

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
    const spawnPerSpecies = pressure.update(STEP_SECONDS, latest?.aliveTotal ?? 0, shares);
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
  simulation.destroy();
  return { pass: aliveOk && speciesOk && lagOk && placement.failure === undefined && grownOk, detail: details.join('; ') };
}

runCheck().then(
  (result) => { window.__simulationCheck = result; },
  (error) => { window.__simulationCheck = { pass: false, detail: `exception: ${error.message}` }; },
);
