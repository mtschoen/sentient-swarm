// Dodge (danger channel 6 and FIELD_DODGE) for steer-check.js.
// (j1) Field: danger written into the accumulator's danger words lands undecayed in channel 6 of
//      the raw field, the accumulator is zeroed, the next fold sees none, and the threat words are untouched.
// (j2) Steering: a one-cell-wide ridge of danger (4 units down one coarse column, rewritten every
//      step as live projectiles would) over sparse Chasers on both sides, 3 steps. With dodge 1.5 each
//      agent's x velocity moves away from the ridge by at least MINIMUM_DODGE_SPEED compared with the
//      same layout and no ridge; agents past the stencil (two cells out) are barely moved.
// (j3) Neutral: with dodge 0 (every Chaser, and the shipped Orbiter) the ridge changes no velocity or
//      position bit. Agents are sparse (no neighbor inside the neighbor radius), so runs are
//      bit-reproducible despite the grid scatter's atomics.
import { AGENT_OFFSETS, AGENT_STRIDE_BYTES, COARSE_CELL_SIZE, COARSE_CHANNELS, COARSE_COLUMNS, COARSE_ROWS } from '/src/sim/layout.js';
import { defaultSpecies } from '/src/sim/species.js';

const CELLS = COARSE_COLUMNS * COARSE_ROWS;
const DANGER_CHANNEL = 6;
const FIXED_POINT = 256;
const RIDGE_COLUMN = 32;
const RIDGE_UNITS = 4;
const RIDGE_ROWS = 36;
const DODGE_STEPS = 3;
const MINIMUM_DODGE_SPEED = 0.1;
const FAR_DODGE_SPEED = 0.03;
// Column 31 is x 7.75 to 8, column 33 is 8.25 to 8.5; the stencil reaches two columns out of the ridge (30 to 34).
const NEAR_X = [7.85, 8.35];
const EDGE_X = [7.55, 8.65];
const FAR_X = [6.2, 9.8];
const ROW_Y = [1, 1.9, 2.8, 3.7, 5.3, 6.2, 7.1, 8];

function layout() {
  return [...NEAR_X, ...EDGE_X, ...FAR_X].flatMap((x) => ROW_Y.map((y) => [x, y]));
}

function writeRidge(harness) {
  const words = new Uint32Array(CELLS * 2);
  for (let row = 0; row < RIDGE_ROWS; row += 1) words[CELLS + row * COARSE_COLUMNS + RIDGE_COLUMN] = RIDGE_UNITS * FIXED_POINT;
  harness.device.queue.writeBuffer(harness.field.buffers.threatAccumulator, 0, words);
}

async function fieldFailure(gpu, common, helpers) {
  const harness = new helpers.Harness(gpu, common, 64);
  await harness.initialize();
  harness.seed(helpers.packAgents([[2, 2]], helpers.chaser, helpers.randomSource(3)), defaultSpecies());
  const cell = 20 * COARSE_COLUMNS + 40;
  if (harness.field.buffers.threatAccumulator.size !== 2 * CELLS * 4) return `accumulator is ${harness.field.buffers.threatAccumulator.size} bytes, expected ${2 * CELLS * 4}`;
  harness.device.queue.writeBuffer(harness.field.buffers.threatAccumulator, (CELLS + cell) * 4, new Uint32Array([3 * FIXED_POINT]));
  harness.device.queue.writeBuffer(harness.field.buffers.threatAccumulator, cell * 4, new Uint32Array([2 * FIXED_POINT]));
  const first = await harness.sampleField();
  const second = await harness.sampleField();
  const channel = (values, index) => values[cell * COARSE_CHANNELS + index];
  if (channel(first.raw, DANGER_CHANNEL) !== 3) return `danger ${channel(first.raw, DANGER_CHANNEL)}, expected 3`;
  if (channel(first.raw, 5) !== 2) return `threat ${channel(first.raw, 5)}, expected 2 (the threat words must stay cell-indexed)`;
  if (channel(first.blurred, DANGER_CHANNEL) !== 3 / 4) return `blurred danger ${channel(first.blurred, DANGER_CHANNEL)}, expected 0.75`;
  if (channel(second.raw, DANGER_CHANNEL) !== 0) return `danger ${channel(second.raw, DANGER_CHANNEL)} on the next fold, expected 0 (no decay carry)`;
  if (first.threatAccumulator.some((value) => value !== 0)) return 'accumulator was not zeroed';
  if (first.raw.some((value, index) => index % COARSE_CHANNELS === 7 && value !== 0)) return 'padding channel 7 is not zero';
  return null;
}

async function velocities(gpu, common, helpers, { species, rows, ridge }) {
  const positions = layout();
  const random = helpers.randomSource(5);
  const harness = new helpers.Harness(gpu, common, positions.length);
  await harness.initialize();
  harness.seed(helpers.packAgents(positions, species, random), rows);
  for (let step = 0; step < DODGE_STEPS; step += 1) {
    if (ridge) writeRidge(harness);
    await harness.run(1);
  }
  const view = new DataView(await harness.readBuffer(harness.agentsIn, positions.length * AGENT_STRIDE_BYTES));
  return positions.map(([x, y], index) => {
    const base = index * AGENT_STRIDE_BYTES;
    const read = (offset) => view.getFloat32(base + offset, true);
    return { x, y, velocityX: read(AGENT_OFFSETS.velocity), velocityY: read(AGENT_OFFSETS.velocity + 4), positionX: read(AGENT_OFFSETS.position), positionY: read(AGENT_OFFSETS.position + 4) };
  });
}

function identical(first, second) {
  return first.every((agent, index) => Object.keys(agent).every((key) => Object.is(agent[key], second[index][key])));
}

export async function checkDodge(gpu, common, helpers) {
  const details = [];
  let pass = true;
  const verdict = (condition, text) => { pass = pass && condition; details.push(`${condition ? 'ok' : 'FAIL'} ${text}`); };
  const failure = await fieldFailure(gpu, common, helpers);
  verdict(failure === null, `danger field ${failure ?? 'folds undecayed into channel 6 and zeroes its words'}`);

  const chaser = helpers.chaser;
  const dodging = defaultSpecies();
  const withRidge = await velocities(gpu, common, helpers, { species: chaser, rows: dodging, ridge: true });
  const control = await velocities(gpu, common, helpers, { species: chaser, rows: dodging, ridge: false });
  const rideX = (RIDGE_COLUMN + 0.5) * COARSE_CELL_SIZE;
  const awaySpeed = (index) => (withRidge[index].velocityX - control[index].velocityX) * Math.sign(withRidge[index].x - rideX);
  const groups = { near: NEAR_X, edge: EDGE_X, far: FAR_X };
  const speeds = Object.fromEntries(Object.entries(groups).map(([name, columns]) => {
    const indices = withRidge.map((agent, index) => index).filter((index) => columns.includes(withRidge[index].x));
    return [name, indices.map(awaySpeed)];
  }));
  const least = (values) => Math.min(...values);
  const most = (values) => Math.max(...values.map(Math.abs));
  verdict(least(speeds.near) >= MINIMUM_DODGE_SPEED, `near agents gain at least ${MINIMUM_DODGE_SPEED} away from the ridge in ${DODGE_STEPS} steps (least ${least(speeds.near).toFixed(3)})`);
  verdict(least(speeds.edge) >= MINIMUM_DODGE_SPEED / 2, `agents two cells out gain at least ${MINIMUM_DODGE_SPEED / 2} (least ${least(speeds.edge).toFixed(3)}, so the plain stencil reaches them)`);
  verdict(most(speeds.far) <= FAR_DODGE_SPEED, `agents beyond the stencil move by at most ${FAR_DODGE_SPEED} (most ${most(speeds.far).toFixed(3)})`);

  const stoic = defaultSpecies().map((row) => ({ ...row, dodge: 0 }));
  verdict(identical(await velocities(gpu, common, helpers, { species: chaser, rows: stoic, ridge: true }), await velocities(gpu, common, helpers, { species: chaser, rows: stoic, ridge: false })), 'dodge 0 Chasers are bit-identical with and without the ridge');
  const orbiter = 1;
  verdict(identical(await velocities(gpu, common, helpers, { species: orbiter, rows: dodging, ridge: true }), await velocities(gpu, common, helpers, { species: orbiter, rows: dodging, ridge: false })), 'the dodge 0 Orbiter row is bit-identical with and without the ridge');
  return { pass, detail: `dodge: ${details.join(', ')}` };
}
