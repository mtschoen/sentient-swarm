// Time warp (owner ruling R31): a pickup that slows the swarm. start() begins a warp of
// durationSeconds of real time, or extends a running one by another full duration (the HUD bar
// refills; no new ramp in). update(realDeltaSeconds) counts real time. scale is the simulation's
// speed: it eases from 1 to targetScale over rampSeconds (smoothstep) after the start and back to 1
// over the last rampSeconds, so there is no jolt; strength is the same ease from 0 to 1, for the
// tint and the music. end() stops a warp at once (death, a new run, quit to title).
export const TIME_WARP_SECONDS = 6;
export const TIME_WARP_SCALE = 0.3;
export const TIME_WARP_RAMP_SECONDS = 0.35;

function smoothstep(edge, value) {
  const fraction = Math.min(1, Math.max(0, value / edge));
  return fraction * fraction * (3 - 2 * fraction);
}

export class TimeWarp {
  constructor({ durationSeconds = TIME_WARP_SECONDS, scale = TIME_WARP_SCALE, rampSeconds = TIME_WARP_RAMP_SECONDS } = {}) {
    this.durationSeconds = durationSeconds;
    this.targetScale = scale;
    this.rampSeconds = rampSeconds;
    this.end();
  }

  // Seconds of real time; throws RangeError unless above 0.
  setDuration(seconds) {
    if (!(Number.isFinite(seconds) && seconds > 0)) throw new RangeError(`time warp seconds must be above 0, got ${seconds}`);
    this.durationSeconds = seconds;
  }

  // The simulation speed in the middle of a warp; throws RangeError outside (0, 1].
  setScale(scale) {
    if (!(Number.isFinite(scale) && scale > 0 && scale <= 1)) throw new RangeError(`time warp scale must lie in (0, 1], got ${scale}`);
    this.targetScale = scale;
  }

  start() {
    if (!this.active) this.elapsedSeconds = 0;
    this.remainingSeconds += this.durationSeconds;
    this.totalSeconds = this.remainingSeconds;
  }

  end() {
    this.remainingSeconds = 0;
    this.totalSeconds = 0;
    this.elapsedSeconds = 0;
  }

  update(realDeltaSeconds) {
    if (!this.active) return;
    this.elapsedSeconds += realDeltaSeconds;
    // Float residue below a microsecond counts as over, so a warp ends on its last frame.
    this.remainingSeconds = Math.max(0, this.remainingSeconds - realDeltaSeconds);
    if (this.remainingSeconds < 1e-6) this.end();
  }

  get active() {
    return this.remainingSeconds > 0;
  }

  // 0 (no warp) to 1 (full warp), eased in and out.
  get strength() {
    if (!this.active) return 0;
    return Math.min(smoothstep(this.rampSeconds, this.elapsedSeconds), smoothstep(this.rampSeconds, this.remainingSeconds));
  }

  get scale() {
    const strength = this.strength;
    return strength === 1 ? this.targetScale : 1 + (this.targetScale - 1) * strength;
  }

  // The share of the warp left, for the HUD bar (1 just after a start or an extension).
  get fraction() {
    return this.totalSeconds > 0 ? this.remainingSeconds / this.totalSeconds : 0;
  }
}
