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
// Growth and hits (Task 3.5): each machine grows and hits its own seat alone. Growth is scaled to
// the reference capacity (onlineGrowth), so two machines on different presets grow alike; the
// remote seat's mask is the other machine's to apply, and a local wipe is reported (reportWipe).
// The match end (Task 3.6): online no machine judges the match from its own counts. The host's
// MatchReferee takes both wipes (its own, and the guest's wiped event converted to host match time)
// and decides each update; the host then queues the result and both machines run the match end the
// same way (announce, then endMatch at the losing seat's swarm). A hives hold the host's updateHives
// already ended is only queued.
// Ship contact (Task 3.7): the host pairs its ships with its mirror of the guest's, kills its own,
// removes the guest's from the mirror at once and suppresses them in the driver (so a snapshot that
// still shows one alive cannot touch again), and names them to the guest in one contactKills event
// per update; the guest kills each named ship of the named generation and never pairs ships. The
// host then runs the hives; the guest does not.
// Hives (Task 4.2): the host alone runs capture and the hold; each capture it sees (an owner
// changed by updateHives) goes out as a hiveCaptured event, which plays the guest's capture
// shockwave once. Every HOST_STATE_UPDATE_INTERVAL-th update's snapshot carries the host's
// HostState (host-state.js), which the guest applies only when newer than the last (hostState).
// Pickups (Task 4.3): the host's director alone places and ages them; its PickupLedger announces
// each (pickupAnnounced) and its expiry (pickupExpired) by id. The host's own seat takes a pickup it
// reaches at once; the guest's seat only claims one (pickupClaim, once per id), which the host
// grants when the pickup is still there. Each grant goes out as pickupCollected; the collector's
// machine arms the weapon and the other plays the same blast at the same place with no weapon
// change (applyCollection's arm false). The guest removes a pickup on its collection or expiry,
// which also answers its claim; a refused claim is never sent again.
// Gates and wave (Task 4.1): the host's every snapshot carries its director's gate table and wave
// (before hiveGateTable); the guest runs no director from attach on and refills at the newest it
// received (guestSpawns), spawning nothing before the first.
// Bombs and the HUD (Task 4.4): the host keeps the one bomb pool (online-bombs.js); the guest's
// HUD shows the host's score, multiplier and bombs from the newest host state (sharedHud).
// Pings and pongs are answered and fed to the clock as they arrive; every other event is kept for
// the update that drains it (receivedEvents). A message that does not decode is dropped.

import { RunPhase } from '../game/run.js';
import { SPECIES_COUNT } from '../sim/layout.js';
import { hiveGrowth, hivesOf, updateHives } from '../game/hive-seats.js';
import { contactPairs } from '../game/ship-contact.js';
import { SHIP_CONTACT_DISTANCE } from '../game/versus-seats.js';
import { endMatch, losingSeat } from '../game/match-end.js';
import { MatchReferee } from './match-referee.js';
import { DENSITY_REFERENCE_CAPACITY } from '../sim/species.js';
import { decodeEvent, encodeEvent } from './event-codec.js';
import { HOST_STATE_UPDATE_INTERVAL, INTERPOLATION_DELAY_SECONDS, PING_INTERVAL_SECONDS, SNAPSHOT_UPDATE_INTERVAL } from './protocol.js';
import { RemoteSeatDriver } from './remote-seat.js';
import { ShotRelay } from './shot-relay.js';
import { buildSeatSnapshot } from './seat-snapshot.js';
import { GuestPickups, PickupLedger } from './pickup-ledger.js';
import { ageGuestPickups, collectOnline, observeHostPickups } from './online-pickups.js';
import { pressOnlineBomb, receiveBombs } from './online-bombs.js';

export { ONLINE_BOMB_RADIUS } from './online-bombs.js';
import { applyHostState, buildHostState } from './host-state.js';
import { decodeSnapshot, encodeSnapshot } from './snapshot-codec.js';
import { TransportChannel } from './transport.js';

export const OnlineRole = Object.freeze({ Host: 'host', Guest: 'guest' });
// A ship lost ripples the warp grid as a couch one does (seats.js).
const SHIP_LOSS_IMPULSE_STRENGTH = 0.12;
// A captured hive ripples the warp grid as updateHives does on the host (hive-seats.js).
const HIVE_CAPTURE_IMPULSE_STRENGTH = 0.4;

// Kills at this capacity as kills at the reference capacity (the swarm's density is normalized so).
export function onlineGrowth(kills, capacity) {
  return kills * DENSITY_REFERENCE_CAPACITY / capacity;
}

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
  // True once this match's result went to the guest (host).
  #resultSent = false;
  // The host's HostState sequence sent last (host), and the one applied last (guest).
  #hostStateSequence = 0;
  #appliedHostStateSequence = 0;
  // The sequence of the snapshot hostGates and hostWave came from (guest).
  #hostBlockSequence = 0;

  constructor({ role, transport, clock }) {
    if (role !== OnlineRole.Host && role !== OnlineRole.Guest) throw new RangeError(`online role must be host or guest, got ${role}`);
    this.role = role;
    this.transport = transport;
    this.clock = clock;
    this.driver = new RemoteSeatDriver({ seatIndex: this.remoteSeatIndex });
    this.referee = new MatchReferee();
    // The events drained in the latest update, pings and pongs excepted.
    this.receivedEvents = [];
    this.droppedMessages = 0;
    // The newest HostState the guest applied (null before the first, and on the host).
    this.hostState = null;
    // The host's newest gate table and wave (guest; null before the first).
    this.hostGates = null;
    this.hostWave = null;
    // The host names its director's pickups; the guest keeps the host's (from attach).
    this.pickupLedger = new PickupLedger();
    this.guestPickups = null;
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
    this.referee.reset();
    this.#resultSent = false;
    this.guestPickups = new GuestPickups(game.pickups);
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

  // Host, after its director's update: the new pickups announced and the gone ones expired.
  observePickups(game) {
    if (this.isHost) observeHostPickups(this, game);
  }

  // Guest, in place of the director's update: the host's pickup events, then the fade (Playing).
  agePickups(game, deltaSeconds) {
    ageGuestPickups(this, game, deltaSeconds);
  }

  // The local seat's reach (Playing): the host takes the pickup at once, then grants the guest's
  // claims; the guest claims the pickup it reaches.
  collectFor(game, seat) {
    if (seat.index === this.localSeatIndex) collectOnline(this, game, seat);
  }

  // Guest claims sent and not yet answered.
  get pickupClaimsPending() {
    return this.guestPickups?.pending.size ?? 0;
  }

  // For a new match (Task 5.2's resetMatch): the ledger forgets its pickups (ids keep counting)
  // and the guest its claims.
  resetPickups() {
    this.pickupLedger.reset();
    this.guestPickups?.reset();
  }

  // Guest (Game.spawnCounts): this step's spawn counts at the host's gates, by the host's wave;
  // none before the first host block.
  guestSpawns(game, deltaSeconds, pressure, shares) {
    if (this.hostGates === null) return new Uint32Array(SPECIES_COUNT);
    return pressure.update(deltaSeconds, game.latestStats, shares, game.simulation.frameSequence + 1, this.hostWave);
  }

  // The local seat's bomb press (bomb-step.js): the host spends the pool, the guest asks the host.
  pressBomb(game, seat) {
    pressOnlineBomb(this, game, seat);
  }

  // The guest's HUD numbers from the host ({} on the host and before the first host state).
  get sharedHud() {
    if (this.isHost || this.hostState === null) return {};
    const { score, multiplier, bombs } = this.hostState;
    return { score, multiplier, bombs };
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

  // The versus work of a Playing update after the flock step (versus-seats.js stepVersus online).
  stepVersus(game, deltaSeconds) {
    if (this.isGuest) {
      this.#applyContactKills(game);
      this.#playHiveCaptures(game);
      return;
    }
    this.#refereeContact(game);
    const owners = hivesOf(game)?.owners ?? [];
    updateHives(game, deltaSeconds);
    const after = hivesOf(game)?.owners ?? [];
    owners.forEach((owner, hive) => {
      if (after[hive] !== owner && after[hive] !== null) this.queueEvent({ type: 'hiveCaptured', hive, seat: after[hive] });
    });
  }

  // Guest: the capture shockwave at each hive the host captured.
  #playHiveCaptures(game) {
    const hives = hivesOf(game);
    if (hives === null) return;
    for (const event of this.receivedEvents) {
      const hive = event.type === 'hiveCaptured' ? hives.hives[event.hive] : undefined;
      if (hive !== undefined) game.queueImpulse(hive.x, hive.y, HIVE_CAPTURE_IMPULSE_STRENGTH, false);
    }
  }

  // For a new match (Task 5.2's resetMatch): forgets the applied host state, gates and wave. The
  // sequences stay, since the host's keep counting, so a block from the last match cannot apply.
  resetHostState() {
    this.hostState = null;
    this.hostGates = null;
    this.hostWave = null;
  }

  // Guest: a host state newer than the last applied becomes the game's hives and hostState.
  #receiveHostState(game, state) {
    const applied = applyHostState(game, state, this.#appliedHostStateSequence);
    if (applied === this.#appliedHostStateSequence) return;
    this.#appliedHostStateSequence = applied;
    this.hostState = state;
  }

  // Host: touching ships die one for one (applyShipContact's guards, plus either seat's immunity).
  #refereeContact(game) {
    const { run } = game;
    if (run.phase !== RunPhase.Playing || run.invulnerable || game.debugInvulnerableValue) return;
    if (game.seats.some((seat) => game.debugInvulnerableSeats.has(seat.index))) return;
    const local = game.seats[this.localSeatIndex];
    const remote = game.seats[this.remoteSeatIndex];
    if (local.invulnerableSeconds > 0 || remote.remoteInvulnerable) return;
    const pairs = contactPairs(local.swarm.ships, remote.swarm.ships, SHIP_CONTACT_DISTANCE);
    if (pairs.length === 0) return;
    const kills = [];
    for (const pair of pairs) {
      const generation = remote.swarm.generationOf(pair.second);
      const killed = [local.swarm.killShip(pair.first), remote.swarm.killShip(pair.second)];
      killed.forEach((ship) => game.queueImpulse(ship.x, ship.y, SHIP_LOSS_IMPULSE_STRENGTH, false));
      this.driver.suppress(pair.second, generation);
      kills.push({ slot: pair.second, generation });
    }
    this.queueEvent({ type: 'contactKills', kills });
    if (local.aliveCount === 0) this.reportWipe();
  }

  // Guest: the host's contact kills of this seat's ships, each only while its generation matches.
  #applyContactKills(game) {
    if (game.run.phase !== RunPhase.Playing) return;
    const swarm = game.seats[this.localSeatIndex].swarm;
    let killedAny = false;
    for (const event of this.receivedEvents) {
      if (event.type !== 'contactKills') continue;
      for (const { slot, generation } of event.kills) {
        if (swarm.generationOf(slot) !== (generation & 15)) continue;
        const ship = swarm.killShip(slot);
        if (ship === null) continue;
        game.queueImpulse(ship.x, ship.y, SHIP_LOSS_IMPULSE_STRENGTH, false);
        killedAny = true;
      }
    }
    if (killedAny && swarm.aliveCount === 0) this.reportWipe();
  }

  // A scored stats frame grows the local seat by its own owned kills (hives: with its feeding
  // ground kills once more), scaled to the reference capacity.
  growSwarms(game, stats) {
    const local = this.localSeatIndex;
    const kills = onlineGrowth(hiveGrowth(game, stats, local, stats.ownerKillsSinceLastRead?.[local] ?? 0), game.capacity);
    if (kills > 0) game.seats[local].swarm.addKills(kills);
  }

  // The local seat's hit mask kills its ships (a small shockwave each); its wipe is reported.
  applyHits(game, stats) {
    const result = game.seats[this.localSeatIndex].applyHits(stats);
    result.killed.forEach((ship) => game.queueImpulse(ship.x, ship.y, SHIP_LOSS_IMPULSE_STRENGTH, false));
    if (result.wiped) this.reportWipe();
  }

  // The local seat lost its last ship: the guest tells the host, whose referee judges the match.
  reportWipe() {
    if (this.isHost) this.referee.reportWipe(this.localSeatIndex, this.clock.matchSeconds);
    else this.queueEvent({ type: 'wiped', seat: this.localSeatIndex, matchSeconds: this.clock.matchSeconds });
  }

  applyRemoteSeats(game, deltaSeconds) {
    this.#drain(game);
    receiveBombs(this, game);
    const seat = game.seats[this.remoteSeatIndex];
    if (seat === undefined || !seat.remote) return;
    const playing = game.run.phase === RunPhase.Playing;
    // The remote seat at the moment this update ends (the time the local snapshot will carry).
    const remoteNow = this.clock.remoteMatchNow() + (playing ? deltaSeconds : 0);
    this.#remoteNow = remoteNow;
    const renderMatchSeconds = remoteNow - (this.clock.roundTripSeconds ?? 0) / 2 - INTERPOLATION_DELAY_SECONDS;
    const { lost } = this.driver.apply(seat, renderMatchSeconds, deltaSeconds);
    if (playing && this.#mirroredInRun) lost.forEach((ship) => game.queueImpulse(ship.x, ship.y, SHIP_LOSS_IMPULSE_STRENGTH, false));
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
    this.#settleMatch(game);
    if (phase === RunPhase.Ready) this.#updatesInRun = 0;
    else {
      this.#updatesInRun += 1;
      if (this.#updatesInRun % SNAPSHOT_UPDATE_INTERVAL === 0) this.#sendSnapshot(game, this.#updatesInRun % HOST_STATE_UPDATE_INTERVAL === 0);
    }
    for (const event of this.#outbox) this.transport.send(TransportChannel.Events, encodeEvent(event));
    this.#outbox.length = 0;
    const sessionSeconds = this.clock.sessionSeconds;
    if (this.#lastPingSessionSeconds === null || sessionSeconds - this.#lastPingSessionSeconds >= PING_INTERVAL_SECONDS) {
      this.#lastPingSessionSeconds = sessionSeconds;
      this.transport.send(TransportChannel.Events, encodeEvent(this.clock.ping()));
    }
  }

  // Host: the guest's wipes to the referee, its decision, and the result out once. Guest: the
  // host's result.
  #settleMatch(game) {
    const match = game.versusMatch;
    if (match === null) return;
    if (this.isGuest) {
      for (const event of this.receivedEvents) {
        if (event.type === 'result') this.#endMatch(game, { winner: event.winner, draw: event.draw, hives: event.hives });
      }
      return;
    }
    for (const event of this.receivedEvents) {
      if (event.type === 'wiped' && event.seat === this.remoteSeatIndex) this.referee.reportWipe(event.seat, event.matchSeconds - this.clock.matchOffsetSeconds);
    }
    if (game.run.phase === RunPhase.Playing && !match.over) {
      const result = this.referee.decide(this.clock.matchSeconds, (this.clock.roundTripSeconds ?? 0) / 2);
      if (result !== null) this.#endMatch(game, result);
    }
    if (match.result !== null && !this.#resultSent) {
      const { winner, draw } = match.result;
      this.queueEvent({ type: 'result', winner, draw, hives: Boolean(match.result.hives) });
      this.#resultSent = true;
    }
  }

  // The match end both machines run: the result announced, then the run's one death at the losing
  // seat's swarm (its point when it has no ships).
  #endMatch(game, result) {
    if (game.versusMatch.announce(result) === null) return;
    const loser = game.seats[losingSeat(result)];
    const point = loser.aliveCount > 0 ? loser.centroid : loser.point;
    endMatch(game, result, game.simulation.frameSequence, { x: point.x, y: point.y });
  }

  // withHostState: the host adds its HostState (every HOST_STATE_UPDATE_INTERVAL-th update).
  #sendSnapshot(game, withHostState) {
    const seat = game.seats[this.localSeatIndex];
    if (seat === undefined) return;
    this.#snapshotSequence += 1;
    const snapshot = buildSeatSnapshot(seat, {
      sequence: this.#snapshotSequence,
      matchSeconds: this.clock.matchSeconds,
      firing: seat.swarmControls.firing,
      beam: this.#localBeam,
      invulnerable: seat.invulnerableSeconds > 0 || game.debugInvulnerableSeats.has(seat.index),
      host: this.isHost ? { gates: game.spawnDirector.spawnGates, wave: game.spawnDirector.wave } : null,
    });
    if (this.isHost && withHostState) {
      this.#hostStateSequence += 1;
      snapshot.hostState = buildHostState(game, this.#hostStateSequence);
    }
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

  #drain(game) {
    this.receivedEvents = [];
    for (const message of this.#inbox) {
      if (message.channel === TransportChannel.Events) this.receivedEvents.push(message.event);
      else {
        const snapshot = this.#decode(decodeSnapshot, message.bytes);
        if (snapshot === null) continue;
        this.driver.receive(snapshot);
        if (this.isGuest && snapshot.hostState !== null) this.#receiveHostState(game, snapshot.hostState);
        if (this.isGuest && snapshot.host !== null && snapshot.sequence > this.#hostBlockSequence) {
          this.#hostBlockSequence = snapshot.sequence;
          ({ gates: this.hostGates, wave: this.hostWave } = snapshot.host);
        }
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
