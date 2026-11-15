// Hives seek targets for steer-check.js (agent flag bits 16 and 17, seekPointFor in common.wgsl).
// (i1) Steering alone, with seek points P1 (5, 4.5) and P2 (13, 4.5) and 200 Chasers in a unit disc
//      around (6.5, 4.5), so P1 is the nearer point for every agent. Over 60 steps target 0 (every
//      agent outside hives) closes on P1 (mean x below the start less 0.4) and target 2 (seek point
//      2) moves toward P2 (mean x above the start plus 0.4). One step from the seeded state: target 1
//      (P1, the nearest anyway) and target 2 with no second seek point (it falls back to the nearest)
//      give target 0's velocities within ONE_STEP_TOLERANCE (runs are not bit-identical: the grid
//      scatter's atomics order the fine pass's samples differently each run), while target 2 with
//      a second point differs by more than ONE_STEP_DIFFERENCE.
// (i2) A whole Simulation with P1 (8, 9) and P2 (24, 9) and one emitting gate row at (13.5, 9),
//      nearer P1: spawns from the row owned by seat 1 (owner 0, target seat 2) carry target bits 2 and
//      move toward P2 over 90 steps; from the same row unowned they carry 0 and move toward P1.
import { AGENT_FLAG_ALIVE, AGENT_OFFSETS, AGENT_STRIDE_BYTES, AGENT_TARGET_MASK, AGENT_TARGET_SHIFT, SPECIES_COUNT } from '/src/sim/layout.js';
import { Simulation } from '/src/sim/simulation.js';
import { defaultSpecies } from '/src/sim/species.js';

const GROUP_SIZE = 200;
const GROUP_CENTER = [6.5, 4.5];
const FIRST_POINT = [5, 4.5];
const SECOND_POINT = [13, 4.5];
const STEER_STEPS = 60;
const MINIMUM_SHIFT = 0.4;
const ONE_STEP_TOLERANCE = 1e-5;
const ONE_STEP_DIFFERENCE = 1e-2;

function withTarget(bytes, seekTarget) {
  const copy = bytes.slice(0);
  const view = new DataView(copy);
  for (let base = 0; base < copy.byteLength; base += AGENT_STRIDE_BYTES) {
    view.setUint32(base + AGENT_OFFSETS.flags, AGENT_FLAG_ALIVE | (seekTarget << AGENT_TARGET_SHIFT), true);
  }
  return copy;
}

// helpers: { Harness, packAgents, randomSource, validityFailure, mean, chaser } from steer-check.js.
async function steerRun(gpu, common, helpers, bytes, { steps = STEER_STEPS, second = true } = {}) {
  const harness = new helpers.Harness(gpu, common, GROUP_SIZE);
  harness.secondPlayerPosition = second ? SECOND_POINT : null;
  await harness.initialize();
  harness.device.queue.writeBuffer(harness.paramsBuffer, 8, new Float32Array(FIRST_POINT));
  harness.seed(bytes, defaultSpecies());
  await harness.run(steps);
  const view = new DataView(await harness.readBuffer(harness.agentsIn, GROUP_SIZE * AGENT_STRIDE_BYTES));
  const velocities = Array.from({ length: GROUP_SIZE }, (unused, index) => [0, 4].map((offset) => view.getFloat32(index * AGENT_STRIDE_BYTES + AGENT_OFFSETS.velocity + offset, true)));
  return { velocities, agents: await harness.readAgents() };
}

function largestVelocityDifference(first, second) {
  return first.velocities.reduce((largest, [x, y], index) => Math.max(largest, Math.abs(x - second.velocities[index][0]), Math.abs(y - second.velocities[index][1])), 0);
}

export async function checkSeekTargets(gpu, common, helpers) {
  const random = helpers.randomSource(11);
  const positions = Array.from({ length: GROUP_SIZE }, () => {
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random());
    return [GROUP_CENTER[0] + radius * Math.cos(angle), GROUP_CENTER[1] + radius * Math.sin(angle)];
  });
  const bytes = helpers.packAgents(positions, helpers.chaser, random);
  const nearest = await steerRun(gpu, common, helpers, bytes);
  const aimed = await steerRun(gpu, common, helpers, withTarget(bytes, 2));
  const failure = [nearest, aimed].map((run) => helpers.validityFailure(run.agents)).find(Boolean);
  if (failure) return { pass: false, detail: `seek targets: ${failure}` };
  const nearestX = helpers.mean(nearest.agents.map((agent) => agent.x));
  const aimedX = helpers.mean(aimed.agents.map((agent) => agent.x));
  const one = (flagBytes, second = true) => steerRun(gpu, common, helpers, flagBytes, { steps: 1, second });
  const base = await one(bytes);
  const loneBase = await one(bytes, false);
  const firstDifference = largestVelocityDifference(await one(withTarget(bytes, 1)), base);
  const loneDifference = largestVelocityDifference(await one(withTarget(bytes, 2), false), loneBase);
  const aimedDifference = largestVelocityDifference(await one(withTarget(bytes, 2)), base);
  const spawned = await checkSpawnTargets(gpu);
  const pass = nearestX < GROUP_CENTER[0] - MINIMUM_SHIFT && aimedX > GROUP_CENTER[0] + MINIMUM_SHIFT
    && firstDifference <= ONE_STEP_TOLERANCE && loneDifference <= ONE_STEP_TOLERANCE && aimedDifference > ONE_STEP_DIFFERENCE && spawned.pass;
  return {
    pass,
    detail: `seek targets: (i1) target 0 mean x ${nearestX.toFixed(2)} (need < ${(GROUP_CENTER[0] - MINIMUM_SHIFT).toFixed(1)}), target 2 mean x ${aimedX.toFixed(2)} (need > ${(GROUP_CENTER[0] + MINIMUM_SHIFT).toFixed(1)}), `
      + `one step velocity difference from target 0: target 1 ${firstDifference.toExponential(2)}, target 2 without a second point ${loneDifference.toExponential(2)} (need <= ${ONE_STEP_TOLERANCE}), `
      + `target 2 ${aimedDifference.toFixed(3)} (need > ${ONE_STEP_DIFFERENCE}); (i2) ${spawned.detail}`,
  };
}

const SPAWN_CAPACITY = 4096;
const SPAWN_FIRST_POINT = [8, 9];
const SPAWN_SECOND_POINT = [24, 9];
const HIVE = { x: 13.5, y: 9, radius: 0.6, emit: 1, species: 0 };
const SPAWN_COUNT = 300;
const SPAWN_STEPS = 90;
const STEP_SECONDS = 1 / 60;

async function readAgents(device, buffer, count) {
  const bytes = count * AGENT_STRIDE_BYTES;
  const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const encoder = device.createCommandEncoder({ label: 'steer-targets-readback' });
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const view = new DataView(staging.getMappedRange().slice(0));
  staging.destroy();
  const agents = [];
  for (let base = 0; base < bytes; base += AGENT_STRIDE_BYTES) {
    const flags = view.getUint32(base + AGENT_OFFSETS.flags, true);
    if ((flags & AGENT_FLAG_ALIVE) !== 0) agents.push({ x: view.getFloat32(base + AGENT_OFFSETS.position, true), seekTarget: (flags & AGENT_TARGET_MASK) >>> AGENT_TARGET_SHIFT });
  }
  return agents;
}

async function spawnRun(gpu, gate) {
  const { device } = gpu;
  const simulation = await Simulation.create(gpu, { capacity: SPAWN_CAPACITY, shares: [1, 0, 0, 0, 0] });
  simulation.setPlayer(...SPAWN_FIRST_POINT);
  simulation.setSecondPlayer(...SPAWN_SECOND_POINT);
  const table = { gates: [gate], speciesBias: 1 };
  const budget = new Uint32Array(SPECIES_COUNT);
  for (let step = 0; step <= SPAWN_STEPS; step += 1) {
    budget[0] = step === 0 ? SPAWN_COUNT : 0;
    const encoder = device.createCommandEncoder({ label: 'steer-targets-step' });
    simulation.step(encoder, STEP_SECONDS, budget, table);
    device.queue.submit([encoder.finish()]);
    simulation.afterSubmit();
    if (step % 20 === 0) await device.queue.onSubmittedWorkDone();
  }
  await device.queue.onSubmittedWorkDone();
  const agents = await readAgents(device, simulation.agentsBuffer, SPAWN_CAPACITY);
  simulation.destroy();
  return agents;
}

async function checkSpawnTargets(gpu) {
  const owned = await spawnRun(gpu, { ...HIVE, owner: 0, target: 1 });
  const neutral = await spawnRun(gpu, HIVE);
  const ownedX = owned.length > 0 ? owned.reduce((sum, agent) => sum + agent.x, 0) / owned.length : NaN;
  const neutralX = neutral.length > 0 ? neutral.reduce((sum, agent) => sum + agent.x, 0) / neutral.length : NaN;
  const ownedBits = owned.every((agent) => agent.seekTarget === 2);
  const neutralBits = neutral.every((agent) => agent.seekTarget === 0);
  const enough = owned.length >= SPAWN_COUNT * 0.9 && neutral.length >= SPAWN_COUNT * 0.9;
  return {
    pass: enough && ownedBits && neutralBits && ownedX > HIVE.x + MINIMUM_SHIFT && neutralX < HIVE.x - MINIMUM_SHIFT,
    detail: `owned hive spawns ${owned.length} with target 2 ${ownedBits} [${[0, 1, 2, 3].map((value) => owned.filter((agent) => agent.seekTarget === value).length).join(' ')}], mean x ${ownedX.toFixed(2)} (need > ${(HIVE.x + MINIMUM_SHIFT).toFixed(1)}); `
      + `neutral hive spawns ${neutral.length} with target 0 ${neutralBits}, mean x ${neutralX.toFixed(2)} (need < ${(HIVE.x - MINIMUM_SHIFT).toFixed(1)})`,
  };
}
