// Music intensity (0..1) from how the run is going, the one source the music follows:
//   intensity = clamp(0.2 + 0.35 * survival + 0.25 * streak + 0.2 * killRate, 0, 1)
//   survival = min(1, survivalSeconds / SURVIVAL_RAMP_SECONDS): seconds spent Playing this run; a
//     death halves it (onDeath) and a new run sets it to 0 (reset), so the build survives a death.
//   streak = log(multiplier) / log(10): 0 at x1, 0.3 at x2, 0.6 at x4, 1 at the top step x10.
//   killRate = rate / (rate + KILL_RATE_HALF_POINT), where rate is an exponential moving average
//     (time constant KILL_RATE_SECONDS) of kills per second in reference-capacity kills (each kill
//     counts REFERENCE_CAPACITY / capacity, as the score does), so the build does not depend on
//     the quality preset.
// Not alive density: the arena is full from the first second, so it never built during real play.
// A weak player (alive 30 s, x2, 3 kills a second) is past 0.5 at 30 s: the lead and the busier
// hats are in, and the tempo is up three beats per minute.
import { REFERENCE_CAPACITY } from '../game/score.js';

export const INTENSITY_FLOOR = 0.2;
const SURVIVAL_WEIGHT = 0.35;
const STREAK_WEIGHT = 0.25;
const KILL_RATE_WEIGHT = 0.2;
const SURVIVAL_RAMP_SECONDS = 45;
const KILL_RATE_SECONDS = 2;
const KILL_RATE_HALF_POINT = 10;
const TOP_MULTIPLIER = 10;

export class IntensityTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.survivalSeconds = 0;
    this.killRate = 0;
    this.intensity = INTENSITY_FLOOR;
  }

  onDeath() {
    this.survivalSeconds /= 2;
  }

  // killsThisFrame counts only while playing.
  update({ fixedStep, playing, multiplier = 1, killsThisFrame = 0, capacity = REFERENCE_CAPACITY }) {
    if (!(fixedStep > 0)) return this.intensity;
    const kills = playing && capacity > 0 ? killsThisFrame * REFERENCE_CAPACITY / capacity : 0;
    const blend = 1 - Math.exp(-fixedStep / KILL_RATE_SECONDS);
    this.killRate += (kills / fixedStep - this.killRate) * blend;
    if (this.killRate < 1e-6) this.killRate = 0;
    if (playing) this.survivalSeconds += fixedStep;
    const survival = Math.min(1, this.survivalSeconds / SURVIVAL_RAMP_SECONDS);
    const streak = playing ? Math.min(1, Math.max(0, Math.log(multiplier) / Math.log(TOP_MULTIPLIER))) : 0;
    const killRate = this.killRate / (this.killRate + KILL_RATE_HALF_POINT);
    const raw = INTENSITY_FLOOR + SURVIVAL_WEIGHT * survival + STREAK_WEIGHT * streak + KILL_RATE_WEIGHT * killRate;
    this.intensity = Math.min(1, Math.max(0, raw));
    return this.intensity;
  }
}
