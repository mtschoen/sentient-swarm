// CPU spawn pressure: decides how many agents of each species the GPU spawner adds this frame.
// The alive target ramps from floorFraction to ceilingFraction of capacity over rampSeconds; each
// frame spawns the deficit between the target and the last known alive count, capped at
// capacity / 60, split across species by shares with largest-remainder rounding so the per-species
// counts add up to exactly the frame's total. Each species carries its rounding error to the next
// frame, so small frames rotate the leftover units and long-run totals follow the shares.
import { SPECIES_COUNT } from './layout.js';

// A frame spawns at most capacity / SPAWN_CAP_DIVISOR agents: a full arena refills in a second at 60 fps.
const SPAWN_CAP_DIVISOR = 60;

function lerp(start, end, amount) {
  return start * (1 - amount) + end * amount;
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

// Splits total across SPECIES_COUNT entries in proportion to shares. Leftover units after the
// floors go to the largest remainder plus carried error (ties to the lower species index); carry
// (SPECIES_COUNT numbers, updated in place) accumulates quota minus count per species. Shares are
// clamped at 0 and need not sum to 1; all zero means equal.
export function splitByShares(total, shares, carry = new Float64Array(SPECIES_COUNT)) {
  const clamped = Array.from({ length: SPECIES_COUNT }, (unused, species) => Math.max(0, shares[species] ?? 0));
  const shareTotal = clamped.reduce((sum, share) => sum + share, 0);
  const weights = shareTotal > 0 ? clamped.map((share) => share / shareTotal) : clamped.map(() => 1 / SPECIES_COUNT);
  const quotas = weights.map((weight) => total * weight);
  const counts = new Uint32Array(SPECIES_COUNT);
  quotas.forEach((quota, species) => { counts[species] = Math.floor(quota); });
  let leftover = total - counts.reduce((sum, count) => sum + count, 0);
  const byRemainder = quotas
    .map((quota, species) => ({ species, remainder: quota - Math.floor(quota) + carry[species] }))
    .filter(({ species }) => weights[species] > 0)
    .sort((first, second) => second.remainder - first.remainder || first.species - second.species);
  for (const { species } of byRemainder) {
    if (leftover <= 0) break;
    counts[species] += 1;
    leftover -= 1;
  }
  quotas.forEach((quota, species) => { carry[species] += quota - counts[species]; });
  return counts;
}

export class SpawnPressure {
  constructor({ capacity, rampSeconds = 90, floorFraction = 0.05, ceilingFraction = 0.9 }) {
    this.capacity = capacity;
    this.rampSeconds = rampSeconds;
    this.floorFraction = floorFraction;
    this.ceilingFraction = ceilingFraction;
    this.maximumPerFrame = Math.floor(capacity / SPAWN_CAP_DIVISOR);
    this.elapsed = 0;
    this.carry = new Float64Array(SPECIES_COUNT);
  }

  get targetAlive() {
    return this.capacity * lerp(this.floorFraction, this.ceilingFraction, clampUnit(this.elapsed / this.rampSeconds));
  }

  // For a capacity change: keeps the ramp position and the rounding carry, so the target scales
  // with the new capacity instead of restarting from the floor.
  setCapacity(capacity) {
    this.capacity = capacity;
    this.maximumPerFrame = Math.floor(capacity / SPAWN_CAP_DIVISOR);
  }

  reset() {
    this.elapsed = 0;
    this.carry.fill(0);
  }

  // aliveCount is the latest read-back alive total; it may lag a few frames behind the GPU.
  update(deltaSeconds, aliveCount, shares) {
    this.elapsed += deltaSeconds;
    const deficit = Math.max(0, Math.floor(this.targetAlive - aliveCount));
    return splitByShares(Math.min(deficit, this.maximumPerFrame), shares, this.carry);
  }
}
