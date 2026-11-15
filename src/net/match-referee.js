// The host's match referee for an online match: each machine reports its own seat's wipe (the
// guest's report converted to host match time), and the host decides. A seat wiped alone loses once
// the draw window and the half round trip have passed with no wipe of the other seat (a later report
// could still make it a draw); both seats wiped within the window is a draw, further apart the
// later-wiped seat wins. A result is returned once; reset starts a new match.

import { DRAW_WINDOW_SECONDS } from './protocol.js';

export class MatchReferee {
  #wipes = [null, null];
  #decided = false;

  constructor({ drawWindowSeconds = DRAW_WINDOW_SECONDS } = {}) {
    this.drawWindowSeconds = drawWindowSeconds;
  }

  // Seat's swarm was wiped at hostMatchSeconds; a seat's first report counts.
  reportWipe(seat, hostMatchSeconds) {
    if (this.#wipes[seat] === null) this.#wipes[seat] = hostMatchSeconds;
  }

  // The match result once it is decided ({ winner, draw, hives: false }), else null; null again after.
  decide(hostMatchSeconds, latencySeconds) {
    if (this.#decided) return null;
    const [first, second] = this.#wipes;
    if (first === null && second === null) return null;
    if (first !== null && second !== null) {
      if (Math.abs(first - second) <= this.drawWindowSeconds) return this.#decide(null);
      return this.#decide(first > second ? 0 : 1);
    }
    const wiped = first === null ? 1 : 0;
    const firstWipe = this.#wipes[wiped];
    // The exact form matters at the boundary (see the referee tests).
    if (hostMatchSeconds >= firstWipe + this.drawWindowSeconds + latencySeconds) return this.#decide(1 - wiped);
    return null;
  }

  reset() {
    this.#wipes = [null, null];
    this.#decided = false;
  }

  #decide(winner) {
    this.#decided = true;
    return winner === null ? { winner: null, draw: true, hives: false } : { winner, draw: false, hives: false };
  }
}
