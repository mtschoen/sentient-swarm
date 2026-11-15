import assert from 'node:assert/strict';
import test from 'node:test';
import { quantize } from '../../src/net/byte-buffer.js';
import { decodeSnapshot, encodeSnapshot } from '../../src/net/snapshot-codec.js';
import { SAMPLE_HOST_BLOCK, SAMPLE_HOST_STATE, sampleSnapshot } from './net-fixtures.js';

const POSITION_TOLERANCE = 32 / 65535;
const HEADING_TOLERANCE = Math.PI / 256 + 1e-6;

test('a 12-ship seat snapshot round trips within the quantization', () => {
  const snapshot = sampleSnapshot({ shipCount: 12, gunners: [[3, 0], [7, 1]], generations: { 5: 9 } });
  const decoded = decodeSnapshot(encodeSnapshot(snapshot));
  assert.equal(decoded.sequence, snapshot.sequence);
  assert.equal(decoded.matchSeconds, snapshot.matchSeconds);
  assert.equal(decoded.ships.length, 12);
  decoded.ships.forEach((ship, index) => {
    const original = snapshot.ships[index];
    assert.equal(ship.slot, original.slot);
    assert.ok(Math.abs(ship.x - original.x) <= POSITION_TOLERANCE);
    assert.ok(Math.abs(ship.y - original.y) <= POSITION_TOLERANCE);
    assert.ok(Math.abs(ship.heading - original.heading) <= HEADING_TOLERANCE);
    assert.equal(ship.generation, original.generation);
    assert.equal(ship.gunnerIndex, original.gunnerIndex);
  });
  assert.deepEqual({ ...decoded.weapons, charge: 0 }, { ...snapshot.weapons, charge: 0 });
  assert.ok(Math.abs(decoded.weapons.charge - snapshot.weapons.charge) <= 1 / 65535);
  assert.equal(decoded.aliveCount, 12);
  assert.equal(decoded.seat, 1);
  assert.equal(decoded.firing, true);
  assert.equal(decoded.invulnerable, false);
  assert.deepEqual(decoded.aim, snapshot.aim);
  assert.equal(decoded.point.velocityX, snapshot.point.velocityX);
  assert.equal(decoded.beam, null);
  assert.equal(decoded.host, null);
  assert.equal(decoded.hostState, null);
});

test('sparse alive slots and odd ship counts keep their slots and generations', () => {
  const snapshot = sampleSnapshot({ shipCount: 5 });
  snapshot.ships = snapshot.ships.map((ship, index) => ({ ...ship, slot: 40 + index * 51, generation: 15 - index }));
  const decoded = decodeSnapshot(encodeSnapshot(snapshot));
  assert.deepEqual(decoded.ships.map((ship) => [ship.slot, ship.generation]), snapshot.ships.map((ship) => [ship.slot, ship.generation]));
});

test('the beam, the invulnerable and base weapon flags round trip', () => {
  const snapshot = { ...sampleSnapshot({ shipCount: 2 }), invulnerable: true, firing: false };
  snapshot.weapons = { ...snapshot.weapons, armed: 'base' };
  snapshot.beam = { x: 1.5, y: 2.5, directionX: 0.5, directionY: -0.25, halfWidth: 0.125 };
  const decoded = decodeSnapshot(encodeSnapshot(snapshot));
  assert.deepEqual(decoded.beam, snapshot.beam);
  assert.equal(decoded.invulnerable, true);
  assert.equal(decoded.firing, false);
  assert.equal(decoded.weapons.armed, 'base');
});

test('a 256-ship snapshot without a host block stays within 1600 bytes', () => {
  assert.ok(encodeSnapshot(sampleSnapshot({ shipCount: 256 })).length <= 1600);
});

test('a 256-ship snapshot round trips every slot', () => {
  const decoded = decodeSnapshot(encodeSnapshot(sampleSnapshot({ shipCount: 256 })));
  assert.equal(decoded.ships.length, 256);
  assert.equal(decoded.ships[255].slot, 255);
});

test('the host block and the host state round trip, nulls included', () => {
  const snapshot = sampleSnapshot({ shipCount: 3, host: SAMPLE_HOST_BLOCK, hostState: SAMPLE_HOST_STATE });
  const decoded = decodeSnapshot(encodeSnapshot(snapshot));
  assert.deepEqual(decoded.host.gates.gates.map((gate) => gate.site), [0, 1, 2, undefined]);
  assert.deepEqual(decoded.host.gates.gates[0], SAMPLE_HOST_BLOCK.gates.gates[0]);
  assert.equal(decoded.host.gates.speciesBias, 0.5);
  assert.deepEqual(decoded.host.wave, SAMPLE_HOST_BLOCK.wave);
  assert.deepEqual(decoded.hostState.hives.map((hive) => [hive.owner, hive.capturer]), [[0, null], [null, 1], [null, null]]);
  assert.equal(decoded.hostState.sequence, SAMPLE_HOST_STATE.sequence);
  assert.equal(decoded.hostState.score, SAMPLE_HOST_STATE.score);
  assert.equal(decoded.hostState.holder, 0);
  assert.equal(decoded.hostState.holdSeconds, 7.5);
  assert.equal(decoded.hostState.multiplier, 5);
  assert.equal(decoded.hostState.bombs, 3);
  assert.ok(Math.abs(decoded.hostState.hives[1].progress - 0.5) <= 1 / 65535);
  assert.equal(decodeSnapshot(encodeSnapshot({ ...snapshot, host: { gates: null, wave: null } })).host.wave, null);
  assert.equal(decodeSnapshot(encodeSnapshot({ ...snapshot, host: { gates: null, wave: null } })).host.gates, null);
});

test('a host state without hives and without a holder round trips', () => {
  const hostState = { ...SAMPLE_HOST_STATE, hives: null, holder: null };
  const decoded = decodeSnapshot(encodeSnapshot({ ...sampleSnapshot({ shipCount: 1 }), hostState }));
  assert.equal(decoded.hostState.hives, null);
  assert.equal(decoded.hostState.holder, null);
});

test('a truncated snapshot or another message type throws RangeError', () => {
  const bytes = encodeSnapshot(sampleSnapshot({ shipCount: 4 }));
  assert.throws(() => decodeSnapshot(bytes.subarray(0, bytes.length - 1)), RangeError);
  assert.throws(() => decodeSnapshot(Uint8Array.of(16, 0, 0)), RangeError);
});

test('quantize clamps a position outside the world to its edge', () => {
  assert.equal(quantize(-1, 0, 32, 16), 0);
  assert.equal(quantize(40, 0, 32, 16), 65535);
});
