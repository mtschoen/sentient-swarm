// Two games joined by the in-memory transport: a host and a guest, each a createGame() harness with
// its OnlineSession (which builds the OnlineGame adapter) and a SessionClock, the clocks and the
// fake timers sharing one injected now. step runs the host's update, then the guest's (either can
// be left out, as a tab that draws no frames), then advances now, delivers the transport and runs
// the timers that came due, one fixed step at a time (the games' impulse clocks advance too);
// stepBoth steps both. startMatch goes through the sessions: both ready, the host's start, then
// the steps until both matches run. The fakes also take the versus calls (as versusHarness in
// tests/game/versus-game.test.js).

import { STEP, createGame } from '../game/game-harness.js';
import { createMemoryTransportPair } from '../../src/net/memory-transport.js';
import { SessionClock } from '../../src/net/session-clock.js';
import { OnlineSession } from '../../src/net/online-session.js';

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

// Fake timers on the shared now: setTimer(callback, seconds) -> handle, clearTimer(handle).
function createTimers(now) {
  let nextHandle = 1;
  const pending = new Map();
  return {
    setTimer(callback, seconds) {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, { due: now() + seconds, callback });
      return handle;
    },
    clearTimer(handle) { pending.delete(handle); },
    // Runs every timer due by now, earliest first (a callback may set or clear others).
    run() {
      for (;;) {
        let earliest = null;
        for (const [handle, timer] of pending) {
          if (timer.due <= now() && (earliest === null || timer.due < pending.get(earliest).due)) earliest = handle;
        }
        if (earliest === null) return;
        const { callback } = pending.get(earliest);
        pending.delete(earliest);
        callback();
      }
    },
    get count() { return pending.size; },
  };
}

async function createSide(role, transport, now, timers, protocolVersion) {
  const harness = await createGame();
  patchVersusFakes(harness);
  const clock = new SessionClock({ now });
  const actions = [];
  const session = new OnlineSession({
    role, transport, clock, game: harness.game, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    onAction: (action) => actions.push(action), protocolVersion,
  });
  return { ...harness, session, online: session.onlineGame, clock, actions };
}

// guestProtocolVersion: the version the guest's page speaks (an older or newer build).
export async function createOnlinePair({ delaySeconds = 0, lossFraction = 0, reorderSeconds = 0, random = seededRandom(1), guestProtocolVersion } = {}) {
  let seconds = 0;
  const now = () => seconds;
  const timers = createTimers(now);
  const pair = createMemoryTransportPair({ delaySeconds, lossFraction, reorderSeconds, random });
  const host = await createSide('host', pair.host, now, timers);
  const guest = await createSide('guest', pair.guest, now, timers, guestProtocolVersion);

  function step(totalSeconds, { hostUpdates = true, guestUpdates = true } = {}) {
    const steps = Math.max(1, Math.round(totalSeconds / STEP));
    for (let index = 0; index < steps; index += 1) {
      if (hostUpdates) host.game.update(STEP);
      if (guestUpdates) guest.game.update(STEP);
      // now moves first, so a message is handled at the session time the transport delivers it.
      seconds += STEP;
      pair.advance(STEP);
      timers.run();
      host.advanceClock(STEP);
      guest.advanceClock(STEP);
    }
  }

  const stepBoth = (totalSeconds) => step(totalSeconds);

  // Steps (both games updating, unless options leave them out) until condition holds.
  function stepUntil(condition, label, options) {
    for (let index = 0; index < 1200; index += 1) {
      if (condition()) return;
      step(STEP, options);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  // Both ready, then the host's start; returns once both matches run, before their first update.
  // Time, the transport and the timers run meanwhile but the games do not update (as the old
  // direct start, so a test counts only the match's updates).
  async function startMatch(mode) {
    const withoutUpdates = { hostUpdates: false, guestUpdates: false };
    host.session.markReady();
    guest.session.markReady();
    stepUntil(() => host.session.waitingFor === null, 'both ready', withoutUpdates);
    host.session.start(mode);
    stepUntil(() => host.game.run.phase === 'playing' && guest.game.run.phase === 'playing', 'both playing', withoutUpdates);
  }

  return { host, guest, pair, timers, step, stepBoth, stepUntil, startMatch, now };
}
