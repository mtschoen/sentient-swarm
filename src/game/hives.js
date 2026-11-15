// Hives (stage 3) match state, pure: three persistent hives in the world, their capture by the
// seats' ships, the all-hives hold that wins the match, and the feeding ground growth credit. Time
// is the deltaSeconds each update is given; nothing reads a clock. The game-side work that feeds it
// lives in hive-seats.js; the numbers live in hive-tuning.js.
//
// Capture: each update a hive counts each seat's live ships inside its disc. The seat with more
// ships there has an advantage of the difference; its progress grows by advantage times
// captureRatePerShip per second, at most maximumCaptureRate. Progress belongs to one capturer at a
// time: a seat with the advantage first unwinds the other seat's progress, then builds its own,
// and on reaching 1 it owns the hive (from neutral, or taken from the other seat the same way). The
// owner with the advantage unwinds an attempt on its hive. Equal ships (both present) freeze the
// progress; no ships at all let it decay by decayRate per second.
// Owned hives aim the horde: hiveTarget maps an owner to the seat its hive's agents seek, the
// other one. Holding every hive for holdSecondsToWin wins (HiveHold).
import { HIVE_TUNING } from './hive-tuning.js';

export const HIVE_COUNT = 3;
// The hive sites in bounds ({ minX, minY, maxX, maxY }) for seats starting startOffset either side of
// the center on x (VERSUS_START_OFFSET): [{ x, y, radius }], seat 1's hive (sideOffset above seat 1's
// start on screen, smaller y), seat 2's hive (sideOffset below seat 2's) and the contested one at the center. The
// layout is point-symmetric about the center, so neither seat's side is favored, and every site is
// at least sideOffset from both starts.
export function hiveSites(bounds, startOffset, { radius = HIVE_TUNING.radius, sideOffset = HIVE_TUNING.sideOffset } = {}) {
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return [
    { x: centerX - startOffset, y: centerY - sideOffset, radius },
    { x: centerX + startOffset, y: centerY + sideOffset, radius },
    { x: centerX, y: centerY, radius },
  ];
}

// The seat whose seek point an owned hive's agents seek: the owner's opponent; null for neutral.
export function hiveTarget(owner) {
  return owner === null ? null : 1 - owner;
}

// Live ships of a swarm ({ x, y, alive } per slot) inside the disc of hive.
export function shipsInDisc(ships, hive) {
  const reach = hive.radius * hive.radius;
  let count = 0;
  for (const ship of ships) {
    if (!ship.alive) continue;
    const offsetX = ship.x - hive.x;
    const offsetY = ship.y - hive.y;
    if (offsetX * offsetX + offsetY * offsetY <= reach) count += 1;
  }
  return count;
}

export class Hive {
  constructor({ x, y, radius }) {
    this.x = x;
    this.y = y;
    this.radius = radius;
    this.reset();
  }

  reset() {
    // The seat that owns the hive, or null while neutral.
    this.owner = null;
    // The seat whose capture progress (0 to 1) is building, or null when progress is 0.
    this.capturer = null;
    this.progress = 0;
  }
}

// One capture update of hive with present = [seat 1 ships in the disc, seat 2 ships]. Returns the
// seat that took the hive in this update, or null.
export function captureStep(hive, present, deltaSeconds, tuning = HIVE_TUNING) {
  const [first, second] = present;
  if (first === 0 && second === 0) {
    unwind(hive, tuning.decayRate * deltaSeconds);
    return null;
  }
  const advantage = first - second;
  if (advantage === 0) return null;
  const seat = advantage > 0 ? 0 : 1;
  let amount = Math.min(tuning.maximumCaptureRate, Math.abs(advantage) * tuning.captureRatePerShip) * deltaSeconds;
  if (hive.capturer !== null && hive.capturer !== seat) amount = unwind(hive, amount);
  if (hive.owner === seat || amount <= 0) return null;
  hive.capturer = seat;
  hive.progress += amount;
  if (hive.progress < 1) return null;
  hive.owner = seat;
  hive.capturer = null;
  hive.progress = 0;
  return seat;
}

// Takes up to amount off the hive's progress (clearing the capturer at 0); returns what is left over.
function unwind(hive, amount) {
  const taken = Math.min(amount, hive.progress);
  hive.progress -= taken;
  if (hive.progress <= 0) {
    hive.progress = 0;
    hive.capturer = null;
  }
  return amount - taken;
}

// The all-hives hold: the seat owning every hive, and for how long it has.
export class HiveHold {
  constructor(tuning = HIVE_TUNING) {
    this.holdSecondsToWin = tuning.holdSecondsToWin;
    this.reset();
  }

  reset() {
    this.holder = null;
    this.seconds = 0;
  }

  // owners: each hive's owner (a seat or null). A new holder starts from 0; returns the holder once
  // it has held for holdSecondsToWin, else null.
  update(owners, deltaSeconds) {
    const holder = owners.length > 0 && owners.every((owner) => owner !== null && owner === owners[0]) ? owners[0] : null;
    if (holder !== this.holder) {
      this.holder = holder;
      this.seconds = 0;
    }
    if (holder === null) return null;
    this.seconds += deltaSeconds;
    return this.seconds >= this.holdSecondsToWin ? holder : null;
  }

  // Seconds the holder still needs, or null without a holder.
  get remainingSeconds() {
    return this.holder === null ? null : Math.max(0, this.holdSecondsToWin - this.seconds);
  }
}

// The hives of one match and their hold.
export class Hives {
  // sites: hiveSites for the match's bounds and seat starts.
  constructor(sites, tuning = HIVE_TUNING) {
    this.tuning = tuning;
    this.hives = sites.map((site) => new Hive(site));
    this.hold = new HiveHold(tuning);
  }

  reset() {
    this.hives.forEach((hive) => hive.reset());
    this.hold.reset();
  }

  get owners() {
    return this.hives.map((hive) => hive.owner);
  }

  // swarms: each seat's ships ({ x, y, alive } per slot). Returns { captured: [{ hive, seat }] for
  // hives taken in this update, winner: the seat whose hold just won, or null }.
  update(swarms, deltaSeconds) {
    const captured = [];
    this.hives.forEach((hive, index) => {
      const seat = captureStep(hive, swarms.map((ships) => shipsInDisc(ships, hive)), deltaSeconds, this.tuning);
      if (seat !== null) captured.push({ hive: index, seat });
    });
    return { captured, winner: this.hold.update(this.owners, deltaSeconds) };
  }

  // What the HUD shows: each hive's owner, capturer and progress, and the hold.
  get view() {
    return {
      hives: this.hives.map(({ owner, capturer, progress }) => ({ owner, capturer, progress })),
      holder: this.hold.holder,
      holdRemainingSeconds: this.hold.remainingSeconds,
      holdSecondsToWin: this.hold.holdSecondsToWin,
    };
  }
}

// A seat's swarm growth from a stats frame: its owned kills, with the feeding ground ones (a subset)
// counted feedingGrowthMultiplier times in all.
export function feedingGrowth(ownerKills, feedingKills, tuning = HIVE_TUNING) {
  return ownerKills + feedingKills * (tuning.feedingGrowthMultiplier - 1);
}
