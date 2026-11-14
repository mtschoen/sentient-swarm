import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GATE_SCHEDULE, GATE_FADE_SECONDS, MAXIMUM_SPAWN_GATES, SpawnDirector, TELEGRAPH_SECONDS, inAimLane, validatedSchedule } from '../../src/sim/spawn-director.js';
import { SpawnPressure } from '../../src/sim/spawner.js';
import { WORLD_HEIGHT, WORLD_WIDTH } from '../../src/sim/layout.js';
import { centeredViewBounds } from './centered-view-bounds.js';

const STEP_SECONDS = 1 / 60;
const SAFE_DISTANCE = 4;
const EQUAL_SHARES = [0.2, 0.2, 0.2, 0.2, 0.2];

// A seeded linear congruential generator, so every run sees the same draws.
function seededRandom(seed = 12345) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// The player walks a slow figure eight through the arena.
function playerAt(seconds) {
  return {
    playerX: WORLD_WIDTH / 2 + 5 * Math.sin(seconds * 0.4),
    playerY: WORLD_HEIGHT / 2 + 2.5 * Math.sin(seconds * 0.8),
  };
}

// Steps the director for seconds of injected time after its first fill, calling observe(director,
// elapsedSeconds) after every step.
function run(director, seconds, observe = () => {}, { filling = false, start = 0 } = {}) {
  const steps = Math.round(seconds / STEP_SECONDS);
  for (let step = 1; step <= steps; step += 1) {
    const elapsed = start + step * STEP_SECONDS;
    director.update(STEP_SECONDS, { ...playerAt(elapsed), safeDistance: SAFE_DISTANCE, filling, shares: EQUAL_SHARES });
    observe(director, elapsed);
  }
}

test('a reset opens gateCount gates fully, and all of them emit during the first fill', () => {
  const director = new SpawnDirector({ random: seededRandom() });
  director.update(STEP_SECONDS, { ...playerAt(0), safeDistance: SAFE_DISTANCE, filling: true, shares: EQUAL_SHARES });
  assert.equal(director.gates.length, DEFAULT_GATE_SCHEDULE.gateCount);
  director.gates.forEach((gate) => {
    assert.equal(gate.open, 1);
    assert.equal(gate.emit, 1);
  });
  assert.equal(director.wave.emitting, true);
});

test('emitting gates never lie within the safe radius plus their own radius of the player', () => {
  const director = new SpawnDirector({ random: seededRandom(7) });
  let emittingSteps = 0;
  run(director, 180, (current, elapsed) => {
    const { playerX, playerY } = playerAt(elapsed);
    current.gates.filter((gate) => gate.emit > 0).forEach((gate) => {
      emittingSteps += 1;
      assert.ok(Math.hypot(gate.x - playerX, gate.y - playerY) >= SAFE_DISTANCE + gate.radius, `gate at ${gate.x}, ${gate.y} emits ${Math.hypot(gate.x - playerX, gate.y - playerY)} from the player`);
    });
  });
  assert.ok(emittingSteps > 1000, `only ${emittingSteps} emitting gate steps`);
});

test('gates open, drift, close and are replaced elsewhere over a run', () => {
  const director = new SpawnDirector({ random: seededRandom(3) });
  const seen = new Set();
  const lifetimes = new Map();
  let maximumStep = 0;
  let previous = new Map();
  run(director, 120, (current) => {
    const positions = new Map();
    current.gates.forEach((gate) => {
      seen.add(gate);
      lifetimes.set(gate, gate.age);
      if (previous.has(gate)) {
        const [x, y] = previous.get(gate);
        maximumStep = Math.max(maximumStep, Math.hypot(gate.x - x, gate.y - y));
      }
      positions.set(gate, [gate.x, gate.y]);
      assert.ok(gate.x > 0 && gate.x < WORLD_WIDTH && gate.y > 0 && gate.y < WORLD_HEIGHT);
      assert.ok(gate.open >= 0 && gate.open <= 1);
    });
    previous = positions;
    assert.ok(current.gates.filter((gate) => !gate.closing).length <= DEFAULT_GATE_SCHEDULE.gateCount);
  });
  // 120 s at a 14 s lifetime and 3 gates opens many more than the first three.
  assert.ok(seen.size >= 15, `only ${seen.size} gates over the run`);
  for (const age of lifetimes.values()) assert.ok(age <= DEFAULT_GATE_SCHEDULE.gateLifetimeSeconds * 1.25 + STEP_SECONDS);
  assert.ok(maximumStep > 0, 'gates should drift');
  assert.ok(maximumStep <= DEFAULT_GATE_SCHEDULE.driftSpeed * STEP_SECONDS + 1e-9, `drift step ${maximumStep}`);
});

test('a new gate fades open over GATE_FADE_SECONDS before it can emit', () => {
  const director = new SpawnDirector({ random: seededRandom(11), gateLifetimeSeconds: 3 });
  let sawFadingIn = false;
  run(director, 30, (current) => {
    current.gates.forEach((gate) => {
      if (!gate.closing && gate.age < GATE_FADE_SECONDS) {
        sawFadingIn = true;
        assert.ok(gate.open < 1);
        assert.equal(gate.emit, 0);
      }
    });
  });
  assert.ok(sawFadingIn);
});

test('waves emit for about waveSeconds every wavePeriodSeconds, with quiet gaps between them', () => {
  const director = new SpawnDirector({ random: seededRandom(5) });
  const windows = [];
  let current = null;
  run(director, 60, (state, elapsed) => {
    const emitting = state.wave.emitting;
    if (emitting && current === null) current = { start: elapsed, end: elapsed };
    else if (emitting) current.end = elapsed;
    else if (current !== null) {
      windows.push(current);
      current = null;
    }
    assert.ok(state.gates.filter((gate) => gate.emit > 0).length <= 1, 'one gate per wave');
  });
  assert.ok(windows.length >= 30, `only ${windows.length} waves in 60 s`);
  for (let index = 1; index < windows.length; index += 1) {
    const gap = windows[index].start - windows[index - 1].end;
    assert.ok(gap >= 0.2, `gap ${gap} between waves ${index - 1} and ${index}`);
  }
  const typical = windows.map((window) => window.end - window.start + STEP_SECONDS).sort((first, second) => first - second)[Math.floor(windows.length / 2)];
  assert.ok(Math.abs(typical - DEFAULT_GATE_SCHEDULE.waveSeconds) < 0.05, `median wave ${typical}`);
});

test('the gate picked for the next wave is telegraphed before it emits', () => {
  const director = new SpawnDirector({ random: seededRandom(9) });
  let telegraphedThenEmitted = 0;
  let telegraphed = null;
  run(director, 20, (state) => {
    const emitter = state.gates.find((gate) => gate.emit > 0);
    if (emitter && telegraphed === emitter) telegraphedThenEmitted += 1;
    const next = state.gates.find((gate) => gate.telegraph > 0);
    if (next) telegraphed = next;
  });
  assert.ok(telegraphedThenEmitted > 5);
});

test('setSchedule validates, and a lower gateCount closes the extras', () => {
  const director = new SpawnDirector({ random: seededRandom() });
  run(director, 2);
  assert.throws(() => director.setSchedule({ gateCount: 0 }), RangeError);
  assert.throws(() => director.setSchedule({ gateCount: MAXIMUM_SPAWN_GATES + 1 }), RangeError);
  assert.throws(() => director.setSchedule({ wavePeriodSeconds: 0 }), RangeError);
  assert.throws(() => director.setSchedule({ driftSpeed: -1 }), RangeError);
  assert.equal(director.schedule.gateCount, DEFAULT_GATE_SCHEDULE.gateCount);
  director.setSchedule({ gateCount: 1, gateRadius: 1.2 });
  run(director, GATE_FADE_SECONDS + 0.1, () => {}, { start: 2 });
  assert.equal(director.gates.length, 1);
  assert.equal(director.gates[0].radius, 1.2);
  assert.ok(director.spawnGates.gates.length <= MAXIMUM_SPAWN_GATES);
});

test('spawnGates lists emitting gates first, at most MAXIMUM_SPAWN_GATES, with the species bias', () => {
  const director = new SpawnDirector({ random: seededRandom(2), gateCount: 4, speciesBias: 0.4 });
  run(director, 10, (state) => {
    const { gates, speciesBias } = state.spawnGates;
    assert.equal(speciesBias, 0.4);
    assert.ok(gates.length <= MAXIMUM_SPAWN_GATES);
    const firstQuiet = gates.findIndex((gate) => gate.emit === 0);
    if (firstQuiet !== -1) assert.ok(gates.slice(firstQuiet).every((gate) => gate.emit === 0));
  });
});

test('with waves, SpawnPressure spawns only while a gate emits and keeps its long-run refill rate', () => {
  const capacity = 60000;
  const director = new SpawnDirector({ random: seededRandom(4) });
  const pressure = new SpawnPressure({ capacity, floorFraction: 0.1, rampSeconds: 1000, ceilingFraction: 0.1 });
  // End the first fill: one step with nothing alive fills the frame cap, then stats show the floor.
  let alive = 0;
  let sequence = 0;
  let spawnedOutsideWaves = 0;
  let refilled = 0;
  const steps = Math.round(30 / STEP_SECONDS);
  for (let step = 0; step < steps; step += 1) {
    sequence += 1;
    director.update(STEP_SECONDS, { ...playerAt(step * STEP_SECONDS), safeDistance: SAFE_DISTANCE, filling: pressure.filling, shares: EQUAL_SHARES });
    const wasFilling = pressure.filling;
    const counts = pressure.update(STEP_SECONDS, { aliveTotal: alive, frameSequence: sequence - 1 }, EQUAL_SHARES, sequence, director.wave);
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (!director.wave.emitting) spawnedOutsideWaves += total;
    if (!wasFilling) refilled += total;
    // The player kills a tenth of the target every second, so a deficit is always building.
    alive = Math.max(0, alive + total - 0.1 * pressure.targetAlive * STEP_SECONDS);
  }
  assert.equal(spawnedOutsideWaves, 0);
  // Kills of 0.1 of the target per second sit under the 0.15 refill rate, so refills track them.
  const killed = 0.1 * pressure.targetAlive * 30;
  assert.ok(refilled > killed * 0.85 && refilled < killed * 1.15, `refilled ${refilled}, killed ${killed}`);
});

test('without waves, SpawnPressure keeps trickling every step (the wall band fallback)', () => {
  const pressure = new SpawnPressure({ capacity: 60000, floorFraction: 0.1 });
  pressure.update(STEP_SECONDS, null, EQUAL_SHARES, 1);
  pressure.update(STEP_SECONDS, { aliveTotal: 6000, frameSequence: 1 }, EQUAL_SHARES, 2);
  assert.equal(pressure.filling, false);
  const counts = pressure.update(1, { aliveTotal: 3000, frameSequence: 2 }, EQUAL_SHARES, 3);
  assert.ok(counts.reduce((sum, count) => sum + count, 0) > 0);
});

test('continuous mode emits from every open gate with no wave state', () => {
  const director = new SpawnDirector({ random: seededRandom(6) });
  director.update(STEP_SECONDS, { ...playerAt(0), safeDistance: SAFE_DISTANCE, filling: true, shares: EQUAL_SHARES });
  director.update(STEP_SECONDS, { ...playerAt(0), safeDistance: SAFE_DISTANCE, continuous: true, shares: EQUAL_SHARES });
  assert.equal(director.wave, null);
  assert.ok(director.gates.every((gate) => gate.emit === 1));
});

test('gates in the aim lane never emit a wave, and new gates avoid the lane', () => {
  const director = new SpawnDirector({ random: seededRandom(8), gateCount: 4 });
  const context = { playerX: 2, playerY: WORLD_HEIGHT / 2, aimX: 1, aimY: 0 };
  let emittingInLane = 0;
  let emittingOutside = 0;
  let openedInLane = 0;
  const steps = Math.round(60 / STEP_SECONDS);
  for (let step = 0; step < steps; step += 1) {
    director.update(STEP_SECONDS, { ...context, safeDistance: SAFE_DISTANCE, shares: EQUAL_SHARES });
    director.gates.forEach((gate) => {
      if (gate.emit > 0 && inAimLane(gate, gate.radius, context)) emittingInLane += 1;
      if (gate.emit > 0 && !inAimLane(gate, gate.radius, context)) emittingOutside += 1;
      if (gate.age <= STEP_SECONDS && inAimLane(gate, gate.radius, context)) openedInLane += 1;
    });
  }
  assert.equal(emittingInLane, 0);
  assert.ok(emittingOutside > 500, `${emittingOutside} emitting steps outside the lane`);
  assert.equal(openedInLane, 0);
});

test('a gate that stays in the aim lane closes after AIM_LANE_CLOSE_SECONDS', () => {
  const director = new SpawnDirector({ random: seededRandom(10), driftSpeed: 0 });
  const context = { playerX: 2, playerY: WORLD_HEIGHT / 2, safeDistance: SAFE_DISTANCE, shares: EQUAL_SHARES };
  director.update(STEP_SECONDS, context);
  const gate = director.gates[0];
  // Aim straight at the first gate from now on.
  const aim = { aimX: gate.x - context.playerX, aimY: gate.y - context.playerY };
  for (let step = 0; step < Math.round(1.9 / STEP_SECONDS); step += 1) director.update(STEP_SECONDS, { ...context, ...aim });
  assert.equal(gate.closing, false);
  for (let step = 0; step < Math.round(0.2 / STEP_SECONDS); step += 1) director.update(STEP_SECONDS, { ...context, ...aim });
  assert.equal(gate.closing, true);
});

test('DEFAULT_GATE_SCHEDULE pins every gate default, and the fade and telegraph times', () => {
  assert.deepEqual({ ...DEFAULT_GATE_SCHEDULE }, {
    gateCount: 3,
    gateLifetimeSeconds: 14,
    wavePeriodSeconds: 1.6,
    waveSeconds: 0.7,
    burstFraction: 0.25,
    driftSpeed: 0.3,
    gateRadius: 0.8,
    speciesBias: 0.7,
  });
  assert.equal(Object.isFrozen(DEFAULT_GATE_SCHEDULE), true);
  assert.equal(MAXIMUM_SPAWN_GATES, 4);
  assert.equal(GATE_FADE_SECONDS, 0.6);
  assert.equal(TELEGRAPH_SECONDS, 0.5);
  assert.deepEqual({ ...new SpawnDirector().schedule }, { ...DEFAULT_GATE_SCHEDULE });
});

test('validatedSchedule accepts the range edges and rejects each field just outside', () => {
  const edges = {
    gateLifetimeSeconds: [2, 120], wavePeriodSeconds: [0.2, 20], waveSeconds: [0.05, 5], burstFraction: [0.01, 1], driftSpeed: [0, 3], gateRadius: [0.2, 2], speciesBias: [0, 1],
  };
  for (const [name, [minimum, maximum]] of Object.entries(edges)) {
    assert.doesNotThrow(() => validatedSchedule({ ...DEFAULT_GATE_SCHEDULE, [name]: minimum }), name);
    assert.doesNotThrow(() => validatedSchedule({ ...DEFAULT_GATE_SCHEDULE, [name]: maximum }), name);
    assert.throws(() => validatedSchedule({ ...DEFAULT_GATE_SCHEDULE, [name]: minimum - 0.001 }), RangeError, name);
    assert.throws(() => validatedSchedule({ ...DEFAULT_GATE_SCHEDULE, [name]: maximum + 0.001 }), RangeError, name);
    assert.throws(() => validatedSchedule({ ...DEFAULT_GATE_SCHEDULE, [name]: NaN }), RangeError, name);
  }
  for (const gateCount of [0, 5, 1.5, NaN]) assert.throws(() => validatedSchedule({ ...DEFAULT_GATE_SCHEDULE, gateCount }), /gateCount/);
  assert.doesNotThrow(() => validatedSchedule({ ...DEFAULT_GATE_SCHEDULE, gateCount: 4 }));
});

// A phone in portrait or a tall window: the playable arena is a narrow strip of the world.
test('with narrow bounds every gate opens and drifts inside the bounds, centered on them by default', () => {
  const bounds = centeredViewBounds(0.5);
  const director = new SpawnDirector({ random: seededRandom(77), driftSpeed: 3 });
  let insideChecks = 0;
  for (let step = 0; step < 60 * 40; step += 1) {
    const seconds = step * STEP_SECONDS;
    const playerX = (bounds.minX + bounds.maxX) / 2 + 1.5 * Math.sin(seconds * 0.5);
    const playerY = (bounds.minY + bounds.maxY) / 2 + 3 * Math.sin(seconds * 0.3);
    director.update(STEP_SECONDS, { bounds, playerX, playerY, safeDistance: bounds.width * 0.25, shares: EQUAL_SHARES });
    for (const gate of director.gates) {
      const inset = 0.15 + gate.radius;
      assert.ok(gate.x >= bounds.minX + inset - 1e-9 && gate.x <= bounds.maxX - inset + 1e-9, `gate x ${gate.x} outside ${JSON.stringify(bounds)}`);
      assert.ok(gate.y >= bounds.minY + inset - 1e-9 && gate.y <= bounds.maxY - inset + 1e-9, `gate y ${gate.y} outside ${JSON.stringify(bounds)}`);
      insideChecks += 1;
    }
  }
  assert.ok(insideChecks > 60 * 40 * 2, `only ${insideChecks} gate checks`);
});

// Recorded from the unmodified director (seed 42, see the test below).
const RECORDED_SOLO_TABLES = [
  [
    {x: 26.656750232091753, y: 3.287187671177246, radius: 0.8, emit: 0, species: 4, open: 1, telegraph: 0},
    {x: 4.747845050664884, y: 12.95901202620739, radius: 0.8, emit: 0, species: 4, open: 1, telegraph: 0},
    {x: 5.0929114821869454, y: 5.21022168518178, radius: 0.8, emit: 0, species: 4, open: 1, telegraph: 0},
  ],
  [
    {x: 29.066473086448866, y: 6.3801561246538245, radius: 0.8, emit: 1, species: 3, open: 1, telegraph: 0},
    {x: 6.005217791696682, y: 3.1534773652362222, radius: 0.8, emit: 0, species: 4, open: 1, telegraph: 0},
    {x: 25.00550620285523, y: 12.537308322052011, radius: 0.8, emit: 0, species: 1, open: 1, telegraph: 0},
  ],
  [
    {x: 30.617601479176685, y: 4.750278611073345, radius: 0.8, emit: 1, species: 3, open: 1, telegraph: 0},
    {x: 26.911809788757115, y: 11.77535977982943, radius: 0.8, emit: 0, species: 1, open: 1, telegraph: 0},
    {x: 5.202035565693478, y: 9.361257159980173, radius: 0.8, emit: 0, species: 3, open: 1, telegraph: 0},
  ],
  [
    {x: 4.785213279370531, y: 9.942723025582163, radius: 0.8, emit: 0, species: 1, open: 1, telegraph: 0.19999999999997464},
    {x: 24.83105708298706, y: 1.7348592225277235, radius: 0.8, emit: 0, species: 0, open: 1, telegraph: 0},
    {x: 28.48066551129473, y: 11.724137078725867, radius: 0.8, emit: 0, species: 0, open: 0.5, telegraph: 0},
    {x: 5.651669470648307, y: 8.310908777582306, radius: 0.8, emit: 0, species: 3, open: 0.499999999999566, telegraph: 0},
  ],
];

// The solo scenario recorded from the director before the partner option existed: a seeded run
// with a view and a turning aim, the gate table sampled every 7.5 simulated seconds.
test('with no partner a seeded run gives the same gate tables as before the option existed', () => {
  const director = new SpawnDirector({ random: seededRandom(42) });
  const tables = [];
  for (let step = 1; step <= 1800; step += 1) {
    const seconds = step * STEP_SECONDS;
    director.update(STEP_SECONDS, {
      ...playerAt(seconds), aimX: Math.cos(seconds), aimY: Math.sin(seconds), safeDistance: SAFE_DISTANCE, shares: EQUAL_SHARES,
      view: { centerX: 16, centerY: 9, width: 16, height: 9 },
    });
    if (step % 450 === 0) tables.push(director.spawnGates.gates);
  }
  assert.deepEqual(tables, RECORDED_SOLO_TABLES);
});

// The partner crosses the arena opposite the player.
function partnerAt(seconds, aim = { aimX: 0, aimY: 0 }) {
  return { x: WORLD_WIDTH / 2 - 8 * Math.sin(seconds * 0.3), y: WORLD_HEIGHT / 2 - 4 * Math.sin(seconds * 0.5), ...aim };
}

test('emitting gates never lie within the safe radius plus their radius of either player', () => {
  const director = new SpawnDirector({ random: seededRandom(7) });
  let emittingSteps = 0;
  for (let step = 1; step <= 60 * 180; step += 1) {
    const seconds = step * STEP_SECONDS;
    const partner = partnerAt(seconds);
    director.update(STEP_SECONDS, { ...playerAt(seconds), partner, safeDistance: SAFE_DISTANCE, shares: EQUAL_SHARES });
    const { playerX, playerY } = playerAt(seconds);
    director.gates.filter((gate) => gate.emit > 0).forEach((gate) => {
      emittingSteps += 1;
      const nearest = Math.min(Math.hypot(gate.x - playerX, gate.y - playerY), Math.hypot(gate.x - partner.x, gate.y - partner.y));
      assert.ok(nearest >= SAFE_DISTANCE + gate.radius, `gate at ${gate.x}, ${gate.y} emits ${nearest} from the nearer player`);
    });
  }
  assert.ok(emittingSteps > 500, `only ${emittingSteps} emitting gate steps`);
});

test('a gate in the partner aim lane does not emit a wave', () => {
  const director = new SpawnDirector({ random: seededRandom(8), gateCount: 4 });
  const partner = { x: 2, y: WORLD_HEIGHT / 2, aimX: 1, aimY: 0 };
  const laneContext = { playerX: partner.x, playerY: partner.y, aimX: partner.aimX, aimY: partner.aimY };
  let emittingInLane = 0;
  let emittingOutside = 0;
  for (let step = 0; step < 60 * 60; step += 1) {
    director.update(STEP_SECONDS, { playerX: WORLD_WIDTH - 2, playerY: 2, partner, safeDistance: SAFE_DISTANCE, shares: EQUAL_SHARES });
    director.gates.forEach((gate) => {
      if (gate.emit <= 0) return;
      if (inAimLane(gate, gate.radius, laneContext)) emittingInLane += 1;
      else emittingOutside += 1;
    });
  }
  assert.equal(emittingInLane, 0);
  assert.ok(emittingOutside > 500, `${emittingOutside} emitting steps outside the lane`);
});

test('a gate the partner walks into starts closing', () => {
  const context = { playerX: 2, playerY: WORLD_HEIGHT / 2, safeDistance: SAFE_DISTANCE, shares: EQUAL_SHARES };
  const alone = new SpawnDirector({ random: seededRandom(10), driftSpeed: 0 });
  const withPartner = new SpawnDirector({ random: seededRandom(10), driftSpeed: 0 });
  alone.update(STEP_SECONDS, context);
  withPartner.update(STEP_SECONDS, context);
  const target = withPartner.gates[0];
  assert.equal(target.closing, false);
  alone.update(STEP_SECONDS, context);
  withPartner.update(STEP_SECONDS, { ...context, partner: { x: target.x, y: target.y, aimX: 0, aimY: 0 } });
  assert.equal(alone.gates[0].closing, false);
  assert.equal(target.closing, true);
});
