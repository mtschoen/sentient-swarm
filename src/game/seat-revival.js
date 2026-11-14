// Down and revive for the seats of a co-op run: a wiped seat is out until the survivors score
// REVIVE_KILLS more kills, then comes back with REVIVE_SHIPS ships REVIVE_OFFSET beside the first
// live seat's point. This class owns the counting; the seat's own `down` flag mirrors it and is set
// in exactly two places (seats.js: seatGoesDown sets both, reviveSeats clears both).

export const REVIVE_KILLS = 100;
export const REVIVE_SHIPS = 12;
export const REVIVE_OFFSET = 0.6;
export const REVIVE_INVULNERABLE_SECONDS = 2;

export class SeatRevival {
  constructor({ seatCount }) {
    // Kills since the seat went down, or null while it is up.
    this.counts = new Array(seatCount).fill(null);
  }

  // The seat went down: its count restarts at 0.
  down(seatIndex) {
    this.counts[seatIndex] = 0;
  }

  isDown(seatIndex) {
    return this.counts[seatIndex] !== null;
  }

  // Adds scored kills to every down seat; returns the seat indices that reached REVIVE_KILLS with this
  // call (they are up again).
  addKills(count) {
    const revived = [];
    this.counts.forEach((kills, index) => {
      if (kills === null) return;
      if (kills + count >= REVIVE_KILLS) {
        this.counts[index] = null;
        revived.push(index);
      } else this.counts[index] = kills + count;
    });
    return revived;
  }

  progress(seatIndex) {
    return { kills: this.counts[seatIndex] ?? 0, needed: REVIVE_KILLS };
  }

  reset() {
    this.counts.fill(null);
  }
}

// Beside the survivor on x (the other side at a wall), clamped inside the bounds by the point's radius.
export function revivePoint(survivor, bounds, radius) {
  const maximumX = bounds.maxX - radius;
  const minimumX = bounds.minX + radius;
  const right = survivor.x + REVIVE_OFFSET;
  const x = right > maximumX ? survivor.x - REVIVE_OFFSET : right;
  return {
    x: Math.min(maximumX, Math.max(minimumX, x)),
    y: Math.min(bounds.maxY - radius, Math.max(bounds.minY + radius, survivor.y)),
  };
}
