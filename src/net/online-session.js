// The online session: one machine's side of a connected pair, from the title through every match
// to the end. It builds the OnlineGame adapter (onlineGame) from its role, transport and clock and
// runs SessionLifecycle (lifecycle.js) against the game:
//   - once the transport is open (at construction when it already is, else on the change) the
//     clock connects, a hello with this page's protocol version goes out, and a ping goes out at
//     once and then every PING_INTERVAL_SECONDS on its own timer, at the title, in play and while
//     paused (a paused game runs no update, so nothing may wait on one);
//   - lifecycle events are handled in the transport's message handler and sent at once from the
//     method or handler that made them, so a pause reaches the peer from a hidden tab;
//   - each scheduled moment (a start or restart, the countdown's numbers and end, the lost
//     deadline) gets a setTimer when it is learned, and the lifecycle also ticks at the end of every
//     update (onlineGame.onUpdated), where the game's game over is passed on (setMatchOver);
//   - the lifecycle's actions run on the game (start: two seats, attach, the mode, the online
//     state reset, the start, the match clock reset; restart: the reset, the restart, the clock;
//     pause, resume; end: the title, detach and the transport's close, which delivers a quit
//     first) and each also goes to onAction, with { type: 'countdown', number } as the countdown
//     number changes, { type: 'titleMode', mode } on the guest and { type: 'connection', state }.
// Timers: setTimer(callback, seconds) -> handle and clearTimer(handle).

import { RunPhase } from '../game/run.js';
import { decodeEvent, encodeEvent } from './event-codec.js';
import { LifecyclePhase, SessionLifecycle } from './lifecycle.js';
import { OnlineGame } from './online-game.js';
import { CONNECTION_LOST_SECONDS, PING_INTERVAL_SECONDS, PROTOCOL_VERSION } from './protocol.js';
import { TransportChannel, TransportState } from './transport.js';

const LIFECYCLE_EVENTS = new Set(['ready', 'start', 'restartRequest', 'restart', 'pause', 'resumeRequest', 'resumeCountdown', 'quit']);
const NO_ACTION = () => {};

export class OnlineSession {
  #transport;
  #clock;
  #game;
  #setTimer;
  #clearTimer;
  #onAction;
  #protocolVersion;
  #lifecycle;
  #opened = false;
  #timers = new Set();
  #pingTimer = null;
  #countdownNumber = null;
  #endReason = null;

  // protocolVersion: the version this page speaks (PROTOCOL_VERSION; another build's page differs).
  constructor({ role, transport, clock, game, setTimer, clearTimer, onAction = NO_ACTION, protocolVersion = PROTOCOL_VERSION }) {
    this.role = role;
    this.#transport = transport;
    this.#clock = clock;
    this.#game = game;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#onAction = onAction;
    this.#protocolVersion = protocolVersion;
    this.#lifecycle = new SessionLifecycle({ role });
    this.onlineGame = new OnlineGame({ role, transport, clock });
    this.onlineGame.onUpdated = () => this.#tick();
    this.onlineGame.onRestartRequest = () => this.restart();
    // The host's title mode as the guest last heard it (null before any).
    this.remoteTitleMode = null;
    transport.onMessage((channel, bytes) => this.#receive(channel, bytes));
    transport.onStateChange((state) => this.#stateChanged(state));
    if (transport.state === TransportState.Open) this.#open();
  }

  get phase() { return this.#lifecycle.phase; }
  get pausedBy() { return this.#lifecycle.pausedBy; }
  get waitingFor() { return this.#lifecycle.waitingFor; }
  get countdownNumber() { return this.#countdownNumber; }
  get endReason() { return this.#endReason; }
  get ended() { return this.#lifecycle.phase === LifecyclePhase.Ended; }
  get localSeatIndex() { return this.onlineGame.localSeatIndex; }
  get remoteSeatIndex() { return this.onlineGame.remoteSeatIndex; }

  // The best measured round trip in whole milliseconds, null before the first pong.
  get roundTripMilliseconds() {
    const seconds = this.#clock.roundTripSeconds;
    return seconds === null ? null : Math.round(seconds * 1000);
  }

  // Local loading and warm-up are done.
  markReady() {
    this.#apply(this.#lifecycle.setLocalReady());
  }

  // Host: the title's mode item changed.
  setTitleMode(mode) {
    if (this.role !== 'host' || this.ended) return;
    this.#send({ type: 'titleMode', mode });
  }

  // Host: starts both matches START_LEAD_SECONDS from now; false when it cannot (not both ready).
  start(mode) {
    const result = this.#lifecycle.requestStart(mode, this.#now());
    this.#apply(result);
    return result.send.length > 0;
  }

  // Pauses both games, naming the local seat. A match at the title or over has nothing to pause.
  pause() {
    const phase = this.#game.run.phase;
    if (phase === RunPhase.Ready && this.#lifecycle.phase !== LifecyclePhase.Starting) return false;
    if (phase === RunPhase.GameOver) return false;
    this.#lifecycle.setMatchOver(false);
    const result = this.#lifecycle.pause(this.localSeatIndex);
    this.#apply(result);
    return result.send.length > 0;
  }

  // The 3, 2, 1 countdown on both (the guest asks the host for it).
  resume() {
    this.#apply(this.#lifecycle.requestResume(this.#now()));
  }

  // A new match on both (the guest asks the host for it).
  restart() {
    this.#apply(this.#lifecycle.requestRestart(this.#now()));
  }

  quit() {
    this.#apply(this.#lifecycle.quit());
  }

  // Stops the timers and closes the transport, with no action (a page leaving).
  dispose() {
    this.#clearTimers();
    this.#transport.close();
  }

  #now() {
    return this.#clock.sessionSeconds;
  }

  #open() {
    if (this.#opened) return;
    this.#opened = true;
    this.#clock.connect();
    this.#send({ type: 'hello', version: this.#protocolVersion });
    this.#ping();
  }

  #ping() {
    this.#pingTimer = null;
    if (this.ended) return;
    this.#transport.send(TransportChannel.Events, encodeEvent(this.#clock.ping()));
    this.#pingTimer = this.#setTimer(() => this.#ping(), PING_INTERVAL_SECONDS);
  }

  #send(event) {
    this.#transport.send(TransportChannel.Events, encodeEvent(event));
  }

  #receive(channel, bytes) {
    if (channel !== TransportChannel.Events || this.ended) return;
    let event;
    try {
      event = decodeEvent(bytes);
    } catch (error) {
      if (error instanceof RangeError) return;
      throw error;
    }
    if (event.type === 'hello') {
      if (event.version !== this.#protocolVersion) this.#apply(this.#lifecycle.versionMismatch());
      return;
    }
    if (event.type === 'titleMode') {
      if (this.role !== 'guest') return;
      this.remoteTitleMode = event.mode;
      this.#onAction({ type: 'titleMode', mode: event.mode });
      return;
    }
    if (!LIFECYCLE_EVENTS.has(event.type)) return;
    this.#lifecycle.setMatchOver(this.#game.run.phase === RunPhase.GameOver);
    const toLocal = (seconds) => this.#clock.toLocalSession(seconds);
    const result = this.#lifecycle.receive(event, this.#now(), toLocal);
    // The guest learns its start, restart and countdown moments from the host's event.
    if (event.type === 'start' || event.type === 'restart') this.#tickAt(toLocal(event.startSessionSeconds));
    if (event.type === 'resumeCountdown') this.#scheduleCountdown(toLocal(event.endSessionSeconds));
    this.#apply(result);
  }

  #stateChanged(state) {
    if (state === TransportState.Open) this.#open();
    const before = this.#lifecycle.phase;
    this.#apply(this.#lifecycle.connectionChanged(state, this.#now()));
    if (before !== LifecyclePhase.Lost && this.#lifecycle.phase === LifecyclePhase.Lost) this.#tickAt(this.#now() + CONNECTION_LOST_SECONDS);
    if (!this.ended) this.#onAction({ type: 'connection', state });
  }

  // Ticks the lifecycle at the end of every update (the game's game over passed on first).
  #tick(floorSeconds = 0) {
    if (this.ended) return;
    this.#lifecycle.setMatchOver(this.#game.run.phase === RunPhase.GameOver);
    this.#apply(this.#lifecycle.tick(Math.max(this.#now(), floorSeconds)));
  }

  // A timer that ticks at sessionSeconds (never earlier, so a timer that fires a hair early still counts).
  #tickAt(sessionSeconds) {
    const handle = this.#setTimer(() => {
      this.#timers.delete(handle);
      this.#tick(sessionSeconds);
    }, Math.max(0, sessionSeconds - this.#now()));
    this.#timers.add(handle);
  }

  // The countdown's number changes (2 and 1) and its end.
  #scheduleCountdown(endSessionSeconds) {
    for (const before of [2, 1, 0]) this.#tickAt(endSessionSeconds - before);
  }

  #apply({ send, actions }) {
    for (const event of send) {
      this.#send(event);
      if (event.type === 'start' || event.type === 'restart') this.#tickAt(event.startSessionSeconds);
      if (event.type === 'resumeCountdown') this.#scheduleCountdown(event.endSessionSeconds);
    }
    for (const action of actions) {
      this.#act(action);
      this.#onAction(action);
    }
    this.#updateCountdown();
  }

  #updateCountdown() {
    const number = this.#lifecycle.countdownNumber;
    if (number === this.#countdownNumber) return;
    this.#countdownNumber = number;
    this.#onAction({ type: 'countdown', number });
  }

  #act(action) {
    const game = this.#game;
    const online = this.onlineGame;
    switch (action.type) {
      case 'start':
        game.setPlayerCount(2);
        online.attach(game);
        game.setMode(action.mode);
        online.resetMatch();
        game.start();
        this.#clock.resetMatch();
        break;
      case 'restart':
        online.resetMatch();
        game.restart();
        this.#clock.resetMatch();
        break;
      case 'pause':
        game.pause();
        break;
      case 'resume':
        game.resume();
        break;
      case 'end':
        this.#endReason = action.reason;
        this.#clearTimers();
        if (game.online === online) {
          game.quitToTitle();
          online.detach(game);
        }
        this.#transport.close();
        break;
      default:
        break;
    }
  }

  #clearTimers() {
    for (const handle of this.#timers) this.#clearTimer(handle);
    this.#timers.clear();
    if (this.#pingTimer !== null) this.#clearTimer(this.#pingTimer);
    this.#pingTimer = null;
  }
}
