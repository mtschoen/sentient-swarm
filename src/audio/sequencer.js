// Lookahead step sequencer: the caller passes the audio clock (context.currentTime) and a callback,
// and every step whose time falls before currentTime + lookaheadSeconds is scheduled exactly once,
// in order. Steps that are already in the past (a stalled tab, a long frame) are skipped rather than
// played late in a burst; the step index keeps counting, so the bar position survives the gap.
// scheduleIntervalSeconds is how often the owner should call update; it must stay below the
// lookahead so no step slips through.
//
// Step times are computed from an anchor (index, time) that moves only on a tempo change, so they
// sit exactly on the grid instead of accumulating rounding error step by step.
export class StepSequencer {
  constructor({ stepsPerBar = 16, lookaheadSeconds = 0.1, scheduleIntervalSeconds = 0.025 } = {}) {
    this.stepsPerBar = stepsPerBar;
    this.lookaheadSeconds = lookaheadSeconds;
    this.scheduleIntervalSeconds = scheduleIntervalSeconds;
    this.beatsPerMinute = 128;
    this.nextStepIndex = 0;
    this.anchorIndex = 0;
    this.anchorTime = null;
  }

  // Seconds per step; a bar is four beats, so a step is a sixteenth note at 16 steps per bar.
  get stepDuration() {
    return 60 / this.beatsPerMinute / (this.stepsPerBar / 4);
  }

  get nextStepTime() {
    if (this.anchorTime === null) return null;
    return this.anchorTime + (this.nextStepIndex - this.anchorIndex) * this.stepDuration;
  }

  setTempo(beatsPerMinute) {
    if (beatsPerMinute === this.beatsPerMinute) return;
    if (this.anchorTime !== null) {
      this.anchorTime = this.nextStepTime;
      this.anchorIndex = this.nextStepIndex;
    }
    this.beatsPerMinute = beatsPerMinute;
  }

  // Restarts from step 0 on the next update.
  reset() {
    this.nextStepIndex = 0;
    this.anchorIndex = 0;
    this.anchorTime = null;
  }

  update(currentTime, scheduleStep) {
    if (this.anchorTime === null) {
      this.anchorTime = currentTime;
      this.anchorIndex = this.nextStepIndex;
    }
    if (this.nextStepTime < currentTime) {
      this.nextStepIndex += Math.ceil((currentTime - this.nextStepTime) / this.stepDuration);
    }
    const horizon = currentTime + this.lookaheadSeconds;
    while (this.nextStepTime < horizon) {
      scheduleStep(this.nextStepIndex, this.nextStepTime);
      this.nextStepIndex += 1;
    }
  }
}
