// Difficulty escalation (pure): an unbounded second ramp that begins where SpawnPressure's ramp ends.
// Its clock is SpawnPressure.secondsPastRamp (the ramp's elapsed time past rampSeconds), so it runs on
// the same warped delta, restarts wherever the ramp restarts (run start, respawn, quit to title) and
// carries across a capacity swap; the game keeps it neutral outside a Playing run and in watch mode
// (escalation-step.js). With t = rate * secondsPastRamp:
//   refillMultiplier     = min(MAXIMUM_REFILL_MULTIPLIER, exp(t / refillGrowthSeconds))
//   alive ceiling        = c0 + max(0, ceilingFraction - c0) * (1 - exp(-t / ceilingGrowthSeconds)),
//                          c0 the ramp's ceilingFraction; targetMultiplier = ceiling / c0
//   seekMultiplier       = 1 + (seekMaximum - 1) * (1 - exp(-t / seekGrowthSeconds))
//   predatorShift        = predatorShift * (1 - exp(-t / predatorGrowthSeconds)), the share of the
//                          Chaser share moved to the Predator (escalatedShares)
//   wavePeriodMultiplier = 1 / (1 + t / waveGrowthSeconds)
//   burstMultiplier      = min(MAXIMUM_REFILL_MULTIPLIER, exp(t / refillGrowthSeconds) * wavePeriodMultiplier),
//                          so a wave's bank (burstFraction of the target) keeps up with the faster
//                          refill instead of capping it.
// Every lever is exactly 1 (or a zero shift) at t = 0, so rate 0 is today's game and the first
// rampSeconds of every run play as before. Refill is the main lever and grows without bound (the
// multiplier cap and the frame cap of capacity / 60 keep the numbers finite); the count rises mildly
// toward a ceiling (owner ruling R37: well above a tenth of capacity the swarm reads as fog) and stays
// a fraction of capacity, so every preset plays the same.
// Pacing (rate 1, minutes of run time): the spawn throughput is target times refill, against today's
// 0.1 of capacity at 0.15 of it per second: about 1.9 times at minute 4, 3.2 at 6, 5.3 at 8, 8.4 at
// 10, 13 at 12 and 25 at 15. Kills scale with capacity like the spawns (the comfort densities do), so
// these ratios hold at every preset. A full 256-ship swarm fires about 220 shots per second against 65 at 12 ships
// (swarm-fire-rate.js), about 3.4 times the firepower, and pierce kills grow with the density the
// higher count brings, so a strong player holds the field until throughput passes about 4 to 6 times
// (minutes 7 to 9); past that, with seek near 1.75 (Chasers then seek at full speed alone) and
// waves under a second apart, cleared space closes faster than it is shot open, and by minutes 12
// to 15 (13 to 25 times) the swarm overruns the player. Enemy speed is not a lever: no global speed
// multiplier exists (maximumSpeed is per species row), and seek above about 1.67 already drives a
// Chaser at its full speed, past which the steer pass's acceleration and speed clamps mute it.
import { SPECIES_NAMES } from '../sim/species.js';

const CHASER = SPECIES_NAMES.indexOf('Chaser');
const PREDATOR = SPECIES_NAMES.indexOf('Predator');

// The refill multiplier never exceeds this (reached about 23 minutes past the ramp at rate 1).
export const MAXIMUM_REFILL_MULTIPLIER = 100;

export const ESCALATION_DEFAULTS = Object.freeze({
  // Escalation seconds per second past the ramp; 0 turns it off.
  rate: 1,
  // e-folding seconds of the refill multiplier (doubles about every 208 s).
  refillGrowthSeconds: 300,
  // The alive ceiling the target rises toward (a fraction of capacity), and its e-folding seconds.
  ceilingFraction: 0.2,
  ceilingGrowthSeconds: 400,
  // The seek multiplier's limit and e-folding seconds.
  seekMaximum: 2,
  seekGrowthSeconds: 360,
  // The largest share of the Chaser share moved to the Predator, and its e-folding seconds.
  predatorShift: 0.35,
  predatorGrowthSeconds: 480,
  // Seconds past the ramp at which the wave period is halved (at rate 1).
  waveGrowthSeconds: 600,
});

// The ranges set accepts (the lab sliders use the same).
export const ESCALATION_RANGES = Object.freeze({
  rate: [0, 4],
  refillGrowthSeconds: [60, 1800],
  ceilingFraction: [0.02, 0.4],
  ceilingGrowthSeconds: [30, 3600],
  seekMaximum: [1, 3],
  seekGrowthSeconds: [30, 3600],
  predatorShift: [0, 1],
  predatorGrowthSeconds: [30, 3600],
  waveGrowthSeconds: [60, 3600],
});

export const NEUTRAL_ESCALATION = Object.freeze({
  targetMultiplier: 1,
  refillMultiplier: 1,
  seekMultiplier: 1,
  predatorShift: 0,
  wavePeriodMultiplier: 1,
  burstMultiplier: 1,
});

// The levers at secondsPastRamp for these settings (see the header); rampCeilingFraction is the
// ramp's ceilingFraction, the count the escalation starts from.
export function escalationLevels(secondsPastRamp, settings = ESCALATION_DEFAULTS, rampCeilingFraction = 0.1) {
  const time = settings.rate * Math.max(0, secondsPastRamp);
  if (!(time > 0)) return NEUTRAL_ESCALATION;
  const approach = (growthSeconds) => 1 - Math.exp(-time / growthSeconds);
  const refillMultiplier = Math.min(MAXIMUM_REFILL_MULTIPLIER, Math.exp(time / settings.refillGrowthSeconds));
  const ceiling = rampCeilingFraction + Math.max(0, settings.ceilingFraction - rampCeilingFraction) * approach(settings.ceilingGrowthSeconds);
  const wavePeriodMultiplier = 1 / (1 + time / settings.waveGrowthSeconds);
  return {
    targetMultiplier: rampCeilingFraction > 0 ? ceiling / rampCeilingFraction : 1,
    refillMultiplier,
    seekMultiplier: 1 + (settings.seekMaximum - 1) * approach(settings.seekGrowthSeconds),
    predatorShift: settings.predatorShift * approach(settings.predatorGrowthSeconds),
    wavePeriodMultiplier,
    burstMultiplier: Math.min(MAXIMUM_REFILL_MULTIPLIER, Math.exp(time / settings.refillGrowthSeconds) * wavePeriodMultiplier),
  };
}

// The shares with shift (in [0, 1]) of the Chaser share moved to the Predator; the same array when
// the shift is 0, so a neutral escalation passes the simulation's shares through untouched.
export function escalatedShares(shares, shift) {
  if (!(shift > 0)) return shares;
  const next = Array.from(shares, Number);
  const moved = next[CHASER] * Math.min(1, shift);
  next[CHASER] -= moved;
  next[PREDATOR] += moved;
  return next;
}

// The run's one escalation (shared by every seat): its settings, which the lab changes through set.
export class Escalation {
  constructor(settings = {}) {
    this.settings = { ...ESCALATION_DEFAULTS };
    for (const [name, value] of Object.entries(settings)) this.set(name, value);
  }

  // Throws RangeError for an unknown name or a value outside ESCALATION_RANGES; changes nothing then.
  set(name, value) {
    const range = ESCALATION_RANGES[name];
    if (range === undefined) throw new RangeError(`unknown escalation setting ${name}`);
    if (!(Number.isFinite(value) && value >= range[0] && value <= range[1])) {
      throw new RangeError(`escalation ${name} must lie in [${range[0]}, ${range[1]}], got ${value}`);
    }
    this.settings[name] = value;
  }

  levels(secondsPastRamp, rampCeilingFraction) {
    return escalationLevels(secondsPastRamp, this.settings, rampCeilingFraction);
  }
}
