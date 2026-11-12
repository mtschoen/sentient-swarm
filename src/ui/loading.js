// Loading screen: the stage weights, a monotonic progress tracker, the hidden warm-up rule and the
// wrapper around the static #loading markup in index.html.
export const LOADING_STAGES = Object.freeze([
  Object.freeze({ name: 'device', weight: 0.05, label: 'Starting WebGPU' }),
  Object.freeze({ name: 'simulation', weight: 0.3, label: 'Building the swarm' }),
  Object.freeze({ name: 'renderer', weight: 0.3, label: 'Building the renderer' }),
  Object.freeze({ name: 'game', weight: 0.15, label: 'Arming weapons' }),
  Object.freeze({ name: 'warmUp', weight: 0.2, label: 'Warming up' }),
]);

const FINISH_FALLBACK_MILLISECONDS = 400;
// The warm-up bar stops short of full until the warm-up is actually over.
const WARM_UP_BAR_CEILING = 0.95;

export class LoadProgress {
  constructor() {
    this.completion = LOADING_STAGES.map(() => 0);
    this.highest = 0;
    this.latestIndex = 0;
  }

  report(stageName, completed, total) {
    const index = LOADING_STAGES.findIndex((stage) => stage.name === stageName);
    if (index < 0) throw new RangeError(`Unknown loading stage: ${stageName}`);
    const ratio = total > 0 ? completed / total : 1;
    const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
    for (let earlier = 0; earlier < index; earlier += 1) this.completion[earlier] = 1;
    this.completion[index] = Math.max(this.completion[index], clamped);
    this.latestIndex = Math.max(this.latestIndex, index);
  }

  get fraction() {
    const total = LOADING_STAGES.reduce((sum, stage, index) => sum + stage.weight * this.completion[index], 0);
    this.highest = Math.max(this.highest, Math.min(1, total));
    return this.highest;
  }

  get label() {
    return LOADING_STAGES[this.latestIndex].label;
  }
}

export class WarmUp {
  constructor({ minimumFrames = 30, settledFrames = 10, settledSeconds = 0.034, maximumSeconds = 3 } = {}) {
    this.minimumFrames = minimumFrames;
    this.settledFrames = settledFrames;
    this.settledSeconds = settledSeconds;
    this.maximumSeconds = maximumSeconds;
    this.frames = 0;
    this.seconds = 0;
    this.settledRun = 0;
    this.done = false;
    this.best = 0;
  }

  frame(deltaSeconds) {
    if (this.done) return true;
    this.frames += 1;
    this.seconds += deltaSeconds;
    this.settledRun = deltaSeconds <= this.settledSeconds ? this.settledRun + 1 : 0;
    const settled = this.frames >= this.minimumFrames && this.settledRun >= this.settledFrames;
    if (settled || this.seconds >= this.maximumSeconds) this.done = true;
    return this.done;
  }

  get progress() {
    if (this.done) return 1;
    const byFrames = this.frames / this.minimumFrames;
    const byTime = this.seconds / this.maximumSeconds;
    this.best = Math.max(this.best, Math.min(WARM_UP_BAR_CEILING, Math.max(byFrames, byTime)));
    return this.best;
  }
}

export function createLoadingScreen({ element, setTimer = setTimeout }) {
  const fill = element.querySelector('.loading-bar-fill');
  const bar = element.querySelector('.loading-bar');
  const status = element.querySelector('.loading-status');
  let closed = false;
  const setPercent = (fraction) => {
    const percent = Math.min(100, Math.max(0, fraction * 100));
    fill.style.width = `${percent}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(percent)));
  };
  return {
    update(fraction, label) {
      if (closed) return;
      setPercent(fraction);
      status.textContent = label;
    },
    finish() {
      if (closed) return;
      closed = true;
      setPercent(1);
      element.classList.add('loading-done');
      let hidden = false;
      const hideOnce = () => {
        if (hidden) return;
        hidden = true;
        element.hidden = true;
      };
      // Only the overlay's own fade counts: the bar fill's shorter width transition bubbles up too.
      element.addEventListener('transitionend', (event) => { if (event.target === element) hideOnce(); });
      setTimer(hideOnce, FINISH_FALLBACK_MILLISECONDS);
    },
    fail() {
      if (closed) return;
      closed = true;
      element.hidden = true;
    },
    get visible() {
      return !element.hidden;
    },
  };
}
