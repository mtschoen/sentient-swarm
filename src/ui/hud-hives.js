// The hives HUD readout (stage 3): three pips, one per hive in hive order (seat 1's side, seat 2's
// side, the center), and the hold countdown. It is laid out for a whole hives run and hidden
// otherwise (a run's mode is fixed, so nothing pops during play): a pip only changes its colors and
// the countdown is reserved by visibility. A neutral pip is a pale ring, an owned one filled in its
// seat's color, and capture progress fills the ring clockwise in the capturer's color.
import { SEAT_COLORS } from '../game/seat-colors.js';

const NEUTRAL_COLOR = 'rgba(200, 200, 215, 0.75)';

// The pure view of state.hives ({ hives, holder, holdRemainingSeconds }, or null outside hives):
// { shown, pips: [{ border, background }], countdown: { text, color, visible } }.
export function hiveReadoutView(hives) {
  if (hives === null || hives === undefined) return { shown: false, pips: [], countdown: { text: '', color: '', visible: false } };
  const pips = hives.hives.map(({ owner, capturer, progress }) => {
    if (owner !== null) return { border: SEAT_COLORS[owner].css, background: SEAT_COLORS[owner].css };
    if (capturer === null || !(progress > 0)) return { border: NEUTRAL_COLOR, background: 'transparent' };
    const color = SEAT_COLORS[capturer].css;
    return { border: NEUTRAL_COLOR, background: `conic-gradient(${color} ${Math.round(progress * 100)}%, transparent 0)` };
  });
  const holder = hives.holder;
  const countdown = holder === null
    ? { text: '', color: '', visible: false }
    : { text: `P${holder + 1} WINS IN ${Math.ceil(hives.holdRemainingSeconds ?? 0)}`, color: SEAT_COLORS[holder].css, visible: true };
  return { shown: true, pips, countdown };
}

// make(tagName, className, text) is the HUD's element factory. Returns { element, update(hives) }.
export function createHiveReadout(make, count = 3) {
  const pips = Array.from({ length: count }, () => make('span', 'hud-hive-pip'));
  const pipRow = make('div', 'hud-hive-pips');
  pipRow.append(...pips);
  pipRow.setAttribute('aria-label', 'Hives');
  // A fixed placeholder text keeps the countdown's line laid out while it is hidden.
  const countdown = make('div', 'hud-hive-countdown', 'P1 WINS IN 20');
  countdown.style.visibility = 'hidden';
  const element = make('div', 'hud-hives');
  element.append(pipRow, countdown);
  element.hidden = true;
  const last = new Map();
  // Skips unchanged writes: update runs every rendered frame.
  const set = (target, name, value) => {
    const values = last.get(target) ?? {};
    if (values[name] === value) return;
    values[name] = value;
    last.set(target, values);
    if (name === 'text') target.textContent = value;
    else target.style[name] = value;
  };
  return {
    element,
    update(hives) {
      const view = hiveReadoutView(hives);
      if (element.hidden === view.shown) element.hidden = !view.shown;
      if (!view.shown) return;
      view.pips.forEach((pip, index) => {
        if (pips[index] === undefined) return;
        set(pips[index], 'borderColor', pip.border);
        set(pips[index], 'background', pip.background);
      });
      if (view.countdown.visible) {
        set(countdown, 'text', view.countdown.text);
        set(countdown, 'color', view.countdown.color);
      }
      set(countdown, 'visibility', view.countdown.visible ? 'visible' : 'hidden');
    },
  };
}
