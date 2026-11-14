// Press to join: the pure edge-triggered logic that gives seat 2 a pad at the title (and takes it back).
// Standard buttons 4 to 7 are the shoulders and triggers; a first pad's face buttons already start the solo run.
export const JOIN_BUTTON_INDICES = Object.freeze([4, 5, 6, 7]);
export const SECOND_PAD_JOIN_BUTTON_INDICES = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7]);

export class SeatJoin {
  constructor() {
    this.seatTwoPad = null;
    this.previousHeld = new Map();
    this.primed = false;
    this.wasOpen = false;
  }

  get joined() {
    return this.seatTwoPad !== null;
  }

  // The held join buttons of every connected pad, keyed by Gamepad.index (the list may have null holes).
  snapshot(gamepads) {
    const held = new Map();
    for (const gamepad of gamepads) {
      if (!gamepad) continue;
      held.set(gamepad.index, new Set(SECOND_PAD_JOIN_BUTTON_INDICES.filter((index) => gamepad.buttons?.[index]?.pressed)));
    }
    return held;
  }

  poll(gamepads, { open }) {
    const now = this.snapshot(gamepads);
    const previous = this.previousHeld;
    const prime = !this.primed || (open && !this.wasOpen);
    this.previousHeld = now;
    this.primed = true;
    this.wasOpen = open;
    if (prime || !open) return null;
    const firstPad = gamepads.find((gamepad) => gamepad && gamepad.index !== this.seatTwoPad) ?? null;
    for (const gamepad of gamepads) {
      if (!gamepad) continue;
      const held = now.get(gamepad.index);
      const before = previous.get(gamepad.index) ?? new Set();
      const fresh = (indices) => indices.some((index) => held.has(index) && !before.has(index));
      if (this.joined) {
        if (gamepad.index === this.seatTwoPad && fresh(JOIN_BUTTON_INDICES)) {
          this.seatTwoPad = null;
          return 'left';
        }
      } else if (fresh(gamepad === firstPad ? JOIN_BUTTON_INDICES : SECOND_PAD_JOIN_BUTTON_INDICES)) {
        this.seatTwoPad = gamepad.index;
        return 'joined';
      }
    }
    return null;
  }

  seatTwoConnected(gamepads) {
    return this.joined && gamepads.some((gamepad) => gamepad && gamepad.index === this.seatTwoPad);
  }

  // Seat 2's pad is gone and a pad connects under another index: it takes the seat.
  reconnect(padIndex, gamepads) {
    if (!this.joined || this.seatTwoConnected(gamepads)) return false;
    this.seatTwoPad = padIndex;
    return true;
  }

  reset() {
    this.seatTwoPad = null;
    this.primed = false;
    this.previousHeld = new Map();
    this.wasOpen = false;
  }
}
