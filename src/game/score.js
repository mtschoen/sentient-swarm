// Score keeping: capacity-normalized points, kill-streak multiplier, and extra life and bomb awards.
// Normalization across a capacity change: each kill is converted to reference-capacity kills
// (REFERENCE_CAPACITY / capacity) when it is recorded, so the streak is stored in reference units
// and compared with the unscaled STREAK_THRESHOLDS, and points use the capacity in effect for that
// kill. setCapacity therefore changes only the kills after it: past score and the multiplier tier
// never jump, and the streak keeps the same fraction of the way to the next step.

export const REFERENCE_CAPACITY = 262144;
export const MULTIPLIER_STEPS = [1, 2, 3, 4, 5, 6, 8, 10];
export const STREAK_THRESHOLDS = [0, 50, 150, 400, 1000, 2500, 6000, 15000];

const BASE_POINTS_PER_KILL = 10;
const LIFE_BASE = 75000;
const BOMB_BASE = 40000;

export function nextLifeThreshold(index) {
  return LIFE_BASE * 2 ** index;
}

export function nextBombThreshold(index) {
  return BOMB_BASE * 2.5 ** index;
}

export class ScoreKeeper {
  constructor({ capacity }) {
    this.capacityValue = capacity;
    this.reset();
  }

  get capacity() { return this.capacityValue; }

  // A capacity swap (Game's CapacitySwap install); see the header for what carries.
  setCapacity(capacity) {
    this.capacityValue = capacity;
  }

  reset() {
    this._score = 0;
    this._streak = 0;
    this._stepIndex = 0;
    this._milestone = false;
  }

  get score() { return this._score; }
  get streak() { return this._streak; }
  get multiplier() { return MULTIPLIER_STEPS[this._stepIndex]; }
  get pointsPerKill() { return BASE_POINTS_PER_KILL * this._referenceKillsPerKill; }
  get _referenceKillsPerKill() { return REFERENCE_CAPACITY / this.capacityValue; }

  // Streak (in reference-capacity kills, see the header) at which the next multiplier step is
  // reached, or null at the top step.
  get nextMultiplierAt() {
    const next = this._stepIndex + 1;
    if (next >= MULTIPLIER_STEPS.length) return null;
    return STREAK_THRESHOLDS[next];
  }

  // Kills score at the multiplier in effect before this batch steps it.
  recordKills(count) {
    if (!(count > 0)) return;
    this._score += count * this.pointsPerKill * this.multiplier;
    this._streak += count * this._referenceKillsPerKill;
    let index = this._stepIndex;
    while (index + 1 < MULTIPLIER_STEPS.length && this._streak >= STREAK_THRESHOLDS[index + 1]) {
      index += 1;
    }
    if (index !== this._stepIndex) {
      this._stepIndex = index;
      this._milestone = true;
    }
  }

  recordHit() {
    this._streak = 0;
    this._stepIndex = 0;
    this._milestone = false;
  }

  consumeMilestone() {
    const flag = this._milestone;
    this._milestone = false;
    return flag;
  }
}

export class Awards {
  constructor() {
    this._lifeIndex = 0;
    this._bombIndex = 0;
  }

  // Returns how many lives and bombs were newly earned since the previous call.
  update(score) {
    let lives = 0;
    let bombs = 0;
    while (score >= nextLifeThreshold(this._lifeIndex)) {
      this._lifeIndex += 1;
      lives += 1;
    }
    while (score >= nextBombThreshold(this._bombIndex)) {
      this._bombIndex += 1;
      bombs += 1;
    }
    return { lives, bombs };
  }
}
