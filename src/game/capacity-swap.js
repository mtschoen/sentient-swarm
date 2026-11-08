// Capacity change coordinator. A change is { capacity, neighborRadius?, particleCapacity? }.
// request() first awaits prepare(change), the slow part (buffer allocation and pipeline
// creation), while the game keeps stepping the old simulation, so play never freezes for it. Then
// commit(prepared), which is synchronous (it queues the copy of the newest state on the GPU and
// returns the new simulation), and install(next) run back to back in one task, between two
// frames: no step sees a destroyed simulation and no step is lost. One change at a time: a
// request while one is pending, or one matching the installed configuration, is ignored and
// resolves false. A rejected prepare (or a throwing commit, after discard(prepared)) leaves the
// old simulation installed and rethrows for the UI to show.
export class CapacitySwap {
  // getConfiguration() returns the installed { capacity, neighborRadius, particleCapacity };
  // prepare(change) resolves with a prepared change; commit(prepared) returns the new simulation;
  // install(simulation) swaps it in synchronously; discard(prepared) releases an uncommitted one.
  constructor({ getConfiguration, prepare, commit, install, discard = () => {} }) {
    this.getConfiguration = getConfiguration;
    this.prepare = prepare;
    this.commit = commit;
    this.install = install;
    this.discard = discard;
    this.pendingValue = false;
  }

  // True from a request until its change is installed or has failed.
  get pending() {
    return this.pendingValue;
  }

  matchesInstalled(change) {
    const installed = this.getConfiguration();
    return Object.entries(change).every(([key, value]) => value === undefined || installed[key] === value);
  }

  async request(change) {
    if (this.pendingValue || this.matchesInstalled(change)) return false;
    this.pendingValue = true;
    try {
      const prepared = await this.prepare(change);
      let next;
      try {
        next = this.commit(prepared);
      } catch (error) {
        this.discard(prepared);
        throw error;
      }
      this.install(next);
      return true;
    } finally {
      this.pendingValue = false;
    }
  }
}
