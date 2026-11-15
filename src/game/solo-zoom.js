// Solo zoom controller: pure, no clock, no Math.random; time is the deltaSeconds passed to update.
// It turns two preset-invariant pressures (near crowding, far action; see zoom-pressure.js) and the
// swarm radius into a target zoom: the pressures are smoothed with an attack and a release time, the
// wish is a log-space blend (punchIn * near - pullOut * far * (1 - near)), the log target chases the
// wish at a limited rate, kept inside [ln minimum, ln maximum] so it cannot wind up past the zoom
// limits, with a Schmitt-style hysteresis (a start, or a reversal against the last direction of
// travel, needs the wish ZOOM_HYSTERESIS away; carrying on the same way follows the wish all the
// way, so a settled pressure is reached exactly instead of stopping short), and the output is
// capped so the whole swarm stays in view (that cap is output-only). The camera
// spring applies smoothSeconds; the shipped default is off (enabled false), only the lab turns it on.
import { ZOOM_DEFAULT_CROWD_REFERENCE } from './zoom-pressure.js';

export const SOLO_ZOOM_DEFAULTS = Object.freeze({
  enabled: false,
  minimum: 0.5,
  maximum: 1.6,
  punchIn: Math.log(1.4),
  pullOut: Math.log(1 / 0.6),
  smoothSeconds: 1.2,
  rateLimit: 0.35,
  crowdReference: ZOOM_DEFAULT_CROWD_REFERENCE,
});

export const SOLO_ZOOM_RANGES = Object.freeze({
  minimum: [0.3, 1],
  maximum: [1, 2.5],
  punchIn: [-0.7, 1],
  pullOut: [0, 1],
  smoothSeconds: [0.2, 4],
  rateLimit: [0.05, 2],
  crowdReference: [ZOOM_DEFAULT_CROWD_REFERENCE / 100, ZOOM_DEFAULT_CROWD_REFERENCE * 100],
});

export const ZOOM_PRESSURE_ATTACK_SECONDS = 0.4;
export const ZOOM_PRESSURE_RELEASE_SECONDS = 2.0;
export const ZOOM_HYSTERESIS = 0.04;
export const ZOOM_FIT_FRACTION = 0.7;
export const ZOOM_FIT_MARGIN = 1.0;

// Expects the unzoomed base view extents (viewSize, not the zoomed view): the fit is a zoom, so it
// divides the base view. The zoom at which a swarm of the given radius fills ZOOM_FIT_FRACTION of the view's shorter half.
export function zoomFit(swarmRadius, viewWidth, viewHeight) {
  return 0.5 * Math.min(viewWidth, viewHeight) * ZOOM_FIT_FRACTION / (swarmRadius + ZOOM_FIT_MARGIN);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function smoothToward(current, input, deltaSeconds) {
  const seconds = input > current ? ZOOM_PRESSURE_ATTACK_SECONDS : ZOOM_PRESSURE_RELEASE_SECONDS;
  return current + (input - current) * (1 - Math.exp(-deltaSeconds / seconds));
}

export class SoloZoomController {
  #settings = { ...SOLO_ZOOM_DEFAULTS };
  #near = 0;
  #far = 0;
  #logTarget = 0;
  #direction = 0;
  #lastZoom = 1;

  get settings() {
    return { ...this.#settings };
  }

  get lastZoom() {
    return this.#lastZoom;
  }

  set(name, value) {
    if (!Object.hasOwn(SOLO_ZOOM_DEFAULTS, name)) throw new RangeError(`unknown solo zoom setting ${name}`);
    if (name === 'enabled') {
      if (typeof value !== 'boolean') throw new RangeError(`solo zoom setting enabled must be a boolean, got ${value}`);
    } else {
      const [lower, upper] = SOLO_ZOOM_RANGES[name];
      if (!(Number.isFinite(value) && value >= lower && value <= upper)) {
        throw new RangeError(`solo zoom setting ${name} must lie in [${lower}, ${upper}], got ${value}`);
      }
    }
    const next = { ...this.#settings, [name]: value };
    if (next.minimum > next.maximum) throw new RangeError(`solo zoom minimum ${next.minimum} exceeds maximum ${next.maximum}`);
    this.#settings = next;
  }

  reset() {
    this.#near = 0;
    this.#far = 0;
    this.#logTarget = 0;
    this.#direction = 0;
    this.#lastZoom = 1;
  }

  hold() {
    return this.#lastZoom;
  }

  // viewWidth and viewHeight are the unzoomed base view extents (they feed zoomFit).
  update(deltaSeconds, { near, far, swarmRadius, viewWidth, viewHeight }) {
    const { minimum, maximum, punchIn, pullOut, rateLimit } = this.#settings;
    this.#near = smoothToward(this.#near, near, deltaSeconds);
    this.#far = smoothToward(this.#far, far, deltaSeconds);
    const wish = punchIn * this.#near - pullOut * this.#far * (1 - this.#near);
    const difference = wish - this.#logTarget;
    const sign = Math.sign(difference);
    if (Math.abs(difference) >= ZOOM_HYSTERESIS) this.#direction = sign;
    if (sign !== 0 && sign === this.#direction) {
      const step = rateLimit * deltaSeconds;
      this.#logTarget = Math.abs(difference) <= step ? wish : this.#logTarget + sign * step;
    }
    this.#logTarget = clamp(this.#logTarget, Math.log(minimum), Math.log(maximum));
    const ceiling = Math.max(minimum, Math.min(maximum, zoomFit(swarmRadius, viewWidth, viewHeight)));
    this.#lastZoom = clamp(Math.exp(this.#logTarget), minimum, ceiling);
    return this.#lastZoom;
  }
}
