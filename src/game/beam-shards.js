// Beam shards: how many are needed, how often a wave yields one, and where one is placed.
// Placement rationale: off screen so the edge chevron has a job, within reach (twice the view
// half-diagonal of the anchor) so the trip is a few seconds, away from spawn gates so a shard is
// not buried in a wave, and spaced from the shards already waiting so six do not stack.
// The cadence and the rule "never more than needed in play" live in `BeamShards.onWaves`.

export const BEAM_SHARDS_NEEDED = 6;
export const BEAM_SHARD_WAVE_INTERVAL = 10;
export const MAXIMUM_BEAM_SHARDS_NEEDED = 8;
export const MAXIMUM_BEAM_SHARD_WAVE_INTERVAL = 60;

export const SHARD_WALL_INSET = 1;
export const SHARD_VIEW_MARGIN = 1;
export const SHARD_GATE_CLEARANCE = 2;
export const SHARD_SPACING = 4;
export const SHARD_MAXIMUM_REACH_HALF_DIAGONALS = 2;
export const SHARD_PLACEMENT_ATTEMPTS = 32;
export const SHARD_DENSITY_CANDIDATES = 8;

function requireInteger(value, minimum, maximum, name) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer in [${minimum}, ${maximum}], got ${value}`);
  }
}

export class BeamShards {
  #count = 0;
  #needed;
  #waveInterval;
  #lastSequence = 0;
  #tally = 0;

  constructor({ needed = BEAM_SHARDS_NEEDED, waveInterval = BEAM_SHARD_WAVE_INTERVAL } = {}) {
    this.setNeeded(needed);
    this.setWaveInterval(waveInterval);
  }

  setNeeded(count) {
    requireInteger(count, 1, MAXIMUM_BEAM_SHARDS_NEEDED, 'needed');
    this.#needed = count;
  }

  setWaveInterval(waves) {
    requireInteger(waves, 1, MAXIMUM_BEAM_SHARD_WAVE_INTERVAL, 'waveInterval');
    this.#waveInterval = waves;
  }

  get count() {
    return this.#count;
  }

  get needed() {
    return this.#needed;
  }

  get waveInterval() {
    return this.#waveInterval;
  }

  // How many shards to spawn now (0 or 1). A jump of several waves still yields one; a full
  // field keeps the tally banked; beam time banks nothing and starts a fresh tally afterwards.
  onWaves(waveSequence, { waiting, beamTimeActive }) {
    if (waveSequence < this.#lastSequence) {
      this.#lastSequence = waveSequence;
      this.#tally = 0;
      return 0;
    }
    const newWaves = waveSequence - this.#lastSequence;
    this.#lastSequence = waveSequence;
    if (beamTimeActive) {
      this.#tally = 0;
      return 0;
    }
    this.#tally += newWaves;
    if (this.#tally < this.#waveInterval) return 0;
    if (waiting + this.#count >= this.#needed) return 0;
    this.#tally = 0;
    return 1;
  }

  // The count is not clamped: the caller ignores `completed` during beam time.
  collect() {
    this.#count += 1;
    return { count: this.#count, completed: this.#count >= this.#needed };
  }

  // Beam time ended.
  finish() {
    this.#count = 0;
    this.#tally = 0;
  }

  // The wave counter restarted (the spawn director reset): count again from its next wave, keeping
  // the collected shards.
  rebase() {
    this.#tally = 0;
    this.#lastSequence = 0;
  }

  reset() {
    this.#count = 0;
    this.#tally = 0;
    this.#lastSequence = 0;
  }
}

// context: { bounds, view: { centerX, centerY, width, height }, anchor: { x, y },
//   gates: [{ x, y, radius }], shards: [{ x, y }], densityAt: ((x, y) => number) | null }
export function placeShard(context, random = Math.random) {
  const { bounds, view, anchor, gates, shards, densityAt } = context;
  const minX = bounds.minX + SHARD_WALL_INSET;
  const maxX = bounds.maxX - SHARD_WALL_INSET;
  const minY = bounds.minY + SHARD_WALL_INSET;
  const maxY = bounds.maxY - SHARD_WALL_INSET;
  const reach = SHARD_MAXIMUM_REACH_HALF_DIAGONALS * Math.hypot(view.width, view.height) / 2;

  const offScreen = (x, y) => Math.abs(x - view.centerX) > view.width / 2 + SHARD_VIEW_MARGIN
    || Math.abs(y - view.centerY) > view.height / 2 + SHARD_VIEW_MARGIN;
  const withinReach = (x, y) => Math.hypot(x - anchor.x, y - anchor.y) <= reach;
  const clearOfGates = (x, y) => gates.every((gate) => Math.hypot(x - gate.x, y - gate.y) >= gate.radius + SHARD_GATE_CLEARANCE);
  const spaced = (x, y) => shards.every((shard) => Math.hypot(x - shard.x, y - shard.y) >= SHARD_SPACING);

  const rules = [
    (x, y) => offScreen(x, y) && withinReach(x, y) && clearOfGates(x, y) && spaced(x, y),
    (x, y) => offScreen(x, y) && clearOfGates(x, y) && spaced(x, y),
    (x, y) => offScreen(x, y),
  ];
  const wanted = densityAt === null ? 1 : SHARD_DENSITY_CANDIDATES;
  for (const accept of rules) {
    const candidates = [];
    for (let attempt = 0; attempt < SHARD_PLACEMENT_ATTEMPTS && candidates.length < wanted; attempt += 1) {
      const x = minX + random() * (maxX - minX);
      const y = minY + random() * (maxY - minY);
      if (accept(x, y)) candidates.push({ x, y });
    }
    if (candidates.length === 0) continue;
    let chosen = candidates[0];
    if (densityAt !== null) {
      let lowest = densityAt(chosen.x, chosen.y);
      for (const candidate of candidates.slice(1)) {
        const density = densityAt(candidate.x, candidate.y);
        if (density < lowest) {
          lowest = density;
          chosen = candidate;
        }
      }
    }
    return chosen;
  }

  // Nothing is off screen (a view as large as the world): the inset corner farthest from the anchor.
  let farthest = { x: minX, y: minY };
  let farthestDistance = -1;
  for (const x of [minX, maxX]) {
    for (const y of [minY, maxY]) {
      const distance = Math.hypot(x - anchor.x, y - anchor.y);
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthest = { x, y };
      }
    }
  }
  return farthest;
}
