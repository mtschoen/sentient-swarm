// The player swarm (player-swarm spike): a small flock of white ships that idle and seek around the
// player-controlled point in place of a single ship. Pure CPU: no GPU, DOM or clock (time is the
// sum of update deltas) and no random numbers in the step.
//
// Motion: every ship chases its own target, which lazily traces a figure eight (a 1:2 Lissajous
// curve, x = sin t, y = sin 2t / 2) centred on the controlled point. Each slot's loop period, size,
// direction of travel, phase and axis orientation (which drifts slowly) come from a seeded hash of
// the slot index, and a small low-frequency wander bends the path, so no two ships move alike and
// the pattern never locks. Loop sizes scale with sqrt(alive / INITIAL_SWARM_SHIPS) times
// SWARM_FLOCK_SPREAD so a big swarm spreads without blobbing. A soft damped spring pulls each ship
// toward its target; the damping acts on the velocity relative to SWARM_FOLLOW_SHARE of the point's
// velocity, so a fast-moving point stretches the flock behind it (each ship's spring varies a
// little, so they stretch unevenly) and it settles back when the point stops. Mild separation keeps
// neighbours from stacking, speed is capped, the position stays inside the bounds, and each ship's
// heading follows its velocity so it banks through the curves.
//
// Contact bookkeeping (player_collide.wgsl): the GPU sets bit s of a persistent hit mask when an
// agent touches slot s, and clears it while the slot is uploaded dead or fresh. contactShips(sequence)
// marks a newly spawned ship fresh in the first step it is uploaded and records that step as its
// bornSequence; applyHits honors a bit only for an alive ship and a stats frame at or after its
// bornSequence, so a late readback never kills a ship twice or kills a ship grown into a reused slot.
// Up to MAXIMUM_SWARM_SHIPS (256) ships: separation is a plain all-pairs loop with a squared
// distance early-out (65536 pairs at the cap), and update, contactShips and ships reuse their arrays
// and objects, so a step allocates nothing.
import { FULL_ARENA_BOUNDS, MAXIMUM_SWARM_SHIPS } from '../sim/layout.js';

export { MAXIMUM_SWARM_SHIPS };
export const INITIAL_SWARM_SHIPS = 12;
// One new ship per this many scored kills, up to MAXIMUM_SWARM_SHIPS.
export const KILLS_PER_SWARM_SHIP = 100;
// Ship size relative to the first spike's ships: the drawn dart (src/render/swarm.js), the contact
// radius and the separation radius all scale with it, so the visual and the hitbox agree.
export const SWARM_SHIP_SIZE = 0.4;
// Contact radius in world units (the first spike's ships used 0.06, the old single ship 0.12).
export const SWARM_SHIP_RADIUS = 0.06 * SWARM_SHIP_SIZE;
export const SWARM_SEPARATION_RADIUS = 0.16 * SWARM_SHIP_SIZE;
// Acceleration at zero distance (world units per second squared); mild, so ships part without jostling.
export const SWARM_SEPARATION_STRENGTH = 8;
// Figure eight half-width range in world units for a 12-ship swarm (the half-height is half of it).
export const SWARM_LOOP_SIZE_MINIMUM = 0.25;
export const SWARM_LOOP_SIZE_MAXIMUM = 0.6;
// Seconds per loop, per ship in this range: lazy.
export const SWARM_LOOP_SECONDS_MINIMUM = 4;
export const SWARM_LOOP_SECONDS_MAXIMUM = 8;
// Radians per second the loop's axis drifts at most (either way).
export const SWARM_AXIS_DRIFT_RADIANS_PER_SECOND = 0.15;
// Low-frequency wander added to the target, in world units and cycles per second at most.
export const SWARM_WANDER_SIZE = 0.08;
export const SWARM_WANDER_HERTZ = 0.25;
// Loop sizes grow with sqrt(alive / INITIAL_SWARM_SHIPS) times this, floored at the 12-ship size.
export const SWARM_FLOCK_SPREAD = 0.6;
// Soft spring toward the target (per second squared) and damping (per second): about 0.65 critical.
export const SWARM_SEEK_STIFFNESS = 14;
export const SWARM_DAMPING = 5;
// Share of the point's velocity the damping follows: below 1 the flock trails a moving point.
export const SWARM_FOLLOW_SHARE = 0.7;
// World units per second; the controlled point moves at 6.
export const SWARM_MAXIMUM_SPEED = 11;
// Below this speed a ship keeps its last heading.
const HEADING_MINIMUM_SPEED = 0.05;

const TWO_PI = Math.PI * 2;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

// A deterministic value in [0, 1) for a slot and a salt (an integer hash, no shared state).
export function slotHash(slot, salt) {
  let value = Math.imul(slot + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

// The per-slot idle character, from the slot index alone.
function slotCharacter(slot) {
  return {
    loopPhase: slotHash(slot, 1) * TWO_PI,
    loopSizeFraction: slotHash(slot, 2),
    loopRadiansPerSecond: TWO_PI / (SWARM_LOOP_SECONDS_MINIMUM + (SWARM_LOOP_SECONDS_MAXIMUM - SWARM_LOOP_SECONDS_MINIMUM) * slotHash(slot, 3)),
    loopDirection: slotHash(slot, 4) < 0.5 ? -1 : 1,
    axisAngle: slotHash(slot, 5) * Math.PI,
    axisDrift: (slotHash(slot, 6) * 2 - 1) * SWARM_AXIS_DRIFT_RADIANS_PER_SECOND,
    wanderPhaseX: slotHash(slot, 7) * TWO_PI,
    wanderPhaseY: slotHash(slot, 8) * TWO_PI,
    wanderHertzX: SWARM_WANDER_HERTZ * (0.4 + 0.6 * slotHash(slot, 9)),
    wanderHertzY: SWARM_WANDER_HERTZ * (0.4 + 0.6 * slotHash(slot, 10)),
    springScale: 0.8 + 0.4 * slotHash(slot, 11),
  };
}

function deadSlot() {
  return {
    alive: false, x: 0, y: 0, velocityX: 0, velocityY: 0, heading: 0, bornSequence: null, bornTime: 0,
    loopPhase: 0, loopSizeFraction: 0, loopRadiansPerSecond: 1, loopDirection: 1, axisAngle: 0, axisDrift: 0,
    wanderPhaseX: 0, wanderPhaseY: 0, wanderHertzX: 0, wanderHertzY: 0, springScale: 1,
  };
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
    this.shipEntries = Array.from({ length: MAXIMUM_SWARM_SHIPS }, () => ({ slot: 0, x: 0, y: 0, age: 0, heading: 0 }));
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

  // Alive ships for rendering and firing: { slot, x, y, age, heading } (age in seconds since spawn,
  // heading in radians along the velocity). The array and its entries are reused: valid until the
  // next call.
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
      entry.heading = slot.heading;
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

  // A new ship in the first dead slot, a little off (x, y) with its slot's idle character; returns
  // the slot or -1 when full.
  spawnShip(x, y) {
    const index = this.slots.findIndex((slot) => !slot.alive);
    if (index < 0) return -1;
    const angle = this.random() * TWO_PI;
    const offset = SWARM_LOOP_SIZE_MINIMUM * 0.5 * this.random();
    this.aliveCountValue += 1;
    Object.assign(this.slots[index], slotCharacter(index), {
      alive: true,
      x: x + Math.cos(angle) * offset,
      y: y + Math.sin(angle) * offset,
      velocityX: 0,
      velocityY: 0,
      heading: angle,
      bornSequence: null,
      bornTime: this.time,
    });
    return index;
  }

  update(deltaSeconds, targetX, targetY) {
    if (!(deltaSeconds > 0)) return;
    const followX = SWARM_FOLLOW_SHARE * (targetX - this.targetX) / deltaSeconds;
    const followY = SWARM_FOLLOW_SHARE * (targetY - this.targetY) / deltaSeconds;
    this.targetX = targetX;
    this.targetY = targetY;
    this.time += deltaSeconds;
    const slots = this.slots;
    const scale = Math.max(1, Math.sqrt(this.aliveCountValue / INITIAL_SWARM_SHIPS) * SWARM_FLOCK_SPREAD);
    const separationSquared = SWARM_SEPARATION_RADIUS * SWARM_SEPARATION_RADIUS;
    const { minX, maxX, minY, maxY } = this.bounds;
    for (const ship of slots) {
      if (!ship.alive) continue;
      ship.loopPhase = (ship.loopPhase + ship.loopDirection * ship.loopRadiansPerSecond * deltaSeconds) % TWO_PI;
      // The ship's figure eight target, inlined so the step builds no object per ship.
      const size = (SWARM_LOOP_SIZE_MINIMUM + (SWARM_LOOP_SIZE_MAXIMUM - SWARM_LOOP_SIZE_MINIMUM) * ship.loopSizeFraction) * scale;
      const along = Math.sin(ship.loopPhase) * size;
      const across = Math.sin(2 * ship.loopPhase) * size * 0.5;
      const axis = ship.axisAngle + ship.axisDrift * this.time;
      const cosine = Math.cos(axis);
      const sine = Math.sin(axis);
      const desiredX = targetX + along * cosine - across * sine + SWARM_WANDER_SIZE * Math.sin(TWO_PI * ship.wanderHertzX * this.time + ship.wanderPhaseX);
      const desiredY = targetY + along * sine + across * cosine + SWARM_WANDER_SIZE * Math.sin(TWO_PI * ship.wanderHertzY * this.time + ship.wanderPhaseY);
      const stiffness = SWARM_SEEK_STIFFNESS * ship.springScale;
      let accelerationX = stiffness * (desiredX - ship.x) - SWARM_DAMPING * (ship.velocityX - followX);
      let accelerationY = stiffness * (desiredY - ship.y) - SWARM_DAMPING * (ship.velocityY - followY);
      for (const other of slots) {
        if (other === ship || !other.alive) continue;
        const offsetX = ship.x - other.x;
        const offsetY = ship.y - other.y;
        const distanceSquared = offsetX * offsetX + offsetY * offsetY;
        if (distanceSquared >= separationSquared || distanceSquared === 0) continue;
        const distance = Math.sqrt(distanceSquared);
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
      if (speed > HEADING_MINIMUM_SPEED) ship.heading = Math.atan2(ship.velocityY, ship.velocityX);
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
