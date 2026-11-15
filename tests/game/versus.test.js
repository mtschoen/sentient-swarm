import test from 'node:test';
import assert from 'node:assert/strict';
import { GameMode, VERSUS_PICKUP_ROTATION, VersusMatch, matchResultText, validatedMode } from '../../src/game/versus.js';
import { contactPairs } from '../../src/game/ship-contact.js';
import { PICKUP_TYPE_NAMES } from '../../src/game/weaponTypes.js';
import { PlayerSwarm } from '../../src/game/player-swarm.js';
import { PickupDirector } from '../../src/game/pickups.js';

test('validatedMode accepts coop and versus and rejects anything else', () => {
  assert.equal(validatedMode(GameMode.Coop), 'coop');
  assert.equal(validatedMode(GameMode.Versus), 'versus');
  assert.throws(() => validatedMode('hives'), RangeError);
});

test('the versus rotation is the co-op one without the time warp', () => {
  assert.deepEqual([...VERSUS_PICKUP_ROTATION], PICKUP_TYPE_NAMES.filter((type) => type !== 'timewarp'));
  assert.ok(!VERSUS_PICKUP_ROTATION.includes('timewarp'));
});

test('a match runs while both seats have ships and names the survivor when one is wiped', () => {
  const match = new VersusMatch();
  assert.equal(match.judge([3, 1]), null);
  assert.equal(match.over, false);
  assert.deepEqual(match.judge([3, 0]), { winner: 0, draw: false });
  assert.equal(match.over, true);
  assert.equal(match.judge([0, 0]), null, 'a decided match is not judged again');
  match.reset();
  assert.deepEqual(match.judge([0, 5]), { winner: 1, draw: false });
});

test('both seats wiped in one judgement is a draw', () => {
  const match = new VersusMatch();
  assert.deepEqual(match.judge([0, 0]), { winner: null, draw: true });
});

test('matchResultText names the winner or the draw', () => {
  assert.equal(matchResultText(null), null);
  assert.equal(matchResultText({ winner: 1, draw: false }), 'PLAYER 2 WINS');
  assert.equal(matchResultText({ winner: 0, draw: false }), 'PLAYER 1 WINS');
  assert.equal(matchResultText({ winner: null, draw: true }), 'DRAW');
});

test('contactPairs pairs touching opposing ships one for one, nearest first', () => {
  const first = [{ slot: 0, x: 1, y: 1 }, { slot: 1, x: 1.01, y: 1 }, { slot: 2, x: 5, y: 5 }];
  const second = [{ slot: 7, x: 1.02, y: 1 }, { slot: 8, x: 9, y: 9 }];
  // Ship 1 is nearer ship 7, but ship 0 comes first and takes it; ship 1 finds no free partner.
  assert.deepEqual(contactPairs(first, second, 0.04), [{ first: 0, second: 7 }]);
  const twoEach = [{ slot: 3, x: 2, y: 2 }, { slot: 4, x: 2.03, y: 2 }];
  assert.deepEqual(contactPairs(twoEach, [{ slot: 5, x: 2.01, y: 2 }, { slot: 6, x: 2.035, y: 2 }], 0.04), [{ first: 3, second: 5 }, { first: 4, second: 6 }]);
});

test('contactPairs finds nothing past the contact distance or with an empty side', () => {
  assert.deepEqual(contactPairs([{ slot: 0, x: 0, y: 0 }], [{ slot: 1, x: 0.05, y: 0 }], 0.04), []);
  assert.deepEqual(contactPairs([{ slot: 0, x: 0, y: 0 }], [{ slot: 1, x: 0.03, y: 0.03 }], 0.04), []);
  assert.deepEqual(contactPairs([], [{ slot: 1, x: 0, y: 0 }], 0.04), []);
  assert.deepEqual(contactPairs([{ slot: 1, x: 0, y: 0 }], [], 0.04), []);
});

test('PlayerSwarm.killShip kills one alive ship and ignores a dead or missing slot', () => {
  const swarm = new PlayerSwarm({ random: () => 0.5 });
  swarm.reset(4, 4, 3);
  const killed = swarm.killShip(1);
  assert.equal(killed.slot, 1);
  assert.equal(swarm.aliveCount, 2);
  assert.equal(swarm.killShip(1), null);
  assert.equal(swarm.killShip(999), null);
  assert.equal(swarm.aliveCount, 2);
});

test('PickupDirector.setRotation restarts the rotation on the given types and rejects unknown ones', () => {
  const director = new PickupDirector({ random: () => 0.5, rotationSeconds: 1 });
  director.setRotation(VERSUS_PICKUP_ROTATION);
  const offered = [];
  for (let index = 0; index < VERSUS_PICKUP_ROTATION.length * 2; index += 1) {
    offered.push(director.offeredType);
    director.update(1, { playerX: 8, playerY: 4, onBaseGun: false, milestone: false, phasePlaying: true });
  }
  assert.ok(!offered.includes('timewarp'));
  assert.deepEqual(offered.slice(0, VERSUS_PICKUP_ROTATION.length), [...VERSUS_PICKUP_ROTATION]);
  assert.throws(() => director.setRotation([]), RangeError);
  assert.throws(() => director.setRotation(['laser']), RangeError);
});
