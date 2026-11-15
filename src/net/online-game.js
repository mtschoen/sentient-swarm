// The online game adapter (game.online): one machine's side of an online versus or hives match.
// Each machine runs its own seat (the local seat: 0 on the host, 1 on the guest) from its own input
// and draws the other (the remote seat) from that machine's SeatSnapshots. attach marks the remote
// seat; the game then reads no input for it, skips its steer, flock and fire, uploads it
// invulnerable (its hits are the other machine's to judge) and calls two hooks:
//   applyRemoteSeats (after the local seats flock): drains the received messages, then writes the
//     remote seat from the RemoteSeatDriver at the remote's match time this update ends at, less half
//     the round trip and INTERPOLATION_DELAY_SECONDS, with a small shockwave per remote ship lost
//     (while Playing, past the run's first mirror, which replaces the locally reset swarm);
//   afterUpdate (the last line of Game.update): the match clock runs while Playing and not paused;
//     from the run start on a snapshot of the local seat goes out every SNAPSHOT_UPDATE_INTERVAL
//     updates, stamped with the match time after this update; queued events are flushed on the
//     events channel and a ping goes out every PING_INTERVAL_SECONDS of session time.
// Shots (Task 3.4): the local seat's spawns of an update (recordShots) go out as one shots event
// stamped with the match time after the update; replayRemoteFire (after fireSeats' loop) queues the
// received ones aged to the remote's time this update ends at, and sets the remote seat's beam in
// its own slot from its snapshot (cleared once when it stops firing one, or outside Playing).
// Pings and pongs are answered and fed to the clock as they arrive; every other event is kept for
// the update that drains it (receivedEvents). A message that does not decode is dropped.

import { RunPhase } from '../game/run.js';
import { decodeEvent, encodeEvent } from './event-codec.js';
import { INTERPOLATION_DELAY_SECONDS, PING_INTERVAL_SECONDS, SNAPSHOT_UPDATE_INTERVAL } from './protocol.js';
import { RemoteSeatDriver } from './remote-seat.js';
import { ShotRelay } from './shot-relay.js';
import { buildSeatSnapshot } from './seat-snapshot.js';
import { decodeSnapshot, encodeSnapshot } from './snapshot-codec.js';
import { TransportChannel } from './transport.js';

export const OnlineRole = Object.freeze({ Host: 'host', Guest: 'guest' });
// A remote ship lost ripples the warp grid as a local one does (seats.js).
const REMOTE_SHIP_LOSS_IMPULSE_STRENGTH = 0.12;

export class OnlineGame {
  #inbox = [];
  #outbox = [];
  #attachedSeat = null;
  #updatesInRun = 0;
  #snapshotSequence = 0;
  #lastPingSessionSeconds = null;
  // True once a sampled mirror has replaced the remote seat's swarm in this run.
  #mirroredInRun = false;
  #localBeam = null;
  #shotOwner = null;
  #shotSpawns = [];
  // The remote's match time this update ends at (applyRemoteSeats), for replaying its shots.
  #remoteNow = 0;
  #shotRelay = new ShotRelay();
  #remoteBeamShown = false;

  constructor({ role, transport, clock }) {
    if (role !== OnlineRole.Host && role !== OnlineRole.Guest) throw new RangeError(`online role must be host or guest, got ${role}`);
    this.role = role;
    this.transport = transport;
    this.clock = clock;
    this.driver = new RemoteSeatDriver({ seatIndex: this.remoteSeatIndex });
    // The events drained in the latest update, pings and pongs excepted.
    this.receivedEvents = [];
    this.droppedMessages = 0;
    transport.onMessage((channel, bytes) => this.#receive(channel, bytes));
  }

  get isHost() { return this.role === OnlineRole.Host; }
  get isGuest() { return this.role === OnlineRole.Guest; }
  get localSeatIndex() { return this.isHost ? 0 : 1; }
  get remoteSeatIndex() { return this.isHost ? 1 : 0; }

  // Two seats required (RangeError otherwise), in Ready (setLocalSeat's rule).
  attach(game) {
    if (game.seats.length !== 2) throw new RangeError(`an online match needs two seats, got ${game.seats.length}`);
    game.setLocalSeat(this.localSeatIndex);
    this.#attachedSeat = game.seats[this.remoteSeatIndex];
    this.#attachedSeat.remote = true;
    this.#mirroredInRun = false;
    game.online = this;
  }

  detach(game) {
    if (this.#attachedSeat !== null) this.#attachedSeat.remote = false;
    this.#attachedSeat = null;
    for (const seat of game.seats) seat.remote = false;
    game.online = null;
    if (game.run.phase === RunPhase.Ready) game.setLocalSeat(0);
  }

  // Sent on the events channel at the end of this update.
  queueEvent(event) {
    this.#outbox.push(event);
  }

  // The local seat's beam this update (fireSeats), for the next snapshot.
  recordBeam(beam) {
    this.#localBeam = beam;
  }

  // Some of the local seat's spawns this update (its shots, then its gunners' needles).
  recordShots(owner, spawns) {
    this.#shotOwner = owner;
    for (const spawn of spawns) this.#shotSpawns.push(spawn);
  }

  // The remote seat's fire on this machine: its received shots aged, then its beam.
  replayRemoteFire(game) {
    const seat = game.seats[this.remoteSeatIndex];
    if (seat === undefined || !seat.remote) return;
    const playing = game.run.phase === RunPhase.Playing;
    const remoteIndex = this.remoteSeatIndex;
    if (playing) {
      for (const event of this.receivedEvents) {
        if (event.type === 'shots' && event.owner === remoteIndex) this.#shotRelay.replay(event, this.#remoteNow, game.projectiles);
      }
    }
    // The beam slot is set while the remote fires one and cleared once when it stops.
    const beam = playing ? seat.remoteBeam : null;
    if (beam === null && !this.#remoteBeamShown) return;
    game.projectiles.setBeam(beam, remoteIndex, remoteIndex);
    this.#remoteBeamShown = beam !== null;
  }

  applyRemoteSeats(game, deltaSeconds) {
    this.#drain();
    const seat = game.seats[this.remoteSeatIndex];
    if (seat === undefined || !seat.remote) return;
    const playing = game.run.phase === RunPhase.Playing;
    // The remote seat at the moment this update ends (the time the local snapshot will carry).
    const remoteNow = this.clock.remoteMatchNow() + (playing ? deltaSeconds : 0);
    this.#remoteNow = remoteNow;
    const renderMatchSeconds = remoteNow - (this.clock.roundTripSeconds ?? 0) / 2 - INTERPOLATION_DELAY_SECONDS;
    const { lost } = this.driver.apply(seat, renderMatchSeconds, deltaSeconds);
    if (playing && this.#mirroredInRun) lost.forEach((ship) => game.queueImpulse(ship.x, ship.y, REMOTE_SHIP_LOSS_IMPULSE_STRENGTH, false));
    this.#mirroredInRun = playing && (this.#mirroredInRun || this.driver.newest !== null);
  }

  afterUpdate(game, deltaSeconds) {
    const phase = game.run.phase;
    const running = phase === RunPhase.Playing && !game.paused;
    this.clock.setMatchRunning(running);
    if (running) this.clock.advanceMatch(deltaSeconds);
    const shots = this.#shotRelay.record(this.#shotOwner, this.#shotSpawns, this.clock.matchSeconds);
    if (shots !== null) this.queueEvent(shots);
    this.#shotSpawns = [];
    if (phase === RunPhase.Ready) this.#updatesInRun = 0;
    else {
      this.#updatesInRun += 1;
      if (this.#updatesInRun % SNAPSHOT_UPDATE_INTERVAL === 0) this.#sendSnapshot(game);
    }
    for (const event of this.#outbox) this.transport.send(TransportChannel.Events, encodeEvent(event));
    this.#outbox.length = 0;
    const sessionSeconds = this.clock.sessionSeconds;
    if (this.#lastPingSessionSeconds === null || sessionSeconds - this.#lastPingSessionSeconds >= PING_INTERVAL_SECONDS) {
      this.#lastPingSessionSeconds = sessionSeconds;
      this.transport.send(TransportChannel.Events, encodeEvent(this.clock.ping()));
    }
  }

  #sendSnapshot(game) {
    const seat = game.seats[this.localSeatIndex];
    if (seat === undefined) return;
    this.#snapshotSequence += 1;
    const snapshot = buildSeatSnapshot(seat, {
      sequence: this.#snapshotSequence,
      matchSeconds: this.clock.matchSeconds,
      firing: seat.swarmControls.firing,
      beam: this.#localBeam,
      invulnerable: seat.invulnerableSeconds > 0 || game.debugInvulnerableSeats.has(seat.index),
    });
    this.transport.send(TransportChannel.State, encodeSnapshot(snapshot));
  }

  #receive(channel, bytes) {
    if (channel !== TransportChannel.Events) {
      this.#inbox.push({ channel, bytes });
      return;
    }
    const event = this.#decode(decodeEvent, bytes);
    if (event === null) return;
    if (event.type === 'ping') this.transport.send(TransportChannel.Events, encodeEvent(this.clock.pong(event)));
    else if (event.type === 'pong') this.clock.receivePong(event);
    else this.#inbox.push({ channel, event });
  }

  #drain() {
    this.receivedEvents = [];
    for (const message of this.#inbox) {
      if (message.channel === TransportChannel.Events) this.receivedEvents.push(message.event);
      else {
        const snapshot = this.#decode(decodeSnapshot, message.bytes);
        if (snapshot !== null) this.driver.receive(snapshot);
      }
    }
    this.#inbox.length = 0;
  }

  #decode(decoder, bytes) {
    try {
      return decoder(bytes);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      this.droppedMessages += 1;
      return null;
    }
  }
}
