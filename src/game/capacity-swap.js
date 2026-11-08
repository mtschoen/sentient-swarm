// Capacity change coordinator. A change is { capacity, neighborRadius?, particleCapacity? }.
// request() first awaits prepare(change), the slow part (buffer allocation and pipeline
// creation), while the game keeps stepping the old simulation, so play never freezes for it. Then
// commit(prepared), which is synchronous (it queues the copy of the newest state on the GPU and
// returns the new simulation), and install(next) run back to back in one task, between two
// frames: no step sees a destroyed simulation and no step is lost. One change at a time: a
// request while one is pending, or one matching the installed configuration, is ignored and
// resolves false. A rejected prepare (or a throwing commit, after discard(prepared)) leaves the
// old simulation installed and rethrows for the UI to show. A request older than
// timeoutMilliseconds (by now(), a monotonic millisecond source, not the game clock, which stalls
// while paused) is ended by expire(), which Game.render polls every frame: pending clears and the
// request rejects with an Error named CapacitySwapTimeout. A prepare that resolves after that is
// discarded, never committed or installed; one that rejects after that is ignored.
export class CapacitySwap {
  // getConfiguration() returns the installed { capacity, neighborRadius, particleCapacity };
  // prepare(change) resolves with a prepared change; commit(prepared) returns the new simulation;
  // install(simulation) swaps it in synchronously; discard(prepared) releases an uncommitted one.
  constructor({ getConfiguration, prepare, commit, install, discard = () => {}, now = () => performance.now(), timeoutMilliseconds = 10000 }) {
    this.getConfiguration = getConfiguration;
    this.prepare = prepare;
    this.commit = commit;
    this.install = install;
    this.discard = discard;
    this.now = now;
    this.timeoutMilliseconds = timeoutMilliseconds;
    this.pendingValue = false;
    // The request in flight: { requestedAt, expired, rejectTimeout }, or null.
    this.attempt = null;
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
    const attempt = { requestedAt: this.now(), expired: false, rejectTimeout: null };
    this.attempt = attempt;
    const timedOut = new Promise((resolve, reject) => { attempt.rejectTimeout = reject; });
    try {
      return await Promise.race([this.run(change, attempt), timedOut]);
    } finally {
      if (this.attempt === attempt) {
        this.attempt = null;
        this.pendingValue = false;
      }
    }
  }

  // Ends the request in flight once it is older than timeoutMilliseconds. Returns true if it did.
  expire() {
    const attempt = this.attempt;
    if (attempt === null || this.now() - attempt.requestedAt <= this.timeoutMilliseconds) return false;
    attempt.expired = true;
    this.attempt = null;
    this.pendingValue = false;
    const error = new Error(`Capacity swap did not settle within ${this.timeoutMilliseconds} ms`);
    error.name = 'CapacitySwapTimeout';
    attempt.rejectTimeout(error);
    return true;
  }

  // prepare runs synchronously from request; a result arriving after expiry is only discarded.
  async run(change, attempt) {
    const prepared = await this.prepare(change);
    if (attempt.expired) {
      this.discard(prepared);
      return false;
    }
    let next;
    try {
      next = this.commit(prepared);
    } catch (error) {
      this.discard(prepared);
      throw error;
    }
    this.install(next);
    return true;
  }
}
