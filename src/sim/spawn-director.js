// CPU spawn director (owner ruling R14, task C0b2): new agents enter through a few discrete spawn
// gates instead of anywhere along the walls. Each gate has a position (on the ring just outside the
// camera's view, or in the wall band or the interior; never within the player's safe radius), a
// radius, a favored species and a lifetime.
// A gate fades open over GATE_FADE_SECONDS, drifts slowly (bouncing off the walls and steering
// away from the player), and fades closed at the end of its lifetime; a new gate then opens
// elsewhere, so the pressure moves around the arena over a run. A gate the player walks into
// (within the safe radius plus the gate radius) stops emitting and starts closing at once.
// Waves: every wavePeriodSeconds one open gate (the next gate, picked TELEGRAPH_SECONDS ahead so
// the renderer can brighten it, favoring gates far from the player) emits for waveSeconds; between
// waves no gate emits. SpawnPressure banks its refill allowance between waves (at most
// burstFraction of the alive target) and releases it over the wave's remaining seconds, so the
// long-run refill rate is unchanged and arrives in bursts with quiet gaps. The first fill of a
// life (SpawnPressure.filling) is the spec's first spawn wave: every open gate emits until it ends.
// Continuous mode (the game's Ready phase, the attract arena before a run) has no waves: every open
// gate emits and wave is null, so SpawnPressure trickles its refills as without a director.
// Aim lane (owner ruling R13 carried into R14): a gate whose disc reaches within AIM_LANE_HALF_WIDTH
// of the ray from the player along the aim never emits a wave (a wave in progress stops when its
// gate enters the lane; the bank waits for the next wave), and new gates avoid the lane, so the
// lane the player is shooting open does not refill from its far end; a gate that stays in the lane
// for AIM_LANE_CLOSE_SECONDS closes, so a new one opens elsewhere. The first fill ignores the lane.
// Partner (co-op): with context.partner, a second player { x, y, aimX, aimY }, every distance to
// the player is to the nearer of the two and a gate in either player's aim lane is in the lane;
// without one every expression is the solo one and the same random numbers are drawn.
// Time is the summed deltaSeconds of update (injected), randomness the injected random.
// Bounds: gates place, drift and bounce inside context.bounds (the playable world bounds,
// Game.worldBounds; WORLD_BOUNDS by default).
// View ring: with context.view (the camera's { centerX, centerY, width, height }) a new gate opens on
// a ring around the view center, RING_INNER_HALF_DIAGONALS to RING_OUTER_HALF_DIAGONALS view
// half-diagonals out, so just outside what the camera shows (the half-diagonal circle holds the
// whole view), and inside the bounds; a gate that drifts or is left more than
// FAR_CLOSE_HALF_DIAGONALS half-diagonals from the view center closes, so the gates follow the
// camera. When no ring draw lies inside the bounds (a view as large as the world), and without a
// view, gates place in the wall band or the interior as below.
// The shader side (spawn.wgsl) samples each new agent's position from the emitting gates, weighted
// by emission and by speciesBias toward the gate's favored species; see spawnGates.
import { WORLD_BOUNDS, SPECIES_COUNT } from './layout.js';

export const MAXIMUM_SPAWN_GATES = 4;
// Seconds a gate takes to fade open and to fade closed; it emits only while fully open.
export const GATE_FADE_SECONDS = 0.6;
// Seconds before a wave that its gate is picked and shown (the telegraph).
export const TELEGRAPH_SECONDS = 0.5;
// Gate centers stay this far inside the walls (plus the gate radius); the wall band is the strip
// of this depth beyond that inset.
const WALL_INSET = 0.15;
const WALL_BAND_DEPTH = 1.2;
// Placement draws per new gate; the best scoring placeable draw wins.
const PLACEMENT_CANDIDATES = 16;
// Draws per new gate at most, counting the ring draws that fall outside the bounds.
const PLACEMENT_DRAW_ATTEMPTS = 64;
// Chance a placement candidate lies in the wall band rather than the interior: mostly walls, so
// waves come in from the edges and rarely open up in the space the player is clearing.
const WALL_BAND_CHANCE = 0.8;
// Placement score per world unit of distance from the player (the far side wins).
const PLACEMENT_DISTANCE_WEIGHT = 1;
// Gates keep at least this far from each other when they can (a scoring term, not a hard rule).
const PREFERRED_GATE_SPACING = 4;
// Drift turns away from the player inside the safe radius plus this margin.
const DRIFT_AVOID_MARGIN = 1.5;
const AIM_LANE_HALF_WIDTH = 1;
const AIM_LANE_CLOSE_SECONDS = 2;
// Placement score lost by a candidate in the aim lane (placeable still beats unplaceable).
const AIM_LANE_PENALTY = 500;
// The view ring, in view half-diagonals from the view center (see the header).
export const RING_INNER_HALF_DIAGONALS = 1;
export const RING_OUTER_HALF_DIAGONALS = 1.4;
export const FAR_CLOSE_HALF_DIAGONALS = 2;

export const DEFAULT_GATE_SCHEDULE = Object.freeze({
  gateCount: 3,
  gateLifetimeSeconds: 14,
  wavePeriodSeconds: 1.6,
  waveSeconds: 0.7,
  burstFraction: 0.25,
  driftSpeed: 0.3,
  gateRadius: 0.8,
  speciesBias: 0.7,
});

const RANGES = {
  gateLifetimeSeconds: [2, 120],
  wavePeriodSeconds: [0.2, 20],
  waveSeconds: [0.05, 5],
  burstFraction: [0.01, 1],
  driftSpeed: [0, 3],
  gateRadius: [0.2, 2],
  speciesBias: [0, 1],
};

// Throws RangeError for any out-of-range name; unknown names are ignored.
export function validatedSchedule(schedule) {
  if (!(Number.isInteger(schedule.gateCount) && schedule.gateCount >= 1 && schedule.gateCount <= MAXIMUM_SPAWN_GATES)) {
    throw new RangeError(`SpawnDirector gateCount must be an integer in [1, ${MAXIMUM_SPAWN_GATES}], got ${schedule.gateCount}`);
  }
  for (const [name, [minimum, maximum]] of Object.entries(RANGES)) {
    if (!(schedule[name] >= minimum && schedule[name] <= maximum)) {
      throw new RangeError(`SpawnDirector ${name} must lie in [${minimum}, ${maximum}], got ${schedule[name]}`);
    }
  }
  return schedule;
}

function pickSchedule(schedule) {
  return Object.fromEntries(Object.keys(DEFAULT_GATE_SCHEDULE).filter((name) => schedule[name] !== undefined).map((name) => [name, schedule[name]]));
}

// True when a disc of radius at point reaches within AIM_LANE_HALF_WIDTH of the ray from the
// player along the aim, ahead of the player (never without an aim).
export function inAimLane(point, radius, { playerX, playerY, aimX, aimY }) {
  const aimLength = Math.hypot(aimX, aimY);
  if (aimLength === 0) return false;
  const offsetX = point.x - playerX;
  const offsetY = point.y - playerY;
  const along = (offsetX * aimX + offsetY * aimY) / aimLength;
  const across = Math.abs(offsetX * aimY - offsetY * aimX) / aimLength;
  return along > 0 && across < AIM_LANE_HALF_WIDTH + radius;
}

// The offset from the nearer player to the point, and its length. With no partner this is the
// player's offset and distance exactly.
function nearestPlayerOffset(point, { playerX, playerY, partner }) {
  const offsetX = point.x - playerX;
  const offsetY = point.y - playerY;
  const distance = Math.hypot(offsetX, offsetY);
  if (!partner) return { offsetX, offsetY, distance };
  const partnerOffsetX = point.x - partner.x;
  const partnerOffsetY = point.y - partner.y;
  const partnerDistance = Math.hypot(partnerOffsetX, partnerOffsetY);
  return partnerDistance < distance ? { offsetX: partnerOffsetX, offsetY: partnerOffsetY, distance: partnerDistance } : { offsetX, offsetY, distance };
}

// inAimLane for the player or, with a partner, either player.
function inAnyAimLane(point, radius, context) {
  if (inAimLane(point, radius, context)) return true;
  const { partner } = context;
  return Boolean(partner) && inAimLane(point, radius, { playerX: partner.x, playerY: partner.y, aimX: partner.aimX, aimY: partner.aimY });
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export class SpawnDirector {
  constructor({ random = Math.random, ...schedule } = {}) {
    this.random = random;
    this.schedule = validatedSchedule({ ...DEFAULT_GATE_SCHEDULE, ...pickSchedule(schedule) });
    this.gates = [];
    this.reset();
  }

  // For the lab sliders: replaces the given schedule values (any subset of DEFAULT_GATE_SCHEDULE's
  // names); open gates keep their lifetimes, a lower gateCount closes the newest extras, a new
  // radius applies at once. Throws RangeError and changes nothing when a value is out of range.
  setSchedule(schedule) {
    this.schedule = validatedSchedule({ ...this.schedule, ...pickSchedule(schedule) });
    this.gates.forEach((gate) => { gate.radius = this.schedule.gateRadius; });
  }

  // A new run or life: every gate closes and gateCount new ones open fully at once (the first
  // fill pours from all of them), with staggered lifetimes so they do not all close together.
  // The first regular wave comes one wave period after the fill.
  reset() {
    this.gates = [];
    this.needsInitialGates = true;
    this.waveClock = this.schedule.wavePeriodSeconds;
    this.nextGate = null;
    this.activeWave = null;
    this.filling = false;
    this.continuous = false;
  }

  // options: playerX, playerY (world units, the bounds center when omitted), safeDistance (the
  // minimum spawn distance from the player, SpawnPressure.spawnDistanceFraction times the view
  // width), filling (SpawnPressure's first fill), shares (species shares, for each new gate's
  // favored species), continuous (no waves; see the header), aimX and aimY (the player's aim, a
  // unit vector or zero for none), bounds (the playable rectangle { minX, minY, maxX, maxY, width,
  // height }, WORLD_BOUNDS when omitted), view (the camera's { centerX, centerY, width, height }, or
  // null for none; see the header's view ring), partner (a second player { x, y, aimX, aimY }, or
  // null for none; see the header).
  update(deltaSeconds, {
    bounds = WORLD_BOUNDS, playerX = (bounds.minX + bounds.maxX) / 2, playerY = (bounds.minY + bounds.maxY) / 2,
    safeDistance = 0, filling = false, shares = [], continuous = false, aimX = 0, aimY = 0, view = null,
    partner = null,
  } = {}) {
    const context = { playerX, playerY, safeDistance, shares, aimX, aimY, bounds, view, partner };
    this.filling = filling;
    this.continuous = continuous;
    if (this.needsInitialGates) {
      this.needsInitialGates = false;
      for (let index = 0; index < this.schedule.gateCount; index += 1) {
        const lifetime = this.schedule.gateLifetimeSeconds * (0.5 + (index + 1) / (this.schedule.gateCount + 1));
        this.gates.push(this.openGate(context, { age: GATE_FADE_SECONDS, lifetime }));
      }
    }
    this.gates.forEach((gate) => this.advanceGate(gate, deltaSeconds, context));
    this.gates = this.gates.filter((gate) => gate.age < gate.lifetime);
    this.gates.filter((gate) => !gate.closing).slice(this.schedule.gateCount).forEach((gate) => this.beginClosing(gate));
    while (this.gates.filter((gate) => !gate.closing).length < this.schedule.gateCount && this.gates.length < MAXIMUM_SPAWN_GATES * 2) {
      this.gates.push(this.openGate(context, { age: 0, lifetime: this.schedule.gateLifetimeSeconds }));
    }
    this.advanceWaves(deltaSeconds, context);
    this.gates.forEach((gate) => {
      gate.open = this.envelope(gate);
      const emitsWave = this.activeWave?.gate === gate;
      gate.emit = gate.open >= 1 && !gate.closing && (filling || continuous || emitsWave) ? 1 : 0;
      gate.telegraph = this.nextGate === gate ? clamp(1 - this.waveClock / TELEGRAPH_SECONDS, 0, 1) : 0;
    });
  }

  // Wave state for SpawnPressure.update: emitting (some gate emits this step), the seconds left in
  // the current emission window, and the bank limit as a fraction of the alive target; null in
  // continuous mode.
  get wave() {
    if (this.continuous) return null;
    const emitting = this.gates.some((gate) => gate.emit > 0);
    const remainingSeconds = this.filling ? 0 : (this.activeWave?.remaining ?? 0);
    return { emitting, remainingSeconds, burstFraction: this.schedule.burstFraction };
  }

  // The step's gate table for Simulation.step (the SimParams gates, and the gate renderer): at
  // most MAXIMUM_SPAWN_GATES gates, emitting ones first, then the most open, as copies
  // { x, y, radius, emit, species, open, telegraph }, plus speciesBias.
  get spawnGates() {
    const gates = [...this.gates]
      .sort((first, second) => second.emit - first.emit || second.open - first.open)
      .slice(0, MAXIMUM_SPAWN_GATES)
      .map(({ x, y, radius, emit, species, open, telegraph }) => ({ x, y, radius, emit, species, open, telegraph }));
    return { gates, speciesBias: this.schedule.speciesBias };
  }

  advanceWaves(deltaSeconds, context) {
    if (this.activeWave !== null) {
      this.activeWave.remaining -= deltaSeconds;
      if (this.activeWave.remaining <= 0 || !this.gates.includes(this.activeWave.gate) || !this.canEmit(this.activeWave.gate, context)) this.activeWave = null;
    }
    this.waveClock -= deltaSeconds;
    if (this.nextGate !== null && (!this.gates.includes(this.nextGate) || !this.canEmit(this.nextGate, context))) this.nextGate = null;
    if (this.waveClock <= TELEGRAPH_SECONDS && this.nextGate === null) this.nextGate = this.pickWaveGate(context);
    if (this.waveClock <= 0) {
      this.waveClock += this.schedule.wavePeriodSeconds;
      if (this.waveClock <= 0) this.waveClock = this.schedule.wavePeriodSeconds;
      const gate = this.nextGate ?? this.pickWaveGate(context);
      this.nextGate = null;
      if (gate !== null) {
        this.activeWave = { gate, remaining: this.schedule.waveSeconds };
        this.lastWaveGate = gate;
      }
    }
  }

  // A gate may emit a wave when fully open, not closing, outside the player's safe radius and
  // outside the aim lane.
  canEmit(gate, context) {
    return this.envelope(gate) >= 1 && !gate.closing && nearestPlayerOffset(gate, context).distance >= context.safeDistance + gate.radius
      && !inAnyAimLane(gate, gate.radius, context);
  }

  // The farthest gate that can emit, with some randomness, avoiding the gate of the previous wave
  // while another one can emit; null when none can.
  pickWaveGate(context) {
    const candidates = this.gates.filter((gate) => this.canEmit(gate, context));
    if (candidates.length === 0) return null;
    const pool = candidates.length > 1 ? candidates.filter((gate) => gate !== this.lastWaveGate) : candidates;
    let best = null;
    let bestScore = -Infinity;
    for (const gate of pool) {
      const score = nearestPlayerOffset(gate, context).distance + this.random() * 4;
      if (score > bestScore) {
        best = gate;
        bestScore = score;
      }
    }
    return best;
  }

  advanceGate(gate, deltaSeconds, context) {
    gate.age += deltaSeconds;
    if (!gate.closing && gate.age >= gate.lifetime - GATE_FADE_SECONDS) this.beginClosing(gate);
    const { offsetX: toGateX, offsetY: toGateY, distance: playerDistance } = nearestPlayerOffset(gate, context);
    if (!gate.closing && playerDistance < context.safeDistance + gate.radius) this.beginClosing(gate);
    gate.laneSeconds = inAnyAimLane(gate, gate.radius, context) ? gate.laneSeconds + deltaSeconds : 0;
    if (!gate.closing && gate.laneSeconds >= AIM_LANE_CLOSE_SECONDS) this.beginClosing(gate);
    if (!gate.closing && context.view && this.farFromView(gate, context.view)) this.beginClosing(gate);
    let { driftX, driftY } = gate;
    if (playerDistance > 0 && playerDistance < context.safeDistance + gate.radius + DRIFT_AVOID_MARGIN) {
      driftX = toGateX / playerDistance;
      driftY = toGateY / playerDistance;
    }
    const speed = this.schedule.driftSpeed * deltaSeconds;
    const inset = WALL_INSET + gate.radius;
    const { minX, minY, maxX, maxY } = context.bounds ?? WORLD_BOUNDS;
    gate.x += driftX * speed;
    gate.y += driftY * speed;
    if (gate.x < minX + inset || gate.x > maxX - inset) gate.driftX = -gate.driftX;
    if (gate.y < minY + inset || gate.y > maxY - inset) gate.driftY = -gate.driftY;
    gate.x = clamp(gate.x, minX + inset, maxX - inset);
    gate.y = clamp(gate.y, minY + inset, maxY - inset);
  }

  farFromView(gate, { centerX, centerY, width, height }) {
    return Math.hypot(gate.x - centerX, gate.y - centerY) > FAR_CLOSE_HALF_DIAGONALS * Math.hypot(width, height) / 2;
  }

  // A closing gate fades out over GATE_FADE_SECONDS from now (or what is left of its lifetime).
  beginClosing(gate) {
    gate.closing = true;
    gate.lifetime = Math.min(gate.lifetime, gate.age + GATE_FADE_SECONDS);
  }

  envelope(gate) {
    const opening = clamp(gate.age / GATE_FADE_SECONDS, 0, 1);
    const closing = gate.closing ? clamp((gate.lifetime - gate.age) / GATE_FADE_SECONDS, 0, 1) : 1;
    return Math.min(opening, closing);
  }

  openGate(context, { age, lifetime }) {
    const position = this.placeGate(context);
    const angle = this.random() * Math.PI * 2;
    return {
      x: position.x,
      y: position.y,
      radius: this.schedule.gateRadius,
      species: this.pickSpecies(context.shares),
      age,
      lifetime,
      closing: false,
      laneSeconds: 0,
      driftX: Math.cos(angle),
      driftY: Math.sin(angle),
      open: 0,
      emit: 0,
      telegraph: 0,
    };
  }

  // With a view, the best of PLACEMENT_CANDIDATES draws on the view ring that lie inside the bounds
  // (see the header); without one, or when no ring draw lies inside, the best of as many wall band
  // or interior draws. Placeable draws (outside the safe radius plus the gate radius) beat
  // unplaceable ones; among them far from the player and apart from the other gates scores
  // higher. With no placeable draw the farthest one wins.
  placeGate(context) {
    const { bounds = WORLD_BOUNDS, view = null } = context;
    const inset = WALL_INSET + this.schedule.gateRadius;
    const ring = view === null ? null : this.bestPlacement(context, () => this.ringPoint(view, inset, bounds));
    return ring ?? this.bestPlacement(context, () => (this.random() < WALL_BAND_CHANCE ? this.wallBandPoint(inset, bounds) : {
      x: bounds.minX + inset + this.random() * (bounds.maxX - bounds.minX - 2 * inset),
      y: bounds.minY + inset + this.random() * (bounds.maxY - bounds.minY - 2 * inset),
    }));
  }

  // A uniform-angle point on the view ring, or null when it falls outside bounds less inset.
  ringPoint({ centerX, centerY, width, height }, inset, { minX, minY, maxX, maxY }) {
    const halfDiagonal = Math.hypot(width, height) / 2;
    const angle = this.random() * Math.PI * 2;
    const reach = halfDiagonal * (RING_INNER_HALF_DIAGONALS + this.random() * (RING_OUTER_HALF_DIAGONALS - RING_INNER_HALF_DIAGONALS));
    const x = centerX + Math.cos(angle) * reach;
    const y = centerY + Math.sin(angle) * reach;
    if (x < minX + inset || x > maxX - inset || y < minY + inset || y > maxY - inset) return null;
    return { x, y };
  }

  // The best scoring of the first PLACEMENT_CANDIDATES draws that are not null, out of at most
  // PLACEMENT_DRAW_ATTEMPTS draws (a view in a world corner leaves about a quarter of the ring
  // inside the world), or null for none.
  bestPlacement(context, draw) {
    const { safeDistance } = context;
    let best = null;
    let bestScore = -Infinity;
    let candidates = 0;
    for (let attempt = 0; attempt < PLACEMENT_DRAW_ATTEMPTS && candidates < PLACEMENT_CANDIDATES; attempt += 1) {
      const point = draw();
      if (point === null) continue;
      candidates += 1;
      const playerDistance = nearestPlayerOffset(point, context).distance;
      const spacing = this.gates.reduce((nearest, gate) => Math.min(nearest, Math.hypot(point.x - gate.x, point.y - gate.y)), PREFERRED_GATE_SPACING);
      const placeable = playerDistance >= safeDistance + this.schedule.gateRadius;
      const laneCost = inAnyAimLane(point, this.schedule.gateRadius, context) ? AIM_LANE_PENALTY : 0;
      const score = (placeable ? 1000 : 0) - laneCost + playerDistance * PLACEMENT_DISTANCE_WEIGHT + spacing + this.random() * 2;
      if (score > bestScore) {
        best = point;
        bestScore = score;
      }
    }
    return best;
  }

  // A point in the band of depth WALL_BAND_DEPTH inside the inset along a wall of bounds; the band
  // never passes the middle of the bounds' shorter side.
  wallBandPoint(inset, { minX, minY, maxX, maxY } = WORLD_BOUNDS) {
    const width = maxX - minX;
    const height = maxY - minY;
    const depth = Math.max(0, Math.min(WALL_BAND_DEPTH, Math.min(width, height) / 2 - inset));
    const along = this.random();
    const inward = inset + this.random() * depth;
    switch (Math.floor(this.random() * 4)) {
      case 0: return { x: minX + inset + along * (width - 2 * inset), y: minY + inward };
      case 1: return { x: minX + inset + along * (width - 2 * inset), y: maxY - inward };
      case 2: return { x: minX + inward, y: minY + inset + along * (height - 2 * inset) };
      default: return { x: maxX - inward, y: minY + inset + along * (height - 2 * inset) };
    }
  }

  // A species drawn by shares (all zero or missing means equal).
  pickSpecies(shares) {
    const weights = Array.from({ length: SPECIES_COUNT }, (unused, species) => Math.max(0, shares[species] ?? 0));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (total <= 0) return Math.min(SPECIES_COUNT - 1, Math.floor(this.random() * SPECIES_COUNT));
    let remaining = this.random() * total;
    for (let species = 0; species < SPECIES_COUNT; species += 1) {
      remaining -= weights[species];
      if (remaining < 0) return species;
    }
    return SPECIES_COUNT - 1;
  }
}
