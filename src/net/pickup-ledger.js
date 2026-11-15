// Online pickups. The host's PickupDirector places and ages them; its PickupLedger names each one
// by object identity (ids count up from 1 and are never reused in a session) so the guest can be
// told of every announce, expiry and collection. The guest never runs a director: GuestPickups
// keeps the announced pickups in the guest's director list (which the renderer and the HUD read),
// ages them for the fade, and claims a reached one once; the host's pickupCollected or
// pickupExpired removes it. findReachedPickup is PickupDirector.collect's reach without removal.

import { SWARM_PICKUP_RADIUS } from '../game/player-seat.js';

const POINT_REACH = 0.35;

function nearestWithin(pickups, x, y, radius) {
  let nearest = null;
  let nearestDistance = radius;
  for (const pickup of pickups) {
    const distance = Math.hypot(pickup.x - x, pickup.y - y);
    if (distance <= nearestDistance) {
      nearestDistance = distance;
      nearest = pickup;
    }
  }
  return nearest;
}

// The pickup the seat reaches: the nearest within reach of its point, else the first ship's
// nearest within SWARM_PICKUP_RADIUS (PlayerSeat.collectPickup's order); null for none.
export function findReachedPickup(seat, pickups) {
  const { x, y } = seat.player.position;
  const atPoint = nearestWithin(pickups, x, y, POINT_REACH);
  if (atPoint !== null) return atPoint;
  for (const ship of seat.swarm.ships) {
    const reached = nearestWithin(pickups, ship.x, ship.y, SWARM_PICKUP_RADIUS);
    if (reached !== null) return reached;
  }
  return null;
}

// Host: ids for the director's pickups.
export class PickupLedger {
  #ids = new WeakMap();
  // id -> pickup, for every pickup announced and not yet expired or taken.
  #known = new Map();
  #nextId = 1;

  // The pickups new since the last call ({ id, pickupType, x, y } each) and the ids gone from the list.
  observe(pickups) {
    const announced = [];
    const present = new Set();
    for (const pickup of pickups) {
      let id = this.#ids.get(pickup);
      if (id === undefined) {
        id = this.#nextId;
        this.#nextId += 1;
        this.#ids.set(pickup, id);
        this.#known.set(id, pickup);
        announced.push({ id, pickupType: pickup.type, x: pickup.x, y: pickup.y });
      }
      present.add(id);
    }
    const expired = [];
    for (const id of this.#known.keys()) {
      if (present.has(id)) continue;
      expired.push(id);
      this.#known.delete(id);
    }
    return { announced, expired };
  }

  idOf(pickup) {
    return this.#ids.get(pickup) ?? null;
  }

  // Removes the pickup from the list and forgets it (no expiry follows); null once it is gone.
  take(id, pickups) {
    const pickup = this.#known.get(id);
    if (pickup === undefined) return null;
    const index = pickups.indexOf(pickup);
    if (index < 0) return null;
    pickups.splice(index, 1);
    this.#known.delete(id);
    return pickup;
  }

  // A new match: nothing is known; ids keep counting.
  reset() {
    this.#known.clear();
  }
}

// Guest: the host's pickups in the guest director's list.
export class GuestPickups {
  // Ids claimed and not yet answered by a collection or an expiry.
  pending = new Set();

  constructor(director) {
    this.director = director;
  }

  announce({ id, pickupType, x, y }) {
    this.director.pickups.push({ id, type: pickupType, x, y, age: 0, fade: 1 });
  }

  remove(id) {
    this.director.pickups = this.director.pickups.filter((pickup) => pickup.id !== id);
    this.pending.delete(id);
  }

  // The fade the host's director gives the same age; the host's expiry removes it.
  age(deltaSeconds, fadeSeconds) {
    for (const pickup of this.director.pickups) {
      if (pickup.persistent) continue;
      pickup.age += deltaSeconds;
      pickup.fade = Math.max(0, 1 - pickup.age / fadeSeconds);
    }
  }

  // True the first time an id is claimed.
  claim(id) {
    if (this.pending.has(id)) return false;
    this.pending.add(id);
    return true;
  }

  reset() {
    this.pending.clear();
  }
}
