// The online session lifecycle: start, pause (either player pauses both), the resume countdown, restart and quit.
// Pure: it never reads a clock; every method takes the session time it needs and returns what to send and do.

import {
  CONNECTION_LOST_SECONDS,
  PROTOCOL_VERSION,
  RESUME_COUNTDOWN_SECONDS,
  START_LEAD_SECONDS,
} from './protocol.js';

export const LifecyclePhase = Object.freeze({
  Title: 'title',
  Starting: 'starting',
  Playing: 'playing',
  Paused: 'paused',
  Countdown: 'countdown',
  Lost: 'lost',
  Ended: 'ended',
});

function result(send = [], actions = []) {
  return { send, actions };
}

export class SessionLifecycle {
  #role;
  #phase = LifecyclePhase.Title;
  #localReady = false;
  #remoteReady = false;
  #matchOver = false;
  #mode = null;
  #pendingStart = null; // { at, restart }
  #heldPause = null; // { by, lost } delivered right after a pending start
  #countdownEnd = null;
  #lastSeconds = 0;
  #pausedBy = null;
  #lostSince = 0;
  #lostFrom = null;

  constructor({ role }) {
    if (role !== 'host' && role !== 'guest') throw new Error(`Unknown lifecycle role: ${role}`);
    this.#role = role;
  }

  get phase() {
    return this.#phase;
  }

  get role() {
    return this.#role;
  }

  get mode() {
    return this.#mode;
  }

  get pausedBy() {
    return this.#pausedBy;
  }

  get bothReady() {
    return this.#localReady && this.#remoteReady;
  }

  get waitingFor() {
    if (!this.#localReady) return 'local';
    if (!this.#remoteReady) return 'remote';
    return null;
  }

  get countdownNumber() {
    if (this.#phase !== LifecyclePhase.Countdown) return null;
    return Math.max(1, Math.ceil(this.#countdownEnd - this.#lastSeconds));
  }

  // Announces the local ready flag to the peer, once.
  setLocalReady() {
    if (this.#localReady) return result();
    this.#localReady = true;
    return result([{ type: 'ready' }]);
  }

  setRemoteReady() {
    this.#remoteReady = true;
    return result();
  }

  // The session says when the game reports the match over: the game refuses a pause there.
  setMatchOver(over) {
    this.#matchOver = Boolean(over);
  }

  requestStart(mode, sessionSeconds) {
    if (this.#role !== 'host') throw new Error('Only the host starts a match');
    if (this.#phase !== LifecyclePhase.Title || !this.bothReady) return result();
    this.#lastSeconds = sessionSeconds;
    const at = sessionSeconds + START_LEAD_SECONDS;
    this.#enterStarting(mode, at, false);
    return result([{ type: 'start', mode, startSessionSeconds: at }]);
  }

  receiveStart(event, localStartSessionSeconds) {
    if (this.#phase !== LifecyclePhase.Title) return result();
    this.#enterStarting(event.mode, localStartSessionSeconds, false);
    return result();
  }

  requestRestart(sessionSeconds) {
    if (this.#phase !== LifecyclePhase.Playing && this.#phase !== LifecyclePhase.Paused) return result();
    if (this.#role === 'guest') return result([{ type: 'restartRequest' }]);
    this.#lastSeconds = sessionSeconds;
    const at = sessionSeconds + START_LEAD_SECONDS;
    this.#enterStarting(this.#mode, at, true);
    return result([{ type: 'restart', startSessionSeconds: at }]);
  }

  pause(seat) {
    if (!this.#canPause()) return result();
    return result([{ type: 'pause', seat }], this.#enterPause(seat));
  }

  receivePause(seat) {
    if (!this.#canPause()) return result();
    return result([], this.#enterPause(seat));
  }

  requestResume(sessionSeconds) {
    if (this.#phase !== LifecyclePhase.Paused) return result();
    if (this.#role === 'guest') return result([{ type: 'resumeRequest' }]);
    const endSessionSeconds = sessionSeconds + RESUME_COUNTDOWN_SECONDS;
    this.#enterCountdown(endSessionSeconds, sessionSeconds);
    return result([{ type: 'resumeCountdown', endSessionSeconds }]);
  }

  tick(sessionSeconds) {
    this.#lastSeconds = sessionSeconds;
    const actions = [];
    if (this.#phase === LifecyclePhase.Starting && sessionSeconds >= this.#pendingStart.at) {
      actions.push(this.#pendingStart.restart ? { type: 'restart' } : { type: 'start', mode: this.#mode });
      this.#pendingStart = null;
      this.#phase = LifecyclePhase.Playing;
      if (this.#heldPause !== null) {
        const held = this.#heldPause;
        this.#heldPause = null;
        this.#phase = LifecyclePhase.Paused;
        this.#pausedBy = held.by;
        actions.push(held.lost ? { type: 'pause', by: null, lost: true } : { type: 'pause', by: held.by });
      }
    } else if (this.#phase === LifecyclePhase.Countdown && sessionSeconds >= this.#countdownEnd) {
      this.#countdownEnd = null;
      this.#phase = LifecyclePhase.Playing;
      actions.push({ type: 'resume' });
    } else if (
      this.#phase === LifecyclePhase.Lost &&
      sessionSeconds >= this.#lostSince + CONNECTION_LOST_SECONDS
    ) {
      this.#phase = LifecyclePhase.Ended;
      actions.push({ type: 'end', reason: 'lost' });
    }
    return result([], actions);
  }

  connectionChanged(state, sessionSeconds) {
    this.#lastSeconds = sessionSeconds;
    if (this.#phase === LifecyclePhase.Ended) return result();
    if (state === 'closed') {
      this.#phase = LifecyclePhase.Ended;
      return result([], [{ type: 'end', reason: 'lost' }]);
    }
    if (state === 'disconnected') {
      // Nothing runs at the title, so there is nothing to pause; wait for the connection or the owner.
      if (this.#phase === LifecyclePhase.Title || this.#phase === LifecyclePhase.Lost) return result();
      this.#lostFrom = this.#phase;
      this.#lostSince = sessionSeconds;
      this.#phase = LifecyclePhase.Lost;
      this.#countdownEnd = null;
      // A pending start leaves the game in Ready, which refuses a pause: it is held until the start.
      if (this.#lostFrom === LifecyclePhase.Starting) return result();
      return result([], [{ type: 'pause', by: null, lost: true }]);
    }
    if (state === 'open' && this.#phase === LifecyclePhase.Lost) {
      this.#pausedBy = null;
      if (this.#lostFrom === LifecyclePhase.Starting) {
        this.#phase = LifecyclePhase.Starting;
        this.#heldPause = { by: null, lost: true };
      } else {
        this.#phase = LifecyclePhase.Paused;
      }
    }
    return result();
  }

  quit() {
    if (this.#phase === LifecyclePhase.Ended) return result();
    this.#phase = LifecyclePhase.Ended;
    return result([{ type: 'quit' }], [{ type: 'end', reason: 'quit' }]);
  }

  receiveQuit() {
    if (this.#phase === LifecyclePhase.Ended) return result();
    this.#phase = LifecyclePhase.Ended;
    return result([], [{ type: 'end', reason: 'remoteQuit' }]);
  }

  versionMismatch() {
    if (this.#phase === LifecyclePhase.Ended) return result();
    this.#phase = LifecyclePhase.Ended;
    return result([], [{ type: 'end', reason: 'version' }]);
  }

  // One dispatcher for every lifecycle event of the event codec; any other event returns nothing.
  receive(event, sessionSeconds, toLocalSession) {
    switch (event.type) {
      case 'hello':
        return event.version === PROTOCOL_VERSION ? result() : this.versionMismatch();
      case 'ready':
        return this.setRemoteReady();
      case 'start':
        return this.receiveStart(event, toLocalSession(event.startSessionSeconds));
      case 'restartRequest':
        return this.#role === 'host' ? this.requestRestart(sessionSeconds) : result();
      case 'restart':
        return this.#receiveRestart(toLocalSession(event.startSessionSeconds));
      case 'pause':
        return this.receivePause(event.seat);
      case 'resumeRequest':
        return this.#role === 'host' ? this.requestResume(sessionSeconds) : result();
      case 'resumeCountdown':
        return this.#receiveResumeCountdown(toLocalSession(event.endSessionSeconds), sessionSeconds);
      case 'quit':
        return this.receiveQuit();
      default:
        return result();
    }
  }

  #receiveRestart(localStartSessionSeconds) {
    if (this.#role !== 'guest') return result();
    if (this.#phase !== LifecyclePhase.Playing && this.#phase !== LifecyclePhase.Paused) return result();
    this.#enterStarting(this.#mode, localStartSessionSeconds, true);
    return result();
  }

  #receiveResumeCountdown(localEndSessionSeconds, sessionSeconds) {
    if (this.#role !== 'guest' || this.#phase !== LifecyclePhase.Paused) return result();
    this.#enterCountdown(localEndSessionSeconds, sessionSeconds);
    return result();
  }

  #enterStarting(mode, at, restart) {
    this.#mode = mode;
    this.#phase = LifecyclePhase.Starting;
    this.#pendingStart = { at, restart };
    this.#heldPause = null;
    this.#pausedBy = null;
    this.#countdownEnd = null;
    this.#matchOver = false;
  }

  #enterCountdown(endSessionSeconds, sessionSeconds) {
    this.#phase = LifecyclePhase.Countdown;
    this.#countdownEnd = endSessionSeconds;
    this.#lastSeconds = sessionSeconds;
  }

  #canPause() {
    if (this.#matchOver) return false;
    return (
      this.#phase === LifecyclePhase.Playing ||
      this.#phase === LifecyclePhase.Starting ||
      this.#phase === LifecyclePhase.Countdown
    );
  }

  #enterPause(seat) {
    if (this.#phase === LifecyclePhase.Starting) {
      // The game is still in Ready and refuses to pause: keep the first pause and deliver it after the start.
      if (this.#heldPause === null) this.#heldPause = { by: seat, lost: false };
      return [];
    }
    this.#phase = LifecyclePhase.Paused;
    this.#countdownEnd = null;
    this.#pausedBy = seat;
    return [{ type: 'pause', by: seat }];
  }
}
