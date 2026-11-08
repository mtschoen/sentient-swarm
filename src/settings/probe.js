// Watches frame times during real play and suggests a preset step.
// Time is injected (nowSeconds); the probe never reads a clock.
export class FrameTimeProbe {
  constructor({
    targetMilliseconds = 10,
    warmupFrames = 120,
    windowFrames = 180,
    minimumSecondsBetweenSteps = 3,
    downRatio = 1.35,
    upRatio = 0.6,
  } = {}) {
    this.targetMilliseconds = targetMilliseconds;
    this.warmupFrames = warmupFrames;
    this.windowFrames = windowFrames;
    this.minimumSecondsBetweenSteps = minimumSecondsBetweenSteps;
    this.downRatio = downRatio;
    this.upRatio = upRatio;
    this.reset();
  }

  reset() {
    this.framesSeen = 0;
    this.window = [];
    this.lastStepSeconds = -Infinity;
  }

  recordFrame(frameMilliseconds, nowSeconds) {
    this.framesSeen += 1;
    if (this.framesSeen <= this.warmupFrames) {
      return null;
    }
    this.window.push(frameMilliseconds);
    if (this.window.length > this.windowFrames) {
      this.window.shift();
    }
    if (this.window.length < this.windowFrames) {
      return null;
    }
    if (nowSeconds - this.lastStepSeconds < this.minimumSecondsBetweenSteps) {
      return null;
    }
    const percentile = this.percentile90();
    let decision = null;
    if (percentile > this.targetMilliseconds * this.downRatio) {
      decision = 'down';
    } else if (percentile < this.targetMilliseconds * this.upRatio) {
      decision = 'up';
    }
    if (decision !== null) {
      this.lastStepSeconds = nowSeconds;
      this.window = [];
    }
    return decision;
  }

  percentile90() {
    const sorted = [...this.window].sort((first, second) => first - second);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)];
  }
}
