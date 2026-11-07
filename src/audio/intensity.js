// Music intensity from what the swarm demo has: how full the arena is and whether kills just
// happened. A kill frame sets the pulse to 1; it then falls linearly to 0 over pulseDecaySeconds.
// intensity = clamp(0.2 + 0.4 * aliveFraction + 0.4 * killPulse, 0, 1).
export class IntensityTracker {
  constructor({ pulseDecaySeconds = 1 } = {}) {
    this.pulseDecaySeconds = pulseDecaySeconds;
    this.killPulse = 0;
    this.intensity = 0.2;
  }

  update({ fixedStep, aliveTotal, capacity, killsThisFrame }) {
    if (killsThisFrame > 0) this.killPulse = 1;
    else this.killPulse = Math.max(0, this.killPulse - fixedStep / this.pulseDecaySeconds);
    // Rounding guards the decay against accumulating float error that would leave a tiny residue.
    if (this.killPulse < 1e-9) this.killPulse = 0;
    const aliveFraction = capacity > 0 ? Math.min(1, aliveTotal / capacity) : 0;
    this.intensity = Math.min(1, Math.max(0, 0.2 + 0.4 * aliveFraction + 0.4 * this.killPulse));
    return this.intensity;
  }
}
