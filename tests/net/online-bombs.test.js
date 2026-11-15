import test from 'node:test';
import assert from 'node:assert/strict';
import { STEP, createOnlinePair } from './online-harness.js';
import { stats } from '../game/game-harness.js';
import { ONLINE_BOMB_RADIUS } from '../../src/net/online-game.js';
import { bombRadiusForView } from '../../src/game/camera.js';
import { VIEW_HEIGHT, VIEW_WIDTH } from '../../src/sim/layout.js';

// A fresh bomb press by the side's local seat in one stepBoth update; returns its centroid then.
function pressBomb(side, stepBoth) {
  side.input.state.bomb = false;
  stepBoth(STEP);
  const seat = side.game.localSeat;
  const { x, y } = seat.centroid;
  side.input.state.bomb = true;
  stepBoth(STEP);
  side.input.state.bomb = false;
  return { x: Math.fround(x), y: Math.fround(y) };
}

const lastKill = (side) => side.simulation.radialKills.at(-1);

test('the online bomb radius is the 16:9 view\'s', () => {
  assert.equal(ONLINE_BOMB_RADIUS, bombRadiusForView(VIEW_WIDTH, VIEW_HEIGHT));
});

test('a guest bomb spends the host pool and clears at the guest centroid on both', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('versus');
  guest.game.setView({ width: 8, height: 9 });
  stepBoth(0.5);
  const center = pressBomb(guest, stepBoth);
  assert.equal(guest.simulation.radialKills.length, 0, 'the guest changes nothing before the host answers');
  stepBoth(0.2);
  assert.equal(host.game.run.bombs, 2);
  for (const side of [host, guest]) {
    assert.equal(side.simulation.radialKills.length, 1, side.online.role);
    assert.deepEqual(lastKill(side), { ...center, radius: ONLINE_BOMB_RADIUS }, side.online.role);
    assert.equal(side.game.pendingImpulses.filter((impulse) => impulse.strength === 1 && impulse.bloomBoost).length, 1, side.online.role);
  }
  stepBoth(0.2);
  assert.equal(guest.game.state.bombs, 2, 'the guest HUD shows the host pool');
});

test('a host bomb clears at the host centroid on both', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('versus');
  const bombs = [];
  guest.game.effects = { bomb: (...seat) => bombs.push(seat) };
  stepBoth(0.5);
  const center = pressBomb(host, stepBoth);
  assert.equal(host.game.run.bombs, 2);
  stepBoth(0.2);
  for (const side of [host, guest]) assert.deepEqual(lastKill(side), { ...center, radius: ONLINE_BOMB_RADIUS }, side.online.role);
  assert.deepEqual(bombs, [[0]]);
});

test('a guest press with an empty pool clears nothing anywhere', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('versus');
  stepBoth(0.5);
  while (host.game.run.useBomb()) { /* spends the pool */ }
  pressBomb(guest, stepBoth);
  stepBoth(0.3);
  for (const side of [host, guest]) assert.deepEqual(side.simulation.radialKills, [], side.online.role);
  assert.equal(host.game.run.bombs, 0);
  assert.equal(guest.game.state.bombs, 0);
});

test('the guest HUD shows the host score, multiplier and bombs, not its own kills', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('versus');
  assert.deepEqual(guest.online.sharedHud, {}, 'nothing before the first host state');
  assert.deepEqual(host.online.sharedHud, {});
  stepBoth(0.5);
  host.simulation.scriptedStats.push(stats({ frameSequence: host.simulation.frameSequence + 1, killsSinceLastRead: 500 }));
  guest.simulation.scriptedStats.push(stats({ frameSequence: guest.simulation.frameSequence + 1, killsSinceLastRead: 900 }));
  stepBoth(0.25);
  assert.ok(host.game.state.score > 0);
  assert.equal(guest.game.state.score, host.game.state.score);
  assert.equal(guest.game.state.multiplier, host.game.state.multiplier);
  assert.equal(guest.game.state.bombs, host.game.state.bombs);
  assert.equal(guest.game.score.score, 0);
});
