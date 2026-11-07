// Runs the grid, coarse field and steering pipeline on seeded agent layouts and checks the
// resulting motion: (a) Chasers close on the player and ping-pong buffers reuse bind groups,
// (b) a single overfull cell stays valid and its field is exact, (c) a Lattice square holds the
// spacing its target density implies, (d) pressure keeps a large Chaser swarm from collapsing
// into a ball while pressure 0 lets it collapse.
import { createGpuContext } from '/src/gpu/device.js';
import { createStorageBuffer, createUniformBuffer } from '/src/gpu/buffers.js';
import { loadShader, substituteConstants } from '/src/gpu/shaders.js';
import { AGENT_FLAG_ALIVE, AGENT_OFFSETS, AGENT_STRIDE_BYTES, ARENA_HEIGHT, ARENA_WIDTH, COARSE_CHANNELS, COARSE_COLUMNS, COARSE_ROWS, SHADER_CONSTANTS, gridDimensions } from '/src/sim/layout.js';
import { SIM_PARAMS_BYTES, packSimParams } from '/src/sim/params.js';
import { SPECIES_NAMES, defaultMatrix, defaultSpecies, packSpeciesTable } from '/src/sim/species.js';
import { SpatialGrid } from '/src/sim/grid.js';
import { CoarseField } from '/src/sim/field.js';
import { Steering } from '/src/sim/steer.js';

const NEIGHBOR_RADIUS = 0.1;
const STEP_SECONDS = 1 / 60;
const PLAYER = [ARENA_WIDTH / 2, ARENA_HEIGHT / 2];
const STEPS_PER_SUBMIT = 20;
const CHASER = SPECIES_NAMES.indexOf('Chaser');
const LATTICE = SPECIES_NAMES.indexOf('Lattice');

// Deterministic seeded random numbers (mulberry32) so every run sees the same layout.
function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function packAgents(positions, species, random) {
  const bytes = new ArrayBuffer(positions.length * AGENT_STRIDE_BYTES);
  const view = new DataView(bytes);
  positions.forEach(([x, y], index) => {
    const base = index * AGENT_STRIDE_BYTES;
    view.setFloat32(base + AGENT_OFFSETS.position, x, true);
    view.setFloat32(base + AGENT_OFFSETS.position + 4, y, true);
    view.setUint32(base + AGENT_OFFSETS.species, species, true);
    view.setUint32(base + AGENT_OFFSETS.flags, AGENT_FLAG_ALIVE, true);
    view.setFloat32(base + AGENT_OFFSETS.phase, random() * Math.PI * 2, true);
  });
  return bytes;
}

function unpackAgents(bytes) {
  const view = new DataView(bytes);
  const count = bytes.byteLength / AGENT_STRIDE_BYTES;
  const agents = [];
  for (let index = 0; index < count; index += 1) {
    const base = index * AGENT_STRIDE_BYTES;
    agents.push({
      x: view.getFloat32(base + AGENT_OFFSETS.position, true),
      y: view.getFloat32(base + AGENT_OFFSETS.position + 4, true),
      flags: view.getUint32(base + AGENT_OFFSETS.flags, true),
    });
  }
  return agents;
}

function uniformPositions(count, random) {
  return Array.from({ length: count }, () => [random() * ARENA_WIDTH, random() * ARENA_HEIGHT]);
}

function distanceToPlayer(agent) {
  return Math.hypot(agent.x - PLAYER[0], agent.y - PLAYER[1]);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

// Returns a failure string when any agent died, went non-finite or left the arena.
function validityFailure(agents) {
  for (const [index, agent] of agents.entries()) {
    if ((agent.flags & AGENT_FLAG_ALIVE) === 0) return `agent ${index} is no longer alive`;
    if (!Number.isFinite(agent.x) || !Number.isFinite(agent.y)) return `agent ${index} position is not finite`;
    if (agent.x < 0 || agent.x > ARENA_WIDTH || agent.y < 0 || agent.y > ARENA_HEIGHT) {
      return `agent ${index} left the arena at (${agent.x}, ${agent.y})`;
    }
  }
  return null;
}

// Mean nearest-neighbor distance by bucketing into a CPU grid of NEIGHBOR_RADIUS cells.
function meanNearestNeighborDistance(agents) {
  const columns = Math.ceil(ARENA_WIDTH / NEIGHBOR_RADIUS);
  const buckets = new Map();
  const keyOf = (column, row) => column + row * columns;
  const cellOf = (agent) => [Math.floor(agent.x / NEIGHBOR_RADIUS), Math.floor(agent.y / NEIGHBOR_RADIUS)];
  agents.forEach((agent) => {
    const key = keyOf(...cellOf(agent));
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(agent);
  });
  const distances = agents.map((agent) => {
    const [column, row] = cellOf(agent);
    let nearest = Infinity;
    for (let ring = 1; nearest === Infinity || ring <= 2; ring += 1) {
      for (let rowOffset = -ring; rowOffset <= ring; rowOffset += 1) {
        for (let columnOffset = -ring; columnOffset <= ring; columnOffset += 1) {
          for (const other of buckets.get(keyOf(column + columnOffset, row + rowOffset)) ?? []) {
            if (other === agent) continue;
            nearest = Math.min(nearest, Math.hypot(other.x - agent.x, other.y - agent.y));
          }
        }
      }
      if (ring > 20) break;
    }
    return nearest;
  });
  return mean(distances);
}

class Harness {
  constructor(gpu, common, capacity) {
    this.device = gpu.device;
    this.capacity = capacity;
    const dimensions = gridDimensions(NEIGHBOR_RADIUS);
    this.dimensions = dimensions;
    this.grid = new SpatialGrid(gpu, { columns: dimensions.columns, rows: dimensions.rows, capacity, common });
    this.field = new CoarseField(gpu, { grid: this.grid, common });
    this.steering = new Steering(gpu, { common });
    const agentBytes = capacity * AGENT_STRIDE_BYTES;
    this.agentsIn = createStorageBuffer(this.device, agentBytes, 'steer-check-agents-in');
    this.agentsOut = createStorageBuffer(this.device, agentBytes, 'steer-check-agents-out');
    this.paramsBuffer = createUniformBuffer(this.device, SIM_PARAMS_BYTES, 'steer-check-params');
    this.speciesBuffer = createStorageBuffer(this.device, packSpeciesTable(defaultSpecies(), defaultMatrix()).byteLength, 'steer-check-species');
  }

  async initialize() {
    await Promise.all([this.grid.initialize(), this.field.initialize(), this.steering.initialize()]);
    this.device.queue.writeBuffer(this.paramsBuffer, 0, packSimParams({
      dt: STEP_SECONDS,
      playerPosition: PLAYER,
      neighborRadius: NEIGHBOR_RADIUS,
      gridColumns: this.dimensions.columns,
      gridRows: this.dimensions.rows,
      cellSize: this.dimensions.cellSize,
      capacity: this.capacity,
      aliveTarget: this.capacity,
    }));
  }

  seed(agentBytes, speciesRows) {
    this.device.queue.writeBuffer(this.agentsIn, 0, agentBytes);
    this.device.queue.writeBuffer(this.speciesBuffer, 0, packSpeciesTable(speciesRows, defaultMatrix()));
  }

  encodeStep(encoder) {
    this.grid.encode(encoder, this.agentsIn, this.paramsBuffer);
    this.field.encode(encoder, this.agentsIn, this.grid.buffers, this.paramsBuffer);
    this.steering.encode(encoder, this.agentsIn, this.agentsOut, this.grid.buffers, this.field.buffers.blurred, this.speciesBuffer, this.paramsBuffer);
    encoder.copyBufferToBuffer(this.agentsOut, 0, this.agentsIn, 0, this.capacity * AGENT_STRIDE_BYTES);
  }

  async run(steps) {
    for (let done = 0; done < steps; done += STEPS_PER_SUBMIT) {
      const encoder = this.device.createCommandEncoder({ label: 'steer-check-steps' });
      for (let step = done; step < Math.min(steps, done + STEPS_PER_SUBMIT); step += 1) this.encodeStep(encoder);
      this.device.queue.submit([encoder.finish()]);
      await this.device.queue.onSubmittedWorkDone();
    }
  }

  async readBuffer(source, bytes) {
    const staging = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder({ label: 'steer-check-readback' });
    encoder.copyBufferToBuffer(source, 0, staging, 0, bytes);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const copy = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return copy;
  }

  async readAgents() {
    return unpackAgents(await this.readBuffer(this.agentsIn, this.capacity * AGENT_STRIDE_BYTES));
  }

  // Runs only the grid and the coarse field once, then returns the raw and blurred channels.
  async sampleField() {
    const encoder = this.device.createCommandEncoder({ label: 'steer-check-field' });
    this.grid.encode(encoder, this.agentsIn, this.paramsBuffer);
    this.field.encode(encoder, this.agentsIn, this.grid.buffers, this.paramsBuffer);
    this.device.queue.submit([encoder.finish()]);
    const { raw, blurred, threatAccumulator } = this.field.buffers;
    return {
      raw: new Float32Array(await this.readBuffer(raw, raw.size)),
      blurred: new Float32Array(await this.readBuffer(blurred, blurred.size)),
      threatAccumulator: new Uint32Array(await this.readBuffer(threatAccumulator, threatAccumulator.size)),
    };
  }
}

// Every agent sits in one coarse cell, so each accumulate workgroup takes the single-cell fast
// path. Threat 3.0 written in fixed point must land in channel 5, decay by 0.85 on the next
// convert, and leave the accumulator zeroed. An interior cell's blur keeps 4 / 16 of a spike.
async function fieldFailure(harness, count, coarseCell) {
  const channel = (values, cell, index) => values[cell * COARSE_CHANNELS + index];
  harness.device.queue.writeBuffer(harness.field.buffers.threatAccumulator, coarseCell * 4, new Uint32Array([3 * 256]));
  const first = await harness.sampleField();
  const second = await harness.sampleField();
  let total = 0;
  for (let value = 0; value < first.raw.length; value += 1) if (value % COARSE_CHANNELS < SPECIES_NAMES.length) total += first.raw[value];
  if (channel(first.raw, coarseCell, CHASER) !== count || total !== count) {
    return `raw density ${channel(first.raw, coarseCell, CHASER)} in the seeded cell, ${total} in total, expected ${count}`;
  }
  if (channel(first.blurred, coarseCell, CHASER) !== count / 4) return `blurred density ${channel(first.blurred, coarseCell, CHASER)}, expected ${count / 4}`;
  const threats = [channel(first.raw, coarseCell, 5), channel(second.raw, coarseCell, 5)];
  if (threats[0] !== 3 || Math.abs(threats[1] - 3 * 0.85) > 1e-5) return `threat ${threats.join(' then ')}, expected 3 then 2.55`;
  if (first.threatAccumulator.some((value) => value !== 0)) return 'threat accumulator was not zeroed';
  return null;
}

function speciesWith(index, overrides) {
  return defaultSpecies().map((row, rowIndex) => (rowIndex === index ? { ...row, ...overrides } : row));
}

// (a) 20000 Chasers seeded uniformly close on the player: mean distance drops at least 30 percent.
async function checkSeek(gpu, common) {
  const count = 20000;
  const random = randomSource(1);
  const positions = uniformPositions(count, random);
  const harness = new Harness(gpu, common, count);
  await harness.initialize();
  harness.seed(packAgents(positions, CHASER, random), defaultSpecies());
  const initialMean = mean(positions.map(([x, y]) => distanceToPlayer({ x, y })));
  await harness.run(120);
  const agents = await harness.readAgents();
  const failure = validityFailure(agents);
  if (failure) return { pass: false, detail: `seek: ${failure}` };
  const finalMean = mean(agents.map(distanceToPlayer));
  const reduction = 1 - finalMean / initialMean;
  const pingPongProblem = await pingPongFailure(harness);
  return {
    pass: reduction >= 0.3 && pingPongProblem === null,
    detail: `seek mean distance ${initialMean.toFixed(3)} -> ${finalMean.toFixed(3)} (reduction ${(reduction * 100).toFixed(1)}%, need >= 30%), ping-pong ${pingPongProblem ?? 'valid with no bind group rebuilds'}`,
  };
}

// Alternates agentsIn and agentsOut every step with no copy back, as a frame loop would.
// After the first frame in each direction, no step may create a bind group.
async function pingPongFailure(harness) {
  const creations = () => harness.field.bindGroupCache.creationCount + harness.steering.bindGroupCache.creationCount;
  const encodePingPongStep = (encoder, source, target) => {
    harness.grid.encode(encoder, source, harness.paramsBuffer);
    harness.field.encode(encoder, source, harness.grid.buffers, harness.paramsBuffer);
    harness.steering.encode(encoder, source, target, harness.grid.buffers, harness.field.buffers.blurred, harness.speciesBuffer, harness.paramsBuffer);
  };
  let creationsAfterWarmUp = 0;
  for (let step = 0; step < 8; step += 1) {
    const encoder = harness.device.createCommandEncoder({ label: 'steer-check-ping-pong' });
    const forward = step % 2 === 0;
    encodePingPongStep(encoder, forward ? harness.agentsIn : harness.agentsOut, forward ? harness.agentsOut : harness.agentsIn);
    harness.device.queue.submit([encoder.finish()]);
    if (step === 1) creationsAfterWarmUp = creations();
  }
  const rebuilds = creations() - creationsAfterWarmUp;
  if (rebuilds !== 0) return `created ${rebuilds} bind group sets on alternating frames`;
  // An even number of steps leaves the newest agents in agentsIn.
  return validityFailure(await harness.readAgents());
}

// (b) All 20000 agents in one grid cell for 10 steps. The neighbor cap bounds the work; the
// per-step completion time is printed for information only and never asserted.
async function checkDenseCell(gpu, common) {
  const count = 20000;
  const random = randomSource(2);
  const harness = new Harness(gpu, common, count);
  await harness.initialize();
  const cellOrigin = [80 * NEIGHBOR_RADIUS, 45 * NEIGHBOR_RADIUS];
  const positions = Array.from({ length: count }, () => [
    cellOrigin[0] + (0.05 + 0.9 * random()) * NEIGHBOR_RADIUS,
    cellOrigin[1] + (0.05 + 0.9 * random()) * NEIGHBOR_RADIUS,
  ]);
  harness.seed(packAgents(positions, CHASER, random), defaultSpecies());
  const coarseCell = Math.floor(cellOrigin[0] / (ARENA_WIDTH / COARSE_COLUMNS)) + Math.floor(cellOrigin[1] / (ARENA_HEIGHT / COARSE_ROWS)) * COARSE_COLUMNS;
  const fieldProblem = await fieldFailure(harness, count, coarseCell);
  if (fieldProblem) return { pass: false, detail: `dense cell field: ${fieldProblem}` };
  await harness.device.queue.onSubmittedWorkDone();
  const stepMilliseconds = [];
  for (let step = 0; step < 10; step += 1) {
    const encoder = harness.device.createCommandEncoder({ label: 'steer-check-dense-step' });
    harness.encodeStep(encoder);
    const started = performance.now();
    harness.device.queue.submit([encoder.finish()]);
    await harness.device.queue.onSubmittedWorkDone();
    stepMilliseconds.push(performance.now() - started);
  }
  const agents = await harness.readAgents();
  const failure = validityFailure(agents);
  const timings = stepMilliseconds.map((milliseconds) => milliseconds.toFixed(1)).join('/');
  return { pass: failure === null, detail: `dense cell field exact, agents ${failure ?? 'valid'}, step ms ${timings} (informational)` };
}

// (c) A Lattice square seeded at 0.2 neighbor radii holds its spacing: the mean nearest-neighbor
// distance after 120 steps is within 25 percent of the density-implied spacing.
async function checkLatticeSpacing(gpu, common) {
  const side = 48;
  const spacing = 0.2 * NEIGHBOR_RADIUS;
  const random = randomSource(3);
  const positions = [];
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      const jitter = () => (random() - 0.5) * 0.1 * spacing;
      positions.push([PLAYER[0] + (column - side / 2) * spacing + jitter(), PLAYER[1] + (row - side / 2) * spacing + jitter()]);
    }
  }
  const harness = new Harness(gpu, common, positions.length);
  await harness.initialize();
  harness.seed(packAgents(positions, LATTICE, random), defaultSpecies());
  const initialDistance = meanNearestNeighborDistance(positions.map(([x, y]) => ({ x, y })));
  await harness.run(120);
  const agents = await harness.readAgents();
  const failure = validityFailure(agents);
  if (failure) return { pass: false, detail: `lattice: ${failure}` };
  const finalDistance = meanNearestNeighborDistance(agents);
  // Averaged separation cancels inside a uniform crowd, so the spacing a sheet holds is the one
  // its coarse pressure allows: targetDensity agents per coarse cell.
  const coarseCellArea = (ARENA_WIDTH / COARSE_COLUMNS) * (ARENA_HEIGHT / COARSE_ROWS);
  const expectedSpacing = Math.sqrt(coarseCellArea / defaultSpecies()[LATTICE].targetDensity);
  const ratio = finalDistance / expectedSpacing;
  return {
    pass: ratio >= 0.75 && ratio <= 1.25,
    detail: `lattice nearest neighbor ${initialDistance.toFixed(4)} -> ${finalDistance.toFixed(4)}, density-implied spacing ${expectedSpacing.toFixed(4)} (ratio ${ratio.toFixed(2)}, need 0.75 to 1.25)`,
  };
}

// (d) 65536 Chasers for 600 steps: with pressure the swarm's bounding radius around the player
// stays above 1.5; with pressure 0 it collapses below 0.8.
async function checkPressure(gpu, common) {
  const count = 65536;
  const harness = new Harness(gpu, common, count);
  await harness.initialize();
  const radii = {};
  for (const [label, pressure] of [['pressure', 0.5], ['none', 0]]) {
    const random = randomSource(4);
    harness.seed(packAgents(uniformPositions(count, random), CHASER, random), speciesWith(CHASER, { pressure, targetDensity: 40 }));
    await harness.run(600);
    const agents = await harness.readAgents();
    const failure = validityFailure(agents);
    if (failure) return { pass: false, detail: `pressure ${label}: ${failure}` };
    const distances = agents.map(distanceToPlayer);
    radii[label] = { bounding: Math.max(...distances), ninetieth: percentile(distances, 0.9), mean: mean(distances) };
  }
  const describe = ({ bounding, ninetieth, mean: average }) => `bounding ${bounding.toFixed(3)} p90 ${ninetieth.toFixed(3)} mean ${average.toFixed(3)}`;
  return {
    pass: radii.pressure.bounding > 1.5 && radii.none.bounding < 0.8,
    detail: `pressure radius [${describe(radii.pressure)}] (need bounding > 1.5), no pressure [${describe(radii.none)}] (need bounding < 0.8)`,
  };
}

async function runCheck() {
  const gpu = await createGpuContext(document.getElementById('canvas'));
  let lostReason = null;
  gpu.device.lost.then((info) => { lostReason = info.message || info.reason || 'lost'; });
  gpu.device.addEventListener('uncapturederror', (event) => { console.error(`uncaptured WebGPU error: ${event.error.message}`); });
  const common = substituteConstants(await loadShader('common'), SHADER_CONSTANTS);
  const results = [];
  for (const check of [checkSeek, checkDenseCell, checkLatticeSpacing, checkPressure]) {
    results.push(await check(gpu, common));
    if (lostReason !== null) return { pass: false, detail: `device lost: ${lostReason}; ${results.map((result) => result.detail).join('; ')}` };
  }
  const verdicts = results.map((result) => `${result.pass ? 'PASS' : 'FAIL'} ${result.detail}`);
  return { pass: results.every((result) => result.pass), detail: verdicts.join('; ') };
}

runCheck().then(
  (result) => { window.__steerCheck = result; },
  (error) => { window.__steerCheck = { pass: false, detail: `exception: ${error.message}` }; },
);
