// Two games joined by the in-memory transport: a host and a guest, each a createGame() harness with
// its OnlineGame adapter and a SessionClock, the clocks sharing one injected now. stepBoth runs the
// host's update, then the guest's, then advances now and delivers the transport, one fixed step at a
// time (the games' impulse clocks advance too). The fakes also take the versus calls (as versusHarness in tests/game/versus-game.test.js).

import { STEP, createGame } from '../game/game-harness.js';
import { createMemoryTransportPair } from '../../src/net/memory-transport.js';
import { SessionClock } from '../../src/net/session-clock.js';
import { OnlineGame } from '../../src/net/online-game.js';

export { STEP };

const PROJECTILE_BUFFER = Object.freeze({ label: 'projectiles' });

// mulberry32: a repeatable random source for loss and reorder.
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Records every spawn's and beam's owner arguments, and takes the versus projectile buffer.
function patchVersusFakes({ simulation, projectiles }) {
  simulation.versusProjectileCalls = [];
  simulation.setVersusProjectiles = (buffer) => simulation.versusProjectileCalls.push(buffer);
  projectiles.buffer = PROJECTILE_BUFFER;
  projectiles.spawnOwners = [];
  projectiles.queueSpawn = function queueSpawn(spawn, ...owner) {
    this.spawns.push(spawn);
    this.spawnOwners.push(owner);
    return this.spawns.length;
  };
  projectiles.beamOwners = [];
  projectiles.setBeam = function setBeam(beam, seat = 0, ...owner) {
    this.beams.push(beam);
    this.beamSeats.push(seat);
    this.beamOwners.push(owner);
  };
}

async function createSide(role, transport, now) {
  const harness = await createGame();
  patchVersusFakes(harness);
  const clock = new SessionClock({ now });
  clock.connect();
  const online = new OnlineGame({ role, transport, clock });
  return { ...harness, online, clock };
}

export async function createOnlinePair({ delaySeconds = 0, lossFraction = 0, reorderSeconds = 0, random = seededRandom(1) } = {}) {
  let seconds = 0;
  const now = () => seconds;
  const pair = createMemoryTransportPair({ delaySeconds, lossFraction, reorderSeconds, random });
  const host = await createSide('host', pair.host, now);
  const guest = await createSide('guest', pair.guest, now);

  function stepBoth(totalSeconds) {
    const steps = Math.max(1, Math.round(totalSeconds / STEP));
    for (let index = 0; index < steps; index += 1) {
      host.game.update(STEP);
      guest.game.update(STEP);
      // now moves first, so a message is handled at the session time the transport delivers it.
      seconds += STEP;
      pair.advance(STEP);
      host.advanceClock(STEP);
      guest.advanceClock(STEP);
    }
  }

  // Both games enter the match in the same step (Phase 5's lifecycle replaces this).
  async function startMatch(mode) {
    for (const side of [host, guest]) {
      side.game.setPlayerCount(2);
      side.online.attach(side.game);
      side.game.setMode(mode);
      side.game.start();
    }
  }

  return { host, guest, pair, stepBoth, startMatch };
}
