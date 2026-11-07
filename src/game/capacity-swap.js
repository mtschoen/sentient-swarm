// Capacity change coordinator. From request() until the new simulation is installed,
// simulationPaused is true and the game freezes (Game.update returns early, so input, run timers,
// invulnerability and pickups all wait; render keeps drawing the last state), so
// recreateWithCapacity copies the final state and no step is lost to the instance being
// replaced. One change at a time: a request while one is pending, or for the current capacity,
// is ignored and resolves false. A rejected recreate leaves
// the old simulation installed, clears the pause and rethrows for the UI to show.
export class CapacitySwap {
  // getCapacity() returns the installed capacity; recreate(capacity) resolves with the new
  // simulation; install(simulation) swaps it in synchronously.
  constructor({ getCapacity, recreate, install }) {
    this.getCapacity = getCapacity;
    this.recreate = recreate;
    this.install = install;
    this.pending = false;
  }

  get simulationPaused() {
    return this.pending;
  }

  async request(capacity) {
    if (this.pending || capacity === this.getCapacity()) return false;
    this.pending = true;
    try {
      const next = await this.recreate(capacity);
      this.install(next);
      return true;
    } finally {
      this.pending = false;
    }
  }
}
