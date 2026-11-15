// Versus (stage 2) match state, pure: the game modes, the pickup rotation versus plays with, and the
// match result. Two seats fight in the neutral swarm; a seat that loses its last ship is out (no
// down and revive) and the other seat wins; both wiped in one judgement is a draw. The game-side
// work that feeds it lives in versus-seats.js.
import { PICKUP_TYPE_NAMES } from './weaponTypes.js';

// Hives (stage 3, hives.js) is versus plus three capturable hives; everything versus does applies.
export const GameMode = Object.freeze({ Coop: 'coop', Versus: 'versus', Hives: 'hives' });
const MODES = new Set(Object.values(GameMode));

// Throws RangeError unless mode is a GameMode value.
export function validatedMode(mode) {
  if (!MODES.has(mode)) throw new RangeError(`game mode must be one of ${[...MODES].join(', ')}, got ${mode}`);
  return mode;
}

// The time warp slows both players' world at once, so versus leaves it out of the rotation.
export const VERSUS_PICKUP_ROTATION = Object.freeze(PICKUP_TYPE_NAMES.filter((type) => type !== 'timewarp'));

export class VersusMatch {
  // hives: the match's Hives (hives.js) in hives mode, else null (plain versus).
  constructor({ hives = null } = {}) {
    this.hives = hives;
    this.reset();
  }

  reset() {
    // null while the match runs; then { winner: seat index, draw: false } or { winner: null, draw: true },
    // with hives: true for a hives hold win.
    this.result = null;
    this.hives?.reset();
  }

  get over() {
    return this.result !== null;
  }

  // aliveCounts: each seat's ships alive after the losses just applied. Returns the result when this
  // call ends the match (a seat or both at 0), else null; once over it returns null.
  judge(aliveCounts) {
    if (this.result !== null) return null;
    const wiped = aliveCounts.map((count) => count === 0);
    if (!wiped.some(Boolean)) return null;
    this.result = wiped.every(Boolean) ? { winner: null, draw: true } : { winner: wiped.indexOf(false), draw: false };
    return this.result;
  }

  // Ends a running match with winner (a seat) for holding every hive; returns the result, or null
  // once over.
  awardHold(winner) {
    if (this.result !== null) return null;
    this.result = { winner, draw: false, hives: true };
    return this.result;
  }
}

// The game over title for a match result: PLAYER n WINS, or DRAW.
export function matchResultText(result) {
  if (result === null) return null;
  return result.draw ? 'DRAW' : `PLAYER ${result.winner + 1} WINS`;
}
