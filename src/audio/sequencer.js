// Lookahead step sequencer: the caller passes the audio clock (context.currentTime) and a callback,
// and every step whose time falls before currentTime + lookaheadSeconds is scheduled exactly once,
// in order. Steps that are already in the past (a stalled tab, a long frame) are skipped rather than
// played late in a burst; the step index keeps counting, so the bar position survives the gap.
// scheduleIntervalSeconds is how often the owner should call update; it must stay below the
// lookahead so no step slips through.
//
// The first step sits one lookahead after the first update, so it is never already late. Tempo
// changes take effect at the next bar start (the first one applies at once), so a tempo that moves
// every frame does not smear the groove; setTempo(bpm, { quantumSteps: 4 }) lands on the next beat
// instead (the time warp's slowdown), and a pending change keeps the shortest quantum asked for.
// Step times come from an anchor (index, time) that moves only when the tempo changes, so they sit
// exactly on the grid without accumulating rounding error.
export class StepSequencer {
  constructor({ stepsPerBar = 16, lookaheadSeconds = 0.1, scheduleIntervalSeconds = 0.025 } = {}) {
    this.stepsPerBar = stepsPerBar;
    this.lookaheadSeconds = lookaheadSeconds;
    this.scheduleIntervalSeconds = scheduleIntervalSeconds;
    this.beatsPerMinute = 128;
    this.pendingBeatsPerMinute = null;
    this.pendingQuantumSteps = stepsPerBar;
    this.nextStepIndex = 0;
    this.anchorIndex = 0;
    this.anchorTime = null;
  }

  // Seconds per step; a bar is four beats, so a step is a sixteenth note at 16 steps per bar.
  get stepDuration() {
    return 60 / this.beatsPerMinute / (this.stepsPerBar / 4);
  }

  // The tempo the sequencer is heading for: the pending one, or the current one.
  get targetBeatsPerMinute() {
    return this.pendingBeatsPerMinute ?? this.beatsPerMinute;
  }

  get nextStepTime() {
    if (this.anchorTime === null) return null;
    return this.anchorTime + (this.nextStepIndex - this.anchorIndex) * this.stepDuration;
  }

  setTempo(beatsPerMinute, { quantumSteps = this.stepsPerBar } = {}) {
    if (this.anchorTime === null) {
      this.beatsPerMinute = beatsPerMinute;
      this.pendingBeatsPerMinute = null;
    } else if (beatsPerMinute === this.beatsPerMinute) {
      this.pendingBeatsPerMinute = null;
    } else {
      if (this.pendingBeatsPerMinute === null) this.pendingQuantumSteps = quantumSteps;
      else this.pendingQuantumSteps = Math.min(this.pendingQuantumSteps, quantumSteps);
      this.pendingBeatsPerMinute = beatsPerMinute;
    }
  }

  // Restarts from step 0 on the next update.
  reset() {
    this.nextStepIndex = 0;
    this.anchorIndex = 0;
    this.anchorTime = null;
    if (this.pendingBeatsPerMinute !== null) this.beatsPerMinute = this.pendingBeatsPerMinute;
    this.pendingBeatsPerMinute = null;
  }

  applyPendingTempo() {
    if (this.pendingBeatsPerMinute === null || this.nextStepIndex % this.pendingQuantumSteps !== 0) return;
    this.anchorTime = this.nextStepTime;
    this.anchorIndex = this.nextStepIndex;
    this.beatsPerMinute = this.pendingBeatsPerMinute;
    this.pendingBeatsPerMinute = null;
    this.pendingQuantumSteps = this.stepsPerBar;
  }

  update(currentTime, scheduleStep) {
    if (this.anchorTime === null) {
      this.anchorTime = currentTime + this.lookaheadSeconds;
      this.anchorIndex = this.nextStepIndex;
    }
    if (this.nextStepTime < currentTime) {
      this.nextStepIndex += Math.ceil((currentTime - this.nextStepTime) / this.stepDuration);
    }
    const horizon = currentTime + this.lookaheadSeconds;
    this.applyPendingTempo();
    while (this.nextStepTime < horizon) {
      scheduleStep(this.nextStepIndex, this.nextStepTime);
      this.nextStepIndex += 1;
      this.applyPendingTempo();
    }
  }
}
