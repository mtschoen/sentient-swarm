// The player swarm (player-swarm spike): a small flock of white ships that orbit and seek the
// player-controlled point in place of a single ship. Pure CPU: no GPU, DOM or clock (time is the
// sum of update deltas).
//
// Motion: each ship has its own orbit point around the target (angle advancing at
// SWARM_ORBIT_RADIANS_PER_SECOND times its speed factor, radius between the orbit minimum and
// maximum times a slow wobble, all scaled by sqrt(alive / INITIAL_SWARM_SHIPS) so a big swarm
// spreads instead of stacking). A damped spring pulls the ship toward its orbit point (damping acts
// on the velocity relative to the target's, so the swarm keeps up with a moving point), a short
// separation push keeps neighbors apart, speed is capped and the position stays inside the bounds.
//
// Contact bookkeeping (player_collide.wgsl): the GPU sets bit s of a persistent hit mask when an
// agent touches slot s, and clears it while the slot is uploaded dead or fresh. contactShips(sequence)
// marks a newly spawned ship fresh in the first step it is uploaded and records that step as its
// bornSequence; applyHits honors a bit only for an alive ship and a stats frame at or after its
// bornSequence, so a late readback never kills a ship twice or kills a ship grown into a reused slot.
// Up to MAXIMUM_SWARM_SHIPS (256) ships: separation is a plain all-pairs loop (65536 pairs at the
// cap, cheap on the CPU), and update, contactShips and ships reuse their arrays and objects, so a
// step allocates nothing.
import { FULL_ARENA_BOUNDS, MAXIMUM_SWARM_SHIPS } from '../sim/layout.js';

export { MAXIMUM_SWARM_SHIPS };
export const INITIAL_SWARM_SHIPS = 12;
// One new ship per this many scored kills, up to MAXIMUM_SWARM_SHIPS.
export const KILLS_PER_SWARM_SHIP = 100;
// Contact radius in world units (the old single ship's was 0.12).
export const SWARM_SHIP_RADIUS = 0.06;
export const SWARM_ORBIT_RADIUS_MINIMUM = 0.2;
export const SWARM_ORBIT_RADIUS_MAXIMUM = 0.5;
export const SWARM_ORBIT_RADIANS_PER_SECOND = 1.6;
// Relative amplitude of the orbit radius wobble.
export const SWARM_ORBIT_WOBBLE = 0.18;
// Spring toward the orbit point (per second squared) and damping (per second): about 0.7 critical.
export const SWARM_SEEK_STIFFNESS = 40;
export const SWARM_DAMPING = 9;
export const SWARM_SEPARATION_RADIUS = 0.16;
export const SWARM_SEPARATION_STRENGTH = 30;
// World units per second; the controlled point moves at 6.
export const SWARM_MAXIMUM_SPEED = 11;

const TWO_PI = Math.PI * 2;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function deadSlot() {
  return { alive: false, x: 0, y: 0, velocityX: 0, velocityY: 0, angle: 0, radiusFraction: 0, speedFactor: 1, wobblePhase: 0, bornSequence: null, bornTime: 0 };
}

// Kills one slot in place.
function clearSlot(slot) {
  Object.assign(slot, deadSlot());
}

export class PlayerSwarm {
  constructor({ random = Math.random, bounds = FULL_ARENA_BOUNDS } = {}) {
    this.random = random;
    this.bounds = bounds;
    this.slots = Array.from({ length: MAXIMUM_SWARM_SHIPS }, deadSlot);
    // Reused outputs: contactShips' per-slot table, ships' alive list and its entries.
    this.contactTable = Array.from({ length: MAXIMUM_SWARM_SHIPS }, () => ({ x: 0, y: 0, alive: false, fresh: false }));
    this.shipEntries = Array.from({ length: MAXIMUM_SWARM_SHIPS }, () => ({ slot: 0, x: 0, y: 0, age: 0 }));
    this.shipList = [];
    this.aliveCountValue = 0;
    this.time = 0;
    this.killCredit = 0;
    this.targetX = (bounds.minX + bounds.maxX) / 2;
    this.targetY = (bounds.minY + bounds.maxY) / 2;
  }

  setBounds(bounds) {
    this.bounds = bounds;
  }

  get aliveCount() {
    return this.aliveCountValue;
  }

  // Alive ships for rendering and firing: { slot, x, y, age } (age in seconds since spawn). The
  // array and its entries are reused: valid until the next call.
  get ships() {
    const ships = this.shipList;
    ships.length = 0;
    this.slots.forEach((slot, index) => {
      if (!slot.alive) return;
      const entry = this.shipEntries[ships.length];
      entry.slot = index;
      entry.x = slot.x;
      entry.y = slot.y;
      entry.age = this.time - slot.bornTime;
      ships.push(entry);
    });
    return ships;
  }

  // Mean position of the alive ships, or the target with none alive.
  get centroid() {
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (const slot of this.slots) {
      if (!slot.alive) continue;
      sumX += slot.x;
      sumY += slot.y;
      count += 1;
    }
    return count === 0 ? { x: this.targetX, y: this.targetY } : { x: sumX / count, y: sumY / count };
  }

  // Every slot dead, then count ships spawned around (x, y); the kill credit restarts.
  reset(x, y, count = INITIAL_SWARM_SHIPS) {
    this.slots.forEach(clearSlot);
    this.aliveCountValue = 0;
    this.killCredit = 0;
    this.targetX = x;
    this.targetY = y;
    for (let index = 0; index < Math.min(count, MAXIMUM_SWARM_SHIPS); index += 1) this.spawnShip(x, y);
  }

  // A new ship in the first dead slot, on its orbit around (x, y); returns the slot or -1 when full.
  spawnShip(x, y) {
    const index = this.slots.findIndex((slot) => !slot.alive);
    if (index < 0) return -1;
    const angle = this.random() * TWO_PI;
    const radiusFraction = this.random();
    const radius = SWARM_ORBIT_RADIUS_MINIMUM + (SWARM_ORBIT_RADIUS_MAXIMUM - SWARM_ORBIT_RADIUS_MINIMUM) * radiusFraction;
    this.aliveCountValue += 1;
    Object.assign(this.slots[index], {
      alive: true,
      x: x + Math.cos(angle) * radius * 0.5,
      y: y + Math.sin(angle) * radius * 0.5,
      velocityX: 0,
      velocityY: 0,
      angle,
      radiusFraction,
      speedFactor: 0.7 + 0.6 * this.random(),
      wobblePhase: this.random() * TWO_PI,
      bornSequence: null,
      bornTime: this.time,
    });
    return index;
  }

  update(deltaSeconds, targetX, targetY) {
    if (!(deltaSeconds > 0)) return;
    const targetVelocityX = (targetX - this.targetX) / deltaSeconds;
    const targetVelocityY = (targetY - this.targetY) / deltaSeconds;
    this.targetX = targetX;
    this.targetY = targetY;
    this.time += deltaSeconds;
    const slots = this.slots;
    const spread = Math.sqrt(Math.max(1, this.aliveCountValue / INITIAL_SWARM_SHIPS));
    const { minX, maxX, minY, maxY } = this.bounds;
    for (const ship of slots) {
      if (!ship.alive) continue;
      ship.angle = (ship.angle + SWARM_ORBIT_RADIANS_PER_SECOND * ship.speedFactor * deltaSeconds) % TWO_PI;
      const wobble = 1 + SWARM_ORBIT_WOBBLE * Math.sin(this.time * 2.1 * ship.speedFactor + ship.wobblePhase);
      const radius = (SWARM_ORBIT_RADIUS_MINIMUM + (SWARM_ORBIT_RADIUS_MAXIMUM - SWARM_ORBIT_RADIUS_MINIMUM) * ship.radiusFraction) * spread * wobble;
      const desiredX = targetX + Math.cos(ship.angle) * radius;
      const desiredY = targetY + Math.sin(ship.angle) * radius;
      let accelerationX = SWARM_SEEK_STIFFNESS * (desiredX - ship.x) - SWARM_DAMPING * (ship.velocityX - targetVelocityX);
      let accelerationY = SWARM_SEEK_STIFFNESS * (desiredY - ship.y) - SWARM_DAMPING * (ship.velocityY - targetVelocityY);
      for (const other of slots) {
        if (other === ship || !other.alive) continue;
        const offsetX = ship.x - other.x;
        const offsetY = ship.y - other.y;
        const distance = Math.hypot(offsetX, offsetY);
        if (distance >= SWARM_SEPARATION_RADIUS || distance === 0) continue;
        const push = SWARM_SEPARATION_STRENGTH * (1 - distance / SWARM_SEPARATION_RADIUS) / distance;
        accelerationX += offsetX * push;
        accelerationY += offsetY * push;
      }
      ship.velocityX += accelerationX * deltaSeconds;
      ship.velocityY += accelerationY * deltaSeconds;
      const speed = Math.hypot(ship.velocityX, ship.velocityY);
      if (speed > SWARM_MAXIMUM_SPEED) {
        ship.velocityX *= SWARM_MAXIMUM_SPEED / speed;
        ship.velocityY *= SWARM_MAXIMUM_SPEED / speed;
      }
      ship.x = clamp(ship.x + ship.velocityX * deltaSeconds, minX + SWARM_SHIP_RADIUS, maxX - SWARM_SHIP_RADIUS);
      ship.y = clamp(ship.y + ship.velocityY * deltaSeconds, minY + SWARM_SHIP_RADIUS, maxY - SWARM_SHIP_RADIUS);
    }
  }

  // One { x, y, alive, fresh } per slot for the step with this frame sequence (packSwarmShips). A
  // ship uploaded for the first time is fresh and takes the sequence as its bornSequence. The table
  // is reused: valid until the next call.
  contactShips(sequence) {
    this.slots.forEach((slot, index) => {
      const fresh = slot.alive && slot.bornSequence === null;
      if (fresh) slot.bornSequence = sequence;
      const entry = this.contactTable[index];
      entry.x = slot.x;
      entry.y = slot.y;
      entry.alive = slot.alive;
      entry.fresh = fresh;
    });
    return this.contactTable;
  }

  // A stats frame's hit mask (word s / 32, bit s % 32 for slot s). Returns the ships it killed as
  // { slot, x, y }: alive ships whose bornSequence is at or before the frame.
  applyHits(maskWords, frameSequence) {
    const killed = [];
    for (let wordIndex = 0; wordIndex < maskWords.length; wordIndex += 1) {
      const word = maskWords[wordIndex];
      if (word === 0) continue;
      for (let bit = 0; bit < 32; bit += 1) {
        if (((word >>> bit) & 1) === 0) continue;
        const index = wordIndex * 32 + bit;
        const slot = this.slots[index];
        if (slot === undefined || !slot.alive || slot.bornSequence === null || frameSequence < slot.bornSequence) continue;
        slot.alive = false;
        this.aliveCountValue -= 1;
        killed.push({ slot: index, x: slot.x, y: slot.y });
      }
    }
    return killed;
  }

  // Scored kills: one new ship (spawned at the target) per KILLS_PER_SWARM_SHIP. At the cap the
  // credit is dropped, so losses are not refilled from kills banked while full. Returns ships grown.
  addKills(count) {
    this.killCredit += count;
    let grown = 0;
    while (this.killCredit >= KILLS_PER_SWARM_SHIP) {
      if (this.spawnShip(this.targetX, this.targetY) < 0) {
        this.killCredit = 0;
        break;
      }
      this.killCredit -= KILLS_PER_SWARM_SHIP;
      grown += 1;
    }
    return grown;
  }
}
