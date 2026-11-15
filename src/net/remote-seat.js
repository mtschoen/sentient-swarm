// The remote seat driver: the other machine's seat drawn from its SeatSnapshots. It keeps the
// newest MAXIMUM_HELD_SNAPSHOTS of one seat in sequence order and samples them at a render time in
// the sender's match seconds (the online adapter passes about INTERPOLATION_DELAY_SECONDS behind
// the newest): the two snapshots that bracket it give the point, aim and every ship (positions
// linear, headings by the shortest arc); a ship regrown in its slot (another generation) or new in
// the later snapshot takes over only once the render time reaches that snapshot, with no blend.
// Past the newest snapshot the point and ships run on along the last two snapshots' velocity for at
// most MAXIMUM_EXTRAPOLATION_SECONDS, then hold. Weapons, firing, contact immunity and the beam are
// the newest snapshot's at or before the render time (the oldest held before any).
// suppress(slot, generation) hides one ship (a kill this machine already knows of) until a sample
// shows that slot dead or regrown.

import { wrapAngle } from '../game/swarm-facing.js';
import { MAXIMUM_EXTRAPOLATION_SECONDS } from './protocol.js';

export const MAXIMUM_HELD_SNAPSHOTS = 32;
const NO_LOSSES = Object.freeze({ lost: Object.freeze([]) });

const lerp = (from, to, fraction) => from + (to - from) * fraction;
const lerpAngle = (from, to, fraction) => wrapAngle(from + wrapAngle(to - from) * fraction);

function shipKey(ship) {
  return ship.slot * 16 + (ship.generation & 15);
}

function copyShip(ship, x, y, heading) {
  return { slot: ship.slot, x, y, heading, gunnerIndex: ship.gunnerIndex, generation: ship.generation };
}

// The fields every sample takes from one snapshot.
function heldFields(snapshot) {
  return {
    weapons: { ...snapshot.weapons },
    firing: snapshot.firing,
    invulnerable: snapshot.invulnerable,
    beam: snapshot.beam === null ? null : { ...snapshot.beam },
  };
}

function interpolate(older, newer, renderMatchSeconds) {
  const span = newer.matchSeconds - older.matchSeconds;
  const fraction = span > 0 ? (renderMatchSeconds - older.matchSeconds) / span : 0;
  const newerShips = new Map(newer.ships.map((ship) => [shipKey(ship), ship]));
  const ships = older.ships.map((ship) => {
    const next = newerShips.get(shipKey(ship));
    if (next === undefined) return copyShip(ship, ship.x, ship.y, ship.heading);
    return copyShip(ship, lerp(ship.x, next.x, fraction), lerp(ship.y, next.y, fraction), lerpAngle(ship.heading, next.heading, fraction));
  });
  const aimAngle = lerpAngle(Math.atan2(older.aim.y, older.aim.x), Math.atan2(newer.aim.y, newer.aim.x), fraction);
  const aimLength = lerp(Math.hypot(older.aim.x, older.aim.y), Math.hypot(newer.aim.x, newer.aim.y), fraction);
  return {
    point: {
      x: lerp(older.point.x, newer.point.x, fraction),
      y: lerp(older.point.y, newer.point.y, fraction),
      velocityX: lerp(older.point.velocityX, newer.point.velocityX, fraction),
      velocityY: lerp(older.point.velocityY, newer.point.velocityY, fraction),
    },
    aim: { x: Math.cos(aimAngle) * aimLength, y: Math.sin(aimAngle) * aimLength },
    ships,
    ...heldFields(older),
  };
}

// At or past the newest snapshot: along the velocity between the last two for at most
// MAXIMUM_EXTRAPOLATION_SECONDS, then held (velocity 0 once held).
function extrapolate(previous, newest, renderMatchSeconds) {
  const ahead = renderMatchSeconds - newest.matchSeconds;
  const seconds = Math.min(ahead, MAXIMUM_EXTRAPOLATION_SECONDS);
  const span = previous === null ? 0 : newest.matchSeconds - previous.matchSeconds;
  const rate = (from, to) => (span > 0 ? (to - from) / span : 0);
  const pointRateX = previous === null ? 0 : rate(previous.point.x, newest.point.x);
  const pointRateY = previous === null ? 0 : rate(previous.point.y, newest.point.y);
  const previousShips = new Map((previous?.ships ?? []).map((ship) => [shipKey(ship), ship]));
  const ships = newest.ships.map((ship) => {
    const before = previousShips.get(shipKey(ship));
    const rateX = before === undefined ? pointRateX : rate(before.x, ship.x);
    const rateY = before === undefined ? pointRateY : rate(before.y, ship.y);
    return copyShip(ship, ship.x + rateX * seconds, ship.y + rateY * seconds, ship.heading);
  });
  const held = ahead > MAXIMUM_EXTRAPOLATION_SECONDS;
  return {
    point: {
      x: newest.point.x + pointRateX * seconds,
      y: newest.point.y + pointRateY * seconds,
      velocityX: held ? 0 : newest.point.velocityX,
      velocityY: held ? 0 : newest.point.velocityY,
    },
    aim: { ...newest.aim },
    ships,
    ...heldFields(newest),
  };
}

function holdOldest(oldest) {
  return {
    point: { ...oldest.point },
    aim: { ...oldest.aim },
    ships: oldest.ships.map((ship) => copyShip(ship, ship.x, ship.y, ship.heading)),
    ...heldFields(oldest),
  };
}

export class RemoteSeatDriver {
  #snapshots = [];
  // slot -> generation of each ship left out of apply.
  #suppressed = new Map();

  constructor({ seatIndex }) {
    this.seatIndex = seatIndex;
  }

  get newest() { return this.#snapshots.at(-1) ?? null; }
  get oldest() { return this.#snapshots[0] ?? null; }
  get count() { return this.#snapshots.length; }

  // Another seat's snapshot, one already held and one older than the oldest held are ignored.
  receive(snapshot) {
    if (snapshot.seat !== this.seatIndex) return;
    const snapshots = this.#snapshots;
    if (snapshots.length > 0 && snapshot.sequence < snapshots[0].sequence) return;
    if (snapshots.some((held) => held.sequence === snapshot.sequence)) return;
    let index = snapshots.length;
    while (index > 0 && snapshots[index - 1].sequence > snapshot.sequence) index -= 1;
    snapshots.splice(index, 0, snapshot);
    if (snapshots.length > MAXIMUM_HELD_SNAPSHOTS) snapshots.shift();
  }

  // The seat at renderMatchSeconds (the sender's match seconds), or null before any snapshot:
  // { point: { x, y, velocityX, velocityY }, aim, ships, weapons, firing, invulnerable, beam }.
  sample(renderMatchSeconds) {
    const snapshots = this.#snapshots;
    if (snapshots.length === 0) return null;
    let olderIndex = -1;
    for (let index = 0; index < snapshots.length; index += 1) {
      if (snapshots[index].matchSeconds <= renderMatchSeconds) olderIndex = index;
    }
    if (olderIndex < 0) return holdOldest(snapshots[0]);
    if (olderIndex === snapshots.length - 1) return extrapolate(snapshots[olderIndex - 1] ?? null, snapshots[olderIndex], renderMatchSeconds);
    return interpolate(snapshots[olderIndex], snapshots[olderIndex + 1], renderMatchSeconds);
  }

  // Leaves the ship (slot, generation) out of every later apply until a sample shows the slot dead
  // or with another generation.
  suppress(slot, generation) {
    this.#suppressed.set(slot, generation & 15);
  }

  // Writes the sample into the seat (its point, weapons, remote fields and mirrored swarm); returns
  // the mirror's { lost } (nothing before the first snapshot).
  apply(seat, renderMatchSeconds, deltaSeconds) {
    const sample = this.sample(renderMatchSeconds);
    if (sample === null) return NO_LOSSES;
    const { player, weapons } = seat;
    player.positionX = sample.point.x;
    player.positionY = sample.point.y;
    player.velocityX = sample.point.velocityX;
    player.velocityY = sample.point.velocityY;
    player.aimX = sample.aim.x;
    player.aimY = sample.aim.y;
    ({ armed: weapons.armed, tier: weapons.tier, charge: weapons.charge, railTurrets: weapons.railTurrets, railTier: weapons.railTier } = sample.weapons);
    seat.remoteFiring = sample.firing;
    seat.remoteInvulnerable = sample.invulnerable;
    seat.remoteBeam = sample.beam;
    // The swarm's controls follow the remote fire, as the local flock step would set them.
    const aimLength = Math.hypot(sample.aim.x, sample.aim.y);
    seat.swarmControls.firing = sample.firing;
    seat.swarmControls.aimX = aimLength > 0 ? sample.aim.x / aimLength : 0;
    seat.swarmControls.aimY = aimLength > 0 ? sample.aim.y / aimLength : 0;
    seat.swarm.targetX = sample.point.x;
    seat.swarm.targetY = sample.point.y;
    return seat.swarm.mirrorShips(this.#visible(sample.ships), deltaSeconds);
  }

  #visible(ships) {
    const suppressed = this.#suppressed;
    if (suppressed.size === 0) return ships;
    const bySlot = new Map(ships.map((ship) => [ship.slot, ship]));
    for (const [slot, generation] of [...suppressed]) {
      const ship = bySlot.get(slot);
      if (ship === undefined || (ship.generation & 15) !== generation) suppressed.delete(slot);
    }
    return ships.filter((ship) => suppressed.get(ship.slot) !== (ship.generation & 15));
  }
}
