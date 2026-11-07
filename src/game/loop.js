// Fixed-step accumulator loop: update runs in whole fixed steps, render gets the leftover fraction
// and the seconds since the previous frame.
export class FrameLoop {
  constructor({
    update,
    render,
    now = performance.now.bind(performance),
    requestFrame = (callback) => requestAnimationFrame(callback),
    fixedStep = 1 / 60,
    maximumSubsteps = 4,
  }) {
    this.update = update;
    this.render = render;
    this.now = now;
    this.requestFrame = requestFrame;
    this.fixedStep = fixedStep;
    this.maximumSubsteps = maximumSubsteps;
    this.frameCount = 0;
    this.running = false;
    this.accumulator = 0;
    this.previousTime = 0;
    this.tick = this.tick.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.previousTime = this.now();
    this.accumulator = 0;
    this.schedule();
  }

  // Call through a local so the scheduler never receives the loop as its receiver (browsers throw on that).
  schedule() {
    const requestFrame = this.requestFrame;
    requestFrame(this.tick);
  }

  stop() {
    this.running = false;
  }

  tick() {
    if (!this.running) return;
    const current = this.now();
    const elapsedSeconds = Math.max(0, (current - this.previousTime) / 1000);
    this.previousTime = current;
    // Clamp so a long stall does not trigger a spiral of catch-up updates.
    this.accumulator = Math.min(this.accumulator + elapsedSeconds, this.fixedStep * this.maximumSubsteps);
    // Epsilon keeps float error from dropping a step on exact multiples.
    while (this.accumulator >= this.fixedStep - 1e-9) {
      this.update(this.fixedStep);
      this.accumulator -= this.fixedStep;
    }
    this.accumulator = Math.max(0, this.accumulator);
    this.render(this.accumulator / this.fixedStep, elapsedSeconds);
    this.frameCount += 1;
    if (this.running) this.schedule();
  }
}
