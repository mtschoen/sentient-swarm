import test from 'node:test';
import assert from 'node:assert/strict';
import { LIFE_ICON, seatReadoutText, weaponText } from '../../src/ui/hud-seat.js';

test('weaponText names the base gun and numbers the tiers', () => {
  assert.equal(weaponText('base', 1), 'BASE');
  assert.equal(weaponText(null, 1), 'BASE');
  assert.equal(weaponText('rail', 3), 'RAIL III');
  assert.equal(weaponText('scatter', 7), 'SCATTER 7');
});

test('a live seat reads its number, ship count and weapon', () => {
  assert.equal(seatReadoutText({ ships: 12, armed: 'base', tier: 1, down: false }, 0), `P1 ${LIFE_ICON} 12 BASE`);
  assert.equal(seatReadoutText({ ships: 30, armed: 'scatter', tier: 2, down: false }, 1), `P2 ${LIFE_ICON} 30 SCATTER II`);
});

test('a downed seat reads DOWN with its revive progress', () => {
  const seat = { ships: 0, armed: 'base', tier: 1, down: true, reviveKills: 37, reviveKillsNeeded: 100 };
  assert.equal(seatReadoutText(seat, 1), 'P2 DOWN 37/100');
});
