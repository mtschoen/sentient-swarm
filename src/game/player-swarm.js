// The player swarm (player-swarm spike): a small flock of white ships that fly around the
// player-controlled point in place of a single ship. Pure CPU: no GPU, DOM or clock (time is the
// sum of update deltas) and no random numbers in the step.
//
// Motion: each ship is its own agent steered by the enemy Chaser's rules ported to the CPU
// (src/game/swarm-flocking.js: seek with arrival braking toward the point, alignment above seek,
// short separation, cohesion and pressure from the neighbourhood), plus a per-slot temperament,
// wander, a leash that keeps the flock controllable, and attack runs along the aim while firing.
// Each ship flies along its course (its velocity's direction) and points along its heading, which
// turns off the course toward the aim while firing, within a limit (src/game/swarm-facing.js); it
// fires along its heading (src/game/swarm-fire.js).
//
// Contact bookkeeping (player_collide.wgsl): the GPU sets bit s of a persistent hit mask when an
// agent touches slot s, and clears it while the slot is uploaded dead or fresh. contactShips(sequence)
// marks a newly spawned ship fresh in the first step it is uploaded and records that step as its
// bornSequence; applyHits honors a bit only for an alive ship and a stats frame at or after its
// bornSequence, so a late readback never kills a ship twice or kills a ship grown into a reused slot.
// Up to MAXIMUM_SWARM_SHIPS (256) ships; update, contactShips and ships reuse their arrays and
// objects, so a step allocates nothing.
import { FULL_ARENA_BOUNDS, MAXIMUM_SWARM_SHIPS } from '../sim/layout.js';
import { faceStep } from './swarm-facing.js';
import { FISH_FEEL, FOLLOW_SMOOTH_SECONDS } from './swarm-feel.js';
import { SWARM_CRUISE_SPEED, SWARM_MAXIMUM_SPEED, flockStep, temperamentFor } from './swarm-flocking.js';

export { MAXIMUM_SWARM_SHIPS };
export const INITIAL_SWARM_SHIPS = 12;
// One new ship per this many scored kills, up to MAXIMUM_SWARM_SHIPS.
export const KILLS_PER_SWARM_SHIP = 100;
// Ship size relative to the first spike's ships: the drawn dart (src/render/swarm.js) and the
// contact radius scale with it, so the visual and the hitbox agree.
export const SWARM_SHIP_SIZE = 0.32;
// Contact radius in world units (the first spike's ships used 0.06, the old single ship 0.12).
export const SWARM_SHIP_RADIUS = 0.06 * SWARM_SHIP_SIZE;
// Spawned ships start within this distance of the point.
const SPAWN_SCATTER = 0.15;

const TWO_PI = Math.PI * 2;
const NO_AIM = Object.freeze({ firing: false, aimX: 0, aimY: 0 });

function deadSlot() {
  return {
    alive: false, x: 0, y: 0, velocityX: 0, velocityY: 0, previousVelocityX: 0, previousVelocityY: 0, course: 0, heading: 0,
    bornSequence: null, bornTime: 0, ...temperamentFor(0),
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
    // Reused flockStep context.
    this.context = { targetX: 0, targetY: 0, firing: false, aimX: 0, aimY: 0, time: 0, aliveCount: 0, bounds, margin: SWARM_SHIP_RADIUS, feel: FISH_FEEL, carryX: 0, carryY: 0 };
    // The point's velocity, smoothed over FOLLOW_SMOOTH_SECONDS: the follow dial's share of it
    // carries the flock (flockStep's carry).
    this.pointVelocityX = 0;
    this.pointVelocityY = 0;
  }

  // The swarm feel dials (src/game/swarm-feel.js, experiment): { alignment, tightness, buzz }; the
  // swarm starts with FISH_FEEL (the behaviour before the dials). The object is read every step.
  setFeel(feel) {
    this.context.feel = feel;
  }

  setBounds(bounds) {
    this.bounds = bounds;
  }

  get aliveCount() {
    return this.aliveCountValue;
  }

  // Alive ships for rendering and firing: { slot, x, y, age, heading } (age in seconds since spawn,
  // heading in radians, where the ship points). The array and its entries are reused: valid until the
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
    this.pointVelocityX = 0;
    this.pointVelocityY = 0;
    for (let index = 0; index < Math.min(count, MAXIMUM_SWARM_SHIPS); index += 1) this.spawnShip(x, y);
  }

  // A new ship in the first dead slot, a little off (x, y), flying outward at its cruise speed with
  // its slot's temperament; returns the slot or -1 when full.
  spawnShip(x, y) {
    const index = this.slots.findIndex((slot) => !slot.alive);
    if (index < 0) return -1;
    const angle = this.random() * TWO_PI;
    const offset = SPAWN_SCATTER * this.random();
    const temperament = temperamentFor(index);
    this.aliveCountValue += 1;
    Object.assign(this.slots[index], temperament, {
      alive: true,
      x: x + Math.cos(angle) * offset,
      y: y + Math.sin(angle) * offset,
      velocityX: Math.cos(angle) * temperament.cruiseSpeed,
      velocityY: Math.sin(angle) * temperament.cruiseSpeed,
      course: angle,
      heading: angle,
      bornSequence: null,
      bornTime: this.time,
    });
    return index;
  }

  // controls (optional): { firing, aimX, aimY } with a unit or zero aim; firing makes attack runs
  // and turns the ships toward the aim.
  update(deltaSeconds, targetX, targetY, controls = NO_AIM) {
    if (!(deltaSeconds > 0)) return;
    // The point's velocity from its movement this step, capped at the ships' top speed so a point
    // that jumps does not fling the flock.
    let velocityX = (targetX - this.targetX) / deltaSeconds;
    let velocityY = (targetY - this.targetY) / deltaSeconds;
    const speed = Math.hypot(velocityX, velocityY);
    if (speed > SWARM_MAXIMUM_SPEED) {
      velocityX *= SWARM_MAXIMUM_SPEED / speed;
      velocityY *= SWARM_MAXIMUM_SPEED / speed;
    }
    const blend = 1 - Math.exp(-deltaSeconds / FOLLOW_SMOOTH_SECONDS);
    this.pointVelocityX += (velocityX - this.pointVelocityX) * blend;
    this.pointVelocityY += (velocityY - this.pointVelocityY) * blend;
    this.targetX = targetX;
    this.targetY = targetY;
    this.time += deltaSeconds;
    const context = this.context;
    const follow = context.feel.follow ?? 0;
    context.carryX = this.pointVelocityX * follow;
    context.carryY = this.pointVelocityY * follow;
    context.targetX = targetX;
    context.targetY = targetY;
    context.firing = controls.firing;
    context.aimX = controls.aimX;
    context.aimY = controls.aimY;
    context.time = this.time;
    context.aliveCount = this.aliveCountValue;
    context.bounds = this.bounds;
    flockStep(this.slots, deltaSeconds, context);
    faceStep(this.slots, deltaSeconds, controls);
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
