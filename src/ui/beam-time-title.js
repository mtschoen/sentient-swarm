// The BEAM TIME! title: a large centered banner over the arena that pops in when beam time starts
// and fades out in about TITLE_SECONDS. One persistent fixed element (never inserted or removed, so
// no layout moves) driven by inline opacity and transform from a pure timeline (`titleFrame`); the
// look is in beam-time-title.css. The start is the rising edge of the game state's `beamTime`
// fraction (0 while idle, 1 just after a start), so one beam time start shows it once, in solo or
// co-op, and nothing shows at load or when the lab changes knobs.
export const TITLE_SECONDS = 1.8;
export const TITLE_TEXT = 'BEAM TIME!';
// z-index level with the edge indicators and beam shard pointers: under the HUD and every menu.
export const BEAM_TIME_TITLE_Z_INDEX = '4';
const POP_SECONDS = 0.25;
const FADE_IN_SECONDS = 0.12;
const FADE_OUT_START_SECONDS = 1.2;
const POP_START_SCALE = 0.55;
const POP_OVERSHOOT_SCALE = 1.12;

const clamp01 = (value) => Math.min(1, Math.max(0, value));

// opacity and scale at `elapsedSeconds` since the start. Reduced motion: no scale, no fade in, a plain
// show then the same fade out.
export function titleFrame(elapsedSeconds, reducedMotion = false) {
  if (!(elapsedSeconds >= 0) || elapsedSeconds >= TITLE_SECONDS) return { opacity: 0, scale: 1 };
  const fadeOut = 1 - clamp01((elapsedSeconds - FADE_OUT_START_SECONDS) / (TITLE_SECONDS - FADE_OUT_START_SECONDS));
  if (reducedMotion) return { opacity: fadeOut, scale: 1 };
  const pop = clamp01(elapsedSeconds / POP_SECONDS);
  // Rises past 1 and settles back: a short overshoot.
  const eased = 1 - (1 - pop) ** 3;
  const overshoot = Math.sin(pop * Math.PI) * (POP_OVERSHOOT_SCALE - 1);
  return {
    opacity: clamp01(elapsedSeconds / FADE_IN_SECONDS) * fadeOut,
    scale: POP_START_SCALE + (1 - POP_START_SCALE) * eased + overshoot,
  };
}

// Tracks beam time's start from the fraction each frame and the title's age. update returns the
// frame to draw. A first update only sets the baseline, so a page that loads mid beam time shows nothing.
export class BeamTimeTitleTimeline {
  constructor() {
    this.previousFraction = null;
    this.elapsedSeconds = Infinity;
  }

  update(beamTimeFraction, deltaSeconds, reducedMotion = false) {
    const fraction = Number.isFinite(beamTimeFraction) ? beamTimeFraction : 0;
    // A rise from idle, or a refill while running (a restart), is a start.
    const started = this.previousFraction !== null && fraction > this.previousFraction && (this.previousFraction === 0 || fraction >= 1);
    this.previousFraction = fraction;
    if (started) this.elapsedSeconds = 0;
    else if (Number.isFinite(deltaSeconds) && deltaSeconds > 0) this.elapsedSeconds += deltaSeconds;
    return { started, ...titleFrame(this.elapsedSeconds, reducedMotion) };
  }
}

// parent: the element the title is appended to. isReducedMotion: () => boolean, read each frame.
export function createBeamTimeTitle(parent, { documentObject = document, isReducedMotion = () => false } = {}) {
  const element = documentObject.createElement('div');
  element.className = 'beam-time-title';
  element.textContent = TITLE_TEXT;
  Object.assign(element.style, { opacity: '0', zIndex: BEAM_TIME_TITLE_Z_INDEX });
  parent.append(element);
  const timeline = new BeamTimeTitleTimeline();
  return {
    element,
    // state.beamTime (the fraction of beam time left) and the frame's delta in seconds.
    update(beamTimeFraction, deltaSeconds) {
      const frame = timeline.update(beamTimeFraction, deltaSeconds, isReducedMotion());
      element.style.opacity = String(frame.opacity);
      element.style.transform = `translate(-50%, -50%) scale(${frame.scale})`;
    },
  };
}
