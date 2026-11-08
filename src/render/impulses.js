// Warp grid shockwave impulses and the bloom boost. Times are game (simulation) seconds, passed
// in explicitly so tests inject them. ImpulseSet keeps at most capacity impulses; a new one takes
// a dead slot first, else replaces the oldest. toUniformArray packs [x, y, age, strength] per slot
// for the WarpView uniform (warpgrid.wgsl), with strength 0 for dead or unused slots.

export const DEFAULT_IMPULSE_CAPACITY = 8;
// Matches IMPULSE_DURATION_SECONDS in warpgrid.wgsl.
export const DEFAULT_IMPULSE_DURATION_SECONDS = 1.2;
export const BLOOM_BOOST_SECONDS = 0.3;
const FLOATS_PER_IMPULSE = 4;

export class ImpulseSet {
  constructor({ capacity = DEFAULT_IMPULSE_CAPACITY, durationSeconds = DEFAULT_IMPULSE_DURATION_SECONDS } = {}) {
    this.capacity = capacity;
    this.durationSeconds = durationSeconds;
    this.impulses = [];
    // The shake setting: scales every packed strength.
    this.strengthMultiplier = 1;
  }

  get count() { return this.impulses.length; }

  add({ x, y, strength }, time) {
    this.prune(time);
    const impulse = { x, y, strength, time };
    if (this.impulses.length < this.capacity) {
      this.impulses.push(impulse);
      return;
    }
    let oldestIndex = 0;
    this.impulses.forEach((candidate, index) => {
      if (candidate.time < this.impulses[oldestIndex].time) oldestIndex = index;
    });
    this.impulses[oldestIndex] = impulse;
  }

  isAlive(impulse, time) {
    const age = time - impulse.time;
    return age >= 0 && age < this.durationSeconds;
  }

  // Drops expired impulses only; one stamped later than time is kept (it packs with strength 0
  // until time reaches it), so adding an older-stamped impulse never drops a newer one.
  prune(time) {
    this.impulses = this.impulses.filter((impulse) => time - impulse.time < this.durationSeconds);
  }

  toUniformArray(time) {
    const packed = new Float32Array(this.capacity * FLOATS_PER_IMPULSE);
    this.impulses.forEach((impulse, slot) => {
      const strength = this.isAlive(impulse, time) ? impulse.strength * this.strengthMultiplier : 0;
      packed.set([impulse.x, impulse.y, time - impulse.time, strength], slot * FLOATS_PER_IMPULSE);
    });
    return packed;
  }
}

// Bloom strength multiplier secondsSinceBoost after a bomb or death: 2 at the boost, falling
// linearly back to 1 over BLOOM_BOOST_SECONDS (1 before any boost or for a negative interval).
export function bloomBoostFactor(secondsSinceBoost) {
  if (!(secondsSinceBoost >= 0) || secondsSinceBoost >= BLOOM_BOOST_SECONDS) return 1;
  return 2 - secondsSinceBoost / BLOOM_BOOST_SECONDS;
}
