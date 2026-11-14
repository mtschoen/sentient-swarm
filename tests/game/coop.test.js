import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Game } from '../../src/game/game.js';
import { SEAT_COLORS } from '../../src/game/seat-colors.js';
import { bombRadiusForView } from '../../src/game/camera.js';
import {
  CAPACITY, STEP, SWARM_WIPE_MASK, createFakeGpu, createFakeInput, createFakeProjectiles, createFakeRenderer, createFakeSimulation,
  createGame, runFor, stats,
} from './game-harness.js';

// A small seeded generator (mulberry32), so the scripted run is reproducible.
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normalized(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toFixed(6)) : String(value);
  if (typeof value === 'function') return '[function]';
  if (ArrayBuffer.isView(value)) return Array.from(value, normalized);
  if (Array.isArray(value)) return value.map(normalized);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).map((key) => [key, normalized(value[key])]));
  }
  return value;
}

// Wraps a fake so every method call is appended to the log as [name, arguments].
function recorded(target, name, log) {
  return new Proxy(target, {
    get(object, property) {
      const value = object[property];
      if (typeof value !== 'function') return value;
      return (...args) => {
        log.push([`${name}.${String(property)}`, normalized(args)]);
        return value.apply(object, args);
      };
    },
  });
}

// The characterization hash of the solo game: 700 scripted updates (idle in Ready, a start by firing,
// movement, a pickup, a bomb, a time warp, kills, a wipe and its game over, a restart) against a
// seeded random, with every call the simulation and projectiles receive hashed in order.
const SOLO_CALL_LOG_HASH = '182b97644cd1535955f3ed8eadba843505792431d7e0f6e8580f92371ef48666';

async function soloCallLog() {
  const log = [];
  // SwarmFire and a few modules default to Math.random (captured when built); pin it to a seeded stream.
  const originalRandom = Math.random;
  Math.random = seededRandom(777);
  try {
    await recordScript(log);
  } finally {
    Math.random = originalRandom;
  }
  return log;
}

async function recordScript(log) {
  const simulation = createFakeSimulation();
  const projectiles = createFakeProjectiles();
  const input = createFakeInput();
  const game = await Game.create({
    gpu: createFakeGpu(),
    simulation: recorded(simulation, 'simulation', log),
    projectiles: recorded(projectiles, 'projectiles', log),
    renderer: createFakeRenderer(),
    input,
    capacity: CAPACITY,
    clock: () => simulation.time,
    random: seededRandom(12345),
    now: () => 0,
  });
  const state = input.state;
  runScript(game, simulation, state);
}

function runScript(game, simulation, state) {
  for (let update = 0; update < 700; update += 1) {
    if (update === 30) { state.firing = true; state.move = { x: 1, y: 0 }; state.aim = { x: 0.8, y: 0.6 }; }
    if (update > 30 && update % 50 === 0) state.move = { x: Math.cos(update), y: Math.sin(update) };
    if (update === 120) game.pickups.pickups.push({ x: game.player.position.x, y: game.player.position.y, type: 'scatter', age: 0, fade: 1 });
    if (update === 160) { game.run.addBomb(); state.bomb = true; }
    if (update === 162) state.bomb = false;
    if (update === 220) game.pickups.pickups.push({ x: game.player.position.x, y: game.player.position.y, type: 'timewarp', age: 0, fade: 1 });
    if (update === 400) game.pickups.pickups.push({ x: game.player.position.x, y: game.player.position.y, type: 'rail', age: 0, fade: 1 });
    if (update === 420) state.firing = false;
    if (update === 640) state.firing = true;
    const sequence = simulation.frameSequence + 1;
    if (update === 300) {
      simulation.scriptedStats.push({ ...scriptedFrame(sequence, update % 3), swarmHitMask: new Uint32Array(8).fill(0xffffffff) });
    } else if (update > 60) {
      simulation.scriptedStats.push(scriptedFrame(sequence, update % 4));
    }
    game.update(STEP);
  }
}

function scriptedFrame(frameSequence, kills) {
  return {
    aliveTotal: 1000,
    alivePerSpecies: new Uint32Array(5),
    killsSinceLastRead: kills,
    frameSequence,
    killsUnscored: 0,
    playerHitSequence: 0,
    hitLatch: 0,
    swarmHitMask: new Uint32Array(8),
    ringsThisFrame: 0,
    lastRingX: 0,
    lastRingY: 0,
  };
}

test('the solo game makes exactly the same simulation and projectile calls as before co-op', async () => {
  const log = await soloCallLog();
  const names = new Set(log.map(([name]) => name));
  for (const required of ['simulation.requestRadialKill', 'simulation.setPlayerState', 'simulation.setPlayer', 'simulation.setSwarmShips', 'projectiles.setBeam', 'projectiles.queueSpawn']) {
    assert.ok(names.has(required), `the scripted run never called ${required}`);
  }
  assert.ok(log.filter(([name]) => name === 'simulation.requestKillAll').length >= 3, 'start, death clear and restart each clear the arena');
  const hash = createHash('sha256').update(JSON.stringify(log)).digest('hex');
  assert.equal(hash, SOLO_CALL_LOG_HASH);
});

async function startTwoSeats() {
  const harness = await createGame();
  harness.game.setPlayerCount(2);
  harness.game.start();
  harness.game.update(STEP);
  return harness;
}

// Feeds a stats frame for the step the next update runs, with these fields, and runs that update.
function updateWithStats(game, simulation, fields) {
  simulation.scriptedStats.push(stats({ frameSequence: simulation.frameSequence + 1, ...fields }));
  game.update(STEP);
}

const SECOND_WIPE = { secondSwarmHitMask: SWARM_WIPE_MASK };

test('a solo run never calls the co-op simulation methods', async () => {
  const { game, simulation, input, projectiles } = await createGame();
  input.state.firing = true;
  input.state.move = { x: 1, y: 0 };
  runFor(game, 10);
  assert.equal(simulation.secondPlayerCalls.length, 0);
  assert.equal(simulation.clearSecondPlayerCalls, 0);
  assert.deepEqual(simulation.clearSwarmShipsCalls, []);
  assert.ok(simulation.swarmUploads.length > 100);
  assert.ok(simulation.swarmUploads.every((upload) => upload.argumentCount === 2 && upload.seat === 0));
  assert.deepEqual(projectiles.beamSlotCounts, []);
  assert.ok(projectiles.beamSeats.every((seat) => seat === 0));
  assert.equal(game.state.seats.length, 1);
});

test('setPlayerCount(2) in Ready seats a second swarm beside the first; outside Ready or for 3 it throws', async () => {
  const { game, projectiles } = await createGame();
  assert.throws(() => game.setPlayerCount(3), RangeError);
  assert.throws(() => game.setPlayerCount(0), RangeError);
  game.setPlayerCount(2);
  assert.equal(game.playerCount, 2);
  assert.deepEqual(projectiles.beamSlotCounts, [2]);
  const [first, second] = game.seats;
  assert.ok(Math.abs(second.point.x - first.point.x - 3) < 1e-9);
  assert.equal(second.point.y, first.point.y);
  assert.equal(second.aliveCount, 12);
  game.start();
  assert.throws(() => game.setPlayerCount(1), Error);
});

test('a two-seat step uploads both contact tables with their seat index', async () => {
  const { game, simulation } = await startTwoSeats();
  const uploads = simulation.swarmUploads.slice(-2);
  assert.deepEqual(uploads.map((upload) => upload.seat), [0, 1]);
  assert.ok(uploads.every((upload) => upload.argumentCount === 3 && upload.invulnerable === false));
  assert.equal(uploads[0].ships.filter((ship) => ship.alive).length, 12);
  assert.equal(uploads[1].ships.filter((ship) => ship.alive).length, 12);
  assert.equal(game.state.seats.length, 2);
});

test('each seat moves from its own input and fires from its own ships', async () => {
  const { game, input, projectiles } = await startTwoSeats();
  // Only seat 2 fires: every shot leaves a ship nearer its point than seat 1's.
  input.seatTwoState.firing = true;
  input.seatTwoState.aim = { x: 0, y: -1 };
  runFor(game, 0.2);
  assert.ok(projectiles.spawns.length > 0);
  const [first, second] = game.seats;
  assert.ok(projectiles.spawns.every((spawn) => Math.hypot(spawn.x - second.point.x, spawn.y - second.point.y) < Math.hypot(spawn.x - first.point.x, spawn.y - first.point.y)));
  assert.deepEqual([...new Set(projectiles.beamSeats)].sort(), [0, 1]);
  input.seatTwoState.firing = false;
  const before = game.seats.map((seat) => ({ ...seat.point }));
  input.state.move = { x: 1, y: 0 };
  input.seatTwoState.move = { x: -1, y: 0 };
  runFor(game, 0.25);
  assert.ok(first.point.x > before[0].x + 0.5);
  assert.ok(second.point.x < before[1].x - 0.5);
});

test('the second seek point is the second live seat and clears once that seat is down', async () => {
  const { game, simulation } = await startTwoSeats();
  const last = simulation.secondPlayerCalls.at(-1);
  assert.deepEqual(last, { x: game.seats[1].point.x, y: game.seats[1].point.y });
  assert.equal(simulation.clearSecondPlayerCalls, 0);
  updateWithStats(game, simulation, SECOND_WIPE);
  assert.equal(game.seats[1].down, true);
  const callsBefore = simulation.secondPlayerCalls.length;
  game.update(STEP);
  assert.equal(simulation.secondPlayerCalls.length, callsBefore);
  assert.ok(simulation.clearSecondPlayerCalls >= 1);
});

test('a seat wiped while the other lives goes down: weapons dropped, multiplier reset, still Playing', async () => {
  const { game, simulation, projectiles } = await startTwoSeats();
  const events = [];
  game.effects = { seatDown: (index) => events.push(index), death: () => events.push('death') };
  game.seats[1].weapons.collect('scatter');
  game.score.recordKills(300);
  assert.ok(game.score.multiplier > 1);
  updateWithStats(game, simulation, SECOND_WIPE);
  assert.equal(game.state.phase, 'playing');
  assert.equal(game.seats[1].down, true);
  assert.equal(game.seats[0].down, false);
  assert.equal(game.seats[1].weapons.armed, 'base');
  assert.equal(game.score.multiplier, 1);
  assert.deepEqual(events, [1]);
  assert.equal(projectiles.beams.at(-1), null);
  assert.equal(game.state.seats[1].down, true);
  assert.ok(game.takeImpulses().some((impulse) => impulse.strength === 1 && impulse.bloomBoost));
});

test('the run ends when the last live seat is wiped', async () => {
  const { game, simulation } = await startTwoSeats();
  const events = [];
  game.effects = { seatDown: (index) => events.push(index), death: () => events.push('death') };
  updateWithStats(game, simulation, SECOND_WIPE);
  updateWithStats(game, simulation, { swarmHitMask: SWARM_WIPE_MASK });
  assert.equal(game.state.phase, 'dying');
  assert.deepEqual(events, [1, 'death']);
  game.update(STEP);
  // Seat 1 was wiped last, so the death flood's primary position is its point.
  assert.equal(simulation.playerStates.at(-1).x, game.seats[0].point.x);
});

test('both seats wiped in one stats frame is one death, with the flood where the last-listed seat died', async () => {
  const { game, simulation } = await startTwoSeats();
  const events = [];
  game.effects = { seatDown: (index) => events.push(index), death: () => events.push('death') };
  updateWithStats(game, simulation, { swarmHitMask: SWARM_WIPE_MASK, ...SECOND_WIPE });
  assert.equal(game.state.phase, 'dying');
  assert.deepEqual(events, ['death']);
  assert.equal(game.seats[0].down, false);
  game.update(STEP);
  const state = simulation.playerStates.at(-1);
  assert.deepEqual({ x: state.x, y: state.y }, { x: game.seats[1].point.x, y: game.seats[1].point.y });
});

test('kills score once and grow every live seat', async () => {
  const { game, simulation } = await startTwoSeats();
  const { game: solo, simulation: soloSimulation } = await createGame();
  solo.start();
  solo.update(STEP);
  updateWithStats(solo, soloSimulation, { killsSinceLastRead: 100 });
  updateWithStats(game, simulation, { killsSinceLastRead: 100 });
  assert.equal(game.score.score, solo.score.score);
  assert.equal(game.seats[0].aliveCount, 13);
  assert.equal(game.seats[1].aliveCount, 13);
});

test('a pickup goes to the seat whose ship touched it', async () => {
  const { game } = await startTwoSeats();
  const calls = [];
  game.effects = { pickup: (...args) => calls.push(args) };
  const { x, y } = game.seats[1].point;
  game.pickups.pickups.push({ x, y, type: 'scatter', age: 0, fade: 1 });
  game.update(STEP);
  assert.equal(game.seats[1].weapons.armed, 'scatter');
  assert.equal(game.seats[0].weapons.armed, 'base');
  assert.deepEqual(calls, [[undefined, 1]]);
});

test('either seat spends the shared bomb pool around its own swarm with the solo radius', async () => {
  const { game, simulation, input } = await startTwoSeats();
  game.run.addBomb();
  const bombsBefore = game.run.bombs;
  const secondCenter = { ...game.seats[1].centroid };
  input.seatTwoState.bomb = true;
  game.update(STEP);
  const radius = bombRadiusForView(game.viewSize.width, game.viewSize.height);
  assert.deepEqual(simulation.radialKills, [{ x: secondCenter.x, y: secondCenter.y, radius }]);
  assert.equal(game.run.bombs, bombsBefore - 1);
  input.seatTwoState.bomb = false;
  const firstCenter = { ...game.seats[0].centroid };
  input.state.bomb = true;
  game.update(STEP);
  assert.deepEqual(simulation.radialKills.at(-1), { x: firstCenter.x, y: firstCenter.y, radius });
  assert.equal(game.run.bombs, bombsBefore - 2);
});

test('quitToTitle and setWatch return to one seat and clear the second seek point', async () => {
  const quit = await startTwoSeats();
  quit.game.quitToTitle();
  assert.equal(quit.game.playerCount, 1);
  assert.equal(quit.simulation.clearSecondPlayerCalls, 1);
  assert.deepEqual(quit.simulation.clearSwarmShipsCalls, [1]);
  assert.deepEqual(quit.projectiles.beamSlotCounts, [2, 1]);
  const watch = await createGame();
  watch.game.setPlayerCount(2);
  watch.game.setWatch(0.5);
  assert.equal(watch.game.playerCount, 1);
  assert.equal(watch.simulation.clearSecondPlayerCalls, 1);
  assert.deepEqual(watch.simulation.clearSwarmShipsCalls, [1]);
});

test('scene draws one swarm per live seat in its body color, and scene.swarm is seat 1', async () => {
  const { game, simulation } = await startTwoSeats();
  const scene = game.scene(0);
  assert.equal(scene.swarms.length, 2);
  assert.deepEqual(scene.swarms.map((swarm) => swarm.bodyColor), SEAT_COLORS.map((color) => color.body));
  assert.equal(scene.swarm, scene.swarms[0]);
  updateWithStats(game, simulation, SECOND_WIPE);
  assert.equal(game.scene(0).swarms.length, 1);
  assert.deepEqual(game.scene(0).swarm.bodyColor, SEAT_COLORS[0].body);
});

test('debugInvulnerable(true, 0) marks only seat 1 invulnerable in its upload', async () => {
  const { game, simulation } = await startTwoSeats();
  game.debugInvulnerable(true, 0);
  game.update(STEP);
  const [first, second] = simulation.swarmUploads.slice(-2);
  assert.equal(first.invulnerable, true);
  assert.equal(second.invulnerable, false);
  game.debugInvulnerable(false, 0);
  game.update(STEP);
  assert.equal(simulation.swarmUploads.at(-2).invulnerable, false);
});
