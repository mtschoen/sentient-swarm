// Shared sample messages for the net codec tests. Every float is chosen to survive its wire
// precision exactly where a test compares with deepEqual (f32 values are Math.fround-exact).

import { GameMode } from '../../src/game/versus.js';

export const SAMPLE_HOST_BLOCK = Object.freeze({
  gates: {
    gates: [
      { x: 6, y: 4.5, radius: 1.5, emit: 1, species: 0, open: 1, telegraph: 0, site: 0 },
      { x: 26, y: 13.5, radius: 1.5, emit: 0, species: 3, open: 0, telegraph: 1, site: 1 },
      { x: 16, y: 9, radius: 1.5, emit: 1, species: 1, open: 1, telegraph: 0, site: 2 },
      { x: 2.5, y: 3.25, radius: 0.75, emit: 0, species: 2, open: 0, telegraph: 0 },
    ],
    speciesBias: 0.5,
  },
  wave: { emitting: 1, remainingSeconds: 2.5, burstFraction: 0.25 },
});

export const SAMPLE_HOST_STATE = Object.freeze({
  sequence: 4000000000,
  hives: [
    { owner: 0, capturer: null, progress: 1 },
    { owner: null, capturer: 1, progress: 0.5 },
    { owner: null, capturer: null, progress: 0 },
  ],
  holder: 0,
  holdSeconds: 7.5,
  score: 123456.789,
  multiplier: 5,
  bombs: 3,
});

// Positions are lattice points of the 16-bit codes and headings of the 8-bit codes, so a
// round trip is exact apart from the tolerances the tests state.
export function sampleSnapshot({ shipCount = 12, gunners = [], generations = {}, host = null, hostState = null } = {}) {
  const gunnerBySlot = new Map(gunners);
  const ships = [];
  for (let slot = 0; slot < shipCount; slot += 1) {
    ships.push({
      slot,
      x: 1 + ((slot * 37) % 300) / 10,
      y: 1 + ((slot * 11) % 160) / 10,
      heading: -Math.PI + (((slot * 7) % 256) / 255) * 2 * Math.PI,
      gunnerIndex: gunnerBySlot.has(slot) ? gunnerBySlot.get(slot) : null,
      generation: generations[slot] ?? slot % 16,
    });
  }
  return {
    type: 'snapshot',
    sequence: 123456,
    matchSeconds: 98.765432,
    seat: 1,
    point: { x: 10.5, y: 4.25, velocityX: 1.5, velocityY: -0.75 },
    aim: { x: 0.5, y: -0.5 },
    firing: true,
    invulnerable: false,
    weapons: { armed: 'rail', tier: 2, charge: 0.75, railTurrets: 3, railTier: 1 },
    aliveCount: shipCount,
    ships,
    beam: null,
    host,
    hostState,
  };
}

export function sampleSpawns(count) {
  const spawns = [];
  for (let index = 0; index < count; index += 1) {
    spawns.push({
      x: Math.fround(index * 0.1),
      y: Math.fround(18 - index * 0.05),
      velocityX: Math.fround(Math.sin(index) * 20),
      velocityY: Math.fround(Math.cos(index) * 20),
      radius: Math.fround(0.12),
      lifetime: Math.fround(1.5),
      kind: index % 5,
      seed: Math.fround(index * 0.37),
      extra: Math.fround(0),
    });
  }
  return spawns;
}

export const SAMPLE_EVENTS = Object.freeze([
  { type: 'hello', version: 1 },
  { type: 'ping', sessionSeconds: 12.125, matchSeconds: 3.0625 },
  { type: 'pong', echoSessionSeconds: 12.125, sessionSeconds: 12.25, matchSeconds: 3.1875 },
  { type: 'ready' },
  { type: 'titleMode', mode: GameMode.Versus },
  { type: 'start', mode: GameMode.Hives, startSessionSeconds: 100.5 },
  { type: 'restartRequest' },
  { type: 'restart', startSessionSeconds: 250.75 },
  { type: 'pause', seat: 1 },
  { type: 'resumeRequest' },
  { type: 'resumeCountdown', endSessionSeconds: 300.5 },
  { type: 'quit' },
  { type: 'shots', owner: 1, matchSeconds: 12.25, spawns: sampleSpawns(3) },
  { type: 'contactKills', kills: [{ slot: 4, generation: 9 }, { slot: 200, generation: 15 }] },
  { type: 'pickupAnnounced', id: 4000000001, pickupType: 'rail', x: 8.5, y: 4.25 },
  { type: 'pickupExpired', id: 4000000001 },
  { type: 'pickupClaim', id: 7, x: 8.5, y: 4.25 },
  { type: 'pickupCollected', id: 7, seat: 0, pickupType: 'timewarp', x: 8.5, y: 4.25 },
  { type: 'bombRequest', x: 16.5, y: 9.25 },
  { type: 'bombAnnounced', seat: 1, x: 16.5, y: 9.25 },
  { type: 'hiveCaptured', hive: 2, seat: 1 },
  { type: 'wiped', seat: 0, matchSeconds: 61.5 },
  { type: 'result', winner: 1, draw: false, hives: true },
  { type: 'result', winner: null, draw: true, hives: false },
]);
