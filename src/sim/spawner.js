// CPU spawn pressure: decides how many agents of each species the GPU spawner adds this frame, how
// strongly they seek the player and how far from the player they land.
// The ramp: rampProgress = (elapsed / rampSeconds) ^ curveExponent, clamped to [0, 1]. The alive
// target is lerp(floorFraction, ceilingFraction, rampProgress) of capacity and the seek scale (a
// multiplier on every species' seek weight, SimParams.seekScale) is lerp(seekFloorFraction, 1,
// rampProgress); the minimum spawn distance from the player (SimParams.spawnDistanceFraction, of the
// arena width) is lerp(spawnDistanceStartFraction, 0.25, rampProgress), never under the spec's
// quarter. The defaults ease in (exponent 2) from 1 percent to 10 percent over 120 seconds, with
// seek at 10 percent and spawns 0.4 of the arena width away at the start. The 10 percent ceiling is
// owner ruling R37 (2026-11-08): above about a tenth of capacity the swarm fills the arena edge to
// edge at the species' comfort densities and reads as fog; at a tenth it packs into a shape with
// empty space around it. Count alone does not set
// the time to the first death: at full seek a stationary ship died about 1.5 to 2 seconds in at
// any count down to 135 agents (the first Chasers arrive about a second after their spawn-in), and
// far spawns alone did not help either; weak early seek plus far early spawns did (task C0 report).
// Counts are fractions of capacity and distances fractions of the arena, so the ramp feels the
// same at every capacity.
// The playable arena can be a sub-rectangle of the world (a canvas aspect other than 16 by 9):
// setAreaFraction(fraction) scales the alive target by the playable area over the world area, so
// the swarm's density, not its count, is what stays the same across aspects. The frame cap
// (maximumPerFrame) stays on the raw capacity.
// Each frame spawns the deficit between the target and the estimated alive count, capped at
// capacity / 60, split across species by shares with largest-remainder rounding so the per-species
// counts add up to exactly the frame's total. The first fill (from construction or reset, so after
// a start and after every respawn) runs at that cap alone: it is the spec's first spawn wave.
// Once the estimate first reaches the target, refills are also capped at refillFractionPerSecond
// of the target per second (owner ruling R13, task C0b: killed space refills slowly, so a cleared
// corridor stays clear for several seconds); the allowance accrues per second of delta, carries
// at most one unit between steps and never banks while nothing is missing. With a wave (the
// SpawnDirector's wave state, task C0b2) the allowance instead banks between waves while agents
// are missing, up to wave.burstFraction of the target, and is released only while a gate emits,
// spread over the wave's remaining seconds; between waves nothing spawns. Each species carries
// its rounding error to the next frame, so small frames rotate the leftover units and long-run
// totals follow the shares.
// Read-back stats lag the GPU by a few steps (more with several fixed steps per frame), so the
// estimate is the newest stats' alive total plus every request made for a step newer than those
// stats: those spawns are in flight and not counted yet. Without them, each lagging step requests
// the same deficit again and the alive count overshoots the target (about 1.33 times at a lag of
// two steps on a cold start). A request the GPU could not fully place only makes the estimate
// high until newer stats arrive, which errs toward spawning less.
import { SPECIES_COUNT } from './layout.js';

// A frame spawns at most capacity / SPAWN_CAP_DIVISOR agents (the first fill runs at this cap alone).
const SPAWN_CAP_DIVISOR = 60;

// The tuned ramp (Plan C task C0); setRamp and the constructor take any subset of these names.
export const DEFAULT_RAMP = Object.freeze({
  floorFraction: 0.01,
  rampSeconds: 120,
  ceilingFraction: 0.1,
  curveExponent: 2,
  seekFloorFraction: 0.1,
  spawnDistanceStartFraction: 0.4,
  refillFractionPerSecond: 0.15,
});

// The spec's minimum spawn distance from the player, as a fraction of the arena width: the end of
// the spawn distance ramp. The start may lie up to MAXIMUM_SPAWN_DISTANCE_FRACTION, where the
// arena's far corners still leave room to place spawns around a centered player.
export const SPEC_SPAWN_DISTANCE_FRACTION = 0.25;
const MAXIMUM_SPAWN_DISTANCE_FRACTION = 0.5;

// Fractions lie in [0, 1]; rampSeconds and curveExponent are positive and finite.
const UNIT_FIELDS = ['floorFraction', 'ceilingFraction', 'seekFloorFraction', 'refillFractionPerSecond'];
const POSITIVE_FIELDS = ['rampSeconds', 'curveExponent'];

function validatedRamp(ramp) {
  for (const name of UNIT_FIELDS) {
    if (!(ramp[name] >= 0 && ramp[name] <= 1)) throw new RangeError(`SpawnPressure ${name} must lie in [0, 1], got ${ramp[name]}`);
  }
  for (const name of POSITIVE_FIELDS) {
    if (!(ramp[name] > 0 && Number.isFinite(ramp[name]))) throw new RangeError(`SpawnPressure ${name} must be positive and finite, got ${ramp[name]}`);
  }
  const start = ramp.spawnDistanceStartFraction;
  if (!(start >= SPEC_SPAWN_DISTANCE_FRACTION && start <= MAXIMUM_SPAWN_DISTANCE_FRACTION)) {
    throw new RangeError(`SpawnPressure spawnDistanceStartFraction must lie in [${SPEC_SPAWN_DISTANCE_FRACTION}, ${MAXIMUM_SPAWN_DISTANCE_FRACTION}], got ${start}`);
  }
  return ramp;
}

// Only the known ramp names, and only those given (undefined leaves the current value).
function pickRamp(ramp) {
  return Object.fromEntries(Object.keys(DEFAULT_RAMP).filter((name) => ramp[name] !== undefined).map((name) => [name, ramp[name]]));
}

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
  constructor({ capacity, ...ramp }) {
    this.capacity = capacity;
    this.ramp = validatedRamp({ ...DEFAULT_RAMP, ...pickRamp(ramp) });
    this.maximumPerFrame = Math.floor(capacity / SPAWN_CAP_DIVISOR);
    // Playable area over world area, in (0, 1]; scales the alive target.
    this.areaFraction = 1;
    this.elapsed = 0;
    this.carry = new Float64Array(SPECIES_COUNT);
    // True until the estimate first reaches the target after construction or reset.
    this.filling = true;
    // Agents the refill rate has allowed but not yet spent (at most one carries between steps).
    this.refillAllowance = 0;
    // Requested totals keyed by the frameSequence of the step they were requested for.
    this.requests = new Map();
    this.newestStats = null;
  }

  // For the lab sliders: replaces the given ramp parameters (any subset of DEFAULT_RAMP's names)
  // and keeps the ramp position, so the target moves to the new curve at the same elapsed time.
  // Throws RangeError and changes nothing when a value is out of range.
  setRamp(ramp) {
    this.ramp = validatedRamp({ ...this.ramp, ...pickRamp(ramp) });
  }

  // For a playable arena smaller than the world: fraction of the world's area, in (0, 1].
  setAreaFraction(fraction) {
    if (!(fraction > 0 && fraction <= 1)) throw new RangeError(`SpawnPressure areaFraction must lie in (0, 1], got ${fraction}`);
    this.areaFraction = fraction;
  }

  // 0 at the start of a run or a life, 1 from rampSeconds on.
  get rampProgress() {
    return clampUnit(this.elapsed / this.ramp.rampSeconds) ** this.ramp.curveExponent;
  }

  get targetAlive() {
    return this.capacity * this.areaFraction * lerp(this.ramp.floorFraction, this.ramp.ceilingFraction, this.rampProgress);
  }

  // Multiplier on every species' seek weight for this step.
  get seekScale() {
    return lerp(this.ramp.seekFloorFraction, 1, this.rampProgress);
  }

  // Minimum spawn distance from the player for this step, as a fraction of the arena width.
  get spawnDistanceFraction() {
    return lerp(this.ramp.spawnDistanceStartFraction, SPEC_SPAWN_DISTANCE_FRACTION, this.rampProgress);
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
    this.filling = true;
    this.refillAllowance = 0;
  }

  // Agents this step may spawn at most: the frame cap, and after the first fill the refill rate
  // (banked between waves when wave is given; see the header).
  stepCap(deltaSeconds, deficit, wave) {
    if (this.filling) return this.maximumPerFrame;
    const bankLimit = wave && deficit > 0 ? Math.max(1, wave.burstFraction * this.targetAlive) : 1;
    this.refillAllowance = Math.min(this.refillAllowance, bankLimit) + this.ramp.refillFractionPerSecond * this.targetAlive * deltaSeconds;
    if (!wave) return Math.min(this.maximumPerFrame, Math.floor(this.refillAllowance));
    if (!wave.emitting) return 0;
    const releasedShare = Math.min(1, deltaSeconds / Math.max(deltaSeconds, wave.remainingSeconds));
    return Math.min(this.maximumPerFrame, Math.floor(this.refillAllowance * releasedShare));
  }

  // Alive agents counted by the newest stats plus the spawns requested for steps after them.
  get estimatedAlive() {
    const seenSequence = this.newestStats?.frameSequence ?? 0;
    let inFlight = 0;
    for (const [sequence, count] of this.requests) {
      if (sequence <= seenSequence) this.requests.delete(sequence);
      else inFlight += count;
    }
    return (this.newestStats?.aliveTotal ?? 0) + inFlight;
  }

  // stats: the newest decoded stats read back ({ aliveTotal, frameSequence }), or null when none
  // has arrived; older stats than ones already seen are ignored. frameSequence: the sequence of
  // the step this request is for (simulation.frameSequence + 1 before simulation.step). wave
  // (optional, SpawnDirector.wave): { emitting, remainingSeconds, burstFraction }; omitted, refills
  // trickle every step.
  update(deltaSeconds, stats, shares, frameSequence, wave = null) {
    this.elapsed += deltaSeconds;
    if (stats && (this.newestStats === null || stats.frameSequence >= this.newestStats.frameSequence)) this.newestStats = stats;
    const deficit = Math.max(0, Math.floor(this.targetAlive - this.estimatedAlive));
    const counts = splitByShares(Math.min(deficit, this.stepCap(deltaSeconds, deficit, wave)), shares, this.carry);
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (this.filling && total >= deficit) this.filling = false;
    else if (!this.filling) this.refillAllowance -= total;
    if (total > 0) this.requests.set(frameSequence, (this.requests.get(frameSequence) ?? 0) + total);
    return counts;
  }
}
