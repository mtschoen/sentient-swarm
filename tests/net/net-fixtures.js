// Shared sample messages and fixtures for the net tests: codec samples (every float survives its wire
// precision exactly where a test compares with deepEqual), a realistic session description, a versioned
// signal encoder and a cycling random source.

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


function candidateLines() {
  const lines = [];
  for (let index = 0; index < 8; index += 1) {
    lines.push(`a=candidate:${1000 + index} 1 udp ${2122260223 - index} 192.168.${index}.${10 + index} ${50000 + index * 137} typ host generation 0 network-id ${index + 1} network-cost 10`);
  }
  for (let index = 0; index < 6; index += 1) {
    lines.push(`a=candidate:${2000 + index} 1 udp ${1686052607 - index} 203.0.113.${20 + index} ${40000 + index * 211} typ srflx raddr 192.168.${index}.${10 + index} rport ${50000 + index * 137} generation 0 network-id ${index + 1} network-cost 10`);
  }
  for (let index = 0; index < 4; index += 1) {
    lines.push(`a=candidate:${3000 + index} 1 tcp ${1518280447 - index} 192.168.${index}.${10 + index} 9 typ host tcptype active generation 0 network-id ${index + 1} network-cost 10`);
  }
  return lines;
}

export const SAMPLE_SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:k3Xp',
  'a=ice-pwd:Zr8mQ1vTn4yB7cHd2LsWe5Ua',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 4A:1F:90:C3:7B:22:E8:5D:0C:AF:63:19:B4:D7:3E:81:52:6A:F0:9C:2D:E4:17:88:B3:5F:A6:0B:71:CD:3A:94',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  ...candidateLines(),
].join('\r\n') + '\r\n';

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Encodes a signal the way the codec does but with an arbitrary protocol version.
export async function encodeWithVersion(version, kind, sdp = SAMPLE_SDP) {
  const json = JSON.stringify({ v: version, k: kind, s: sdp });
  return Buffer.from(await deflateRaw(new TextEncoder().encode(json))).toString('base64url');
}

// A random source that cycles through the given values.
export function sequenceRandom(values) {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
}

// A seat's SeatSnapshot with shipCount ships (slots 0 up) all at (x, 9) heading 0, no gunners, each
// slot's generation from generations (0 when not named); the point at (x, 9) aiming along +x.
export function seatAt({ sequence, matchSeconds, x, seat = 0, shipCount = 12, generations = {}, firing = false, weapons = {} }) {
  const ships = [];
  for (let slot = 0; slot < shipCount; slot += 1) {
    ships.push({ slot, x, y: 9, heading: 0, gunnerIndex: null, generation: generations[slot] ?? 0 });
  }
  return {
    type: 'snapshot',
    sequence,
    matchSeconds,
    seat,
    point: { x, y: 9, velocityX: 0, velocityY: 0 },
    aim: { x: 1, y: 0 },
    firing,
    invulnerable: false,
    weapons: { armed: 'base', tier: 0, charge: 0, railTurrets: 0, railTier: 0, ...weapons },
    aliveCount: shipCount,
    ships,
    beam: null,
    host: null,
    hostState: null,
  };
}
