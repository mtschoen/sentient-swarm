// Beam time: the timed beam window the last beam shard opens. It counts real time (the game calls
// update every unpaused update), so a pause keeps it. update returns true on the one call in which
// the timer ran out, so the caller can play the expiry cue once.
export const BEAM_TIME_SECONDS = 8;
export const BEAM_TIME_TIER = 1;

export class BeamTime {
  constructor({ durationSeconds = BEAM_TIME_SECONDS } = {}) {
    this.configuredSeconds = BEAM_TIME_SECONDS;
    this.setDuration(durationSeconds);
    this.end();
  }

  // Seconds of real time; throws RangeError unless finite and above 0.
  setDuration(seconds) {
    if (!(Number.isFinite(seconds) && seconds > 0)) throw new RangeError(`beam time seconds must be above 0, got ${seconds}`);
    this.configuredSeconds = seconds;
  }

  get durationSeconds() {
    return this.configuredSeconds;
  }

  // Begins a full window, also when one is already running.
  start() {
    this.remainingSeconds = this.configuredSeconds;
    this.totalSeconds = this.configuredSeconds;
  }

  end() {
    this.remainingSeconds = 0;
    this.totalSeconds = 0;
  }

  update(realDeltaSeconds) {
    if (!this.active) return false;
    // A non-finite or negative delta makes no progress, so the window can still end on a later call.
    if (!(Number.isFinite(realDeltaSeconds) && realDeltaSeconds > 0)) return false;
    this.remainingSeconds = Math.max(0, this.remainingSeconds - realDeltaSeconds);
    // Float residue below a microsecond counts as over, so the window ends on its last frame.
    if (this.remainingSeconds < 1e-6) {
      this.end();
      return true;
    }
    return false;
  }

  get active() {
    return this.remainingSeconds > 0;
  }

  // The share of the window left (1 just after a start, 0 when idle).
  get fraction() {
    return this.totalSeconds > 0 ? this.remainingSeconds / this.totalSeconds : 0;
  }
}
