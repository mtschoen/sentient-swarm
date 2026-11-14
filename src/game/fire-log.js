// Fire log (diagnostic, ?debug=fire): records why the swarm stopped shooting, for a device with no
// console at hand. Pure: no DOM or clock (time is the sum of the sampled deltas). Game.update feeds
// one sample per step; src/ui/fire-debug.js shows the result.
// Three kinds of entry, newest last, each list capped:
// - thin stretches: fire held while playing is cut into windows of WINDOW_SECONDS; a window whose
//   ship shots fall under THIN_SHARE of what the armed weapon's law gives is thin (fire that
//   sputters without ever stopping), and thin windows in a row are one entry with their length,
//   their worst share and the average ships in the cone and off cooldown. Windows the law gives
//   under MINIMUM_EXPECTED_SHOTS (the beam, a pulse) are not judged. The status line counts thin
//   windows against all judged ones.
// - releases: the fire input went from held to not held, with the touch event that came last
//   (src/input/touch.js lastEvent: end, cancel, blur, ...) and how long fire had been held. A
//   release the player did not make shows here as a cancel, a blur or an end.
// - silences: fire was held while playing, yet no swarm ship fired for longer than the armed
//   weapon explains (SILENCE_SECONDS, or SILENCE_SHOT_INTERVALS shots of the weapon's aggregate
//   rate when that is longer), with the reason read from SwarmFire's report at that moment, the
//   aim and the movement.
// A dropout with no entry means the ships did fire: the shots were lost after SwarmFire.
export const WINDOW_SECONDS = 0.25;
export const THIN_SHARE = 0.5;
export const MINIMUM_EXPECTED_SHOTS = 2;
export const MAXIMUM_THIN = 6;
export const SILENCE_SECONDS = 0.35;
export const SILENCE_SHOT_INTERVALS = 5;
export const MAXIMUM_RELEASES = 4;
export const MAXIMUM_SILENCES = 6;
// The measured shot rate in the status line is averaged over this long.
const RATE_WINDOW_SECONDS = 0.5;
const DEGREES_PER_RADIAN = 180 / Math.PI;

function degrees(x, y) {
  if (x === 0 && y === 0) return 'none';
  return `${Math.round(Math.atan2(y, x) * DEGREES_PER_RADIAN)}deg`;
}

// Why nothing fired, from SwarmFire's report of the step.
export function silenceReason(armed, report) {
  if (report.ships === 0) return 'no ships alive';
  if (!(report.shotsPerSecond > 0)) return `armed ${armed} fires no ship shots`;
  if (report.inCone === 0) return `0 of ${report.ships} ships in the aim cone`;
  if (report.ready === 0) return `${report.inCone} of ${report.ships} in the cone, none off cooldown`;
  return `${report.inCone} in the cone and ${report.ready} off cooldown, but no ship is both`;
}

function push(list, entry, maximum) {
  list.push(entry);
  if (list.length > maximum) list.shift();
}

export class FireLog {
  // touchEvent: () => the touch source's lastEvent ({ type, role, sequence }) or null.
  constructor({ touchEvent = () => null } = {}) {
    this.touchEvent = touchEvent;
    this.time = 0;
    this.releases = [];
    this.silences = [];
    this.wasFiring = false;
    this.heldSeconds = 0;
    this.silentSeconds = 0;
    this.openSilence = null;
    this.thin = [];
    this.openThin = null;
    this.judgedWindows = 0;
    this.thinWindows = 0;
    this.window = { seconds: 0, expected: 0, shots: 0, inCone: 0, ready: 0, ships: 0, steps: 0 };
    this.windowSeconds = 0;
    this.windowShots = 0;
    this.shotsPerSecond = 0;
    this.statusText = '';
  }

  // One Game.update step. sample: { phase, inputFiring, armed, report (SwarmFire.report), aimX, aimY,
  // moveX, moveY }.
  sample(deltaSeconds, { phase, inputFiring, armed, report, aimX, aimY, moveX, moveY }) {
    this.time += deltaSeconds;
    const touch = this.touchEvent();
    const touchText = touch ? `${touch.type} ${touch.role}` : 'none';
    if (inputFiring) this.heldSeconds += deltaSeconds;
    else {
      if (this.wasFiring) {
        push(this.releases, { time: this.time, text: `released after ${this.heldSeconds.toFixed(1)}s held, last touch event: ${touchText}` }, MAXIMUM_RELEASES);
      }
      this.heldSeconds = 0;
    }
    this.wasFiring = inputFiring;

    const expected = inputFiring && phase === 'playing';
    if (!expected || report.fired > 0) {
      this.silentSeconds = 0;
      this.openSilence = null;
    } else {
      this.silentSeconds += deltaSeconds;
      const explained = report.shotsPerSecond > 0 ? SILENCE_SHOT_INTERVALS / report.shotsPerSecond : 0;
      if (this.openSilence === null && this.silentSeconds >= Math.max(SILENCE_SECONDS, explained)) {
        this.openSilence = {
          time: this.time,
          seconds: 0,
          reason: `${silenceReason(armed, report)}; armed ${armed}, aim ${degrees(aimX, aimY)}, move ${degrees(moveX, moveY)}`,
        };
        push(this.silences, this.openSilence, MAXIMUM_SILENCES);
      }
      if (this.openSilence !== null) this.openSilence.seconds = this.silentSeconds;
    }

    this.judge(deltaSeconds, expected, report, `aim ${degrees(aimX, aimY)}, move ${degrees(moveX, moveY)}`);

    this.windowSeconds += deltaSeconds;
    this.windowShots += report.fired;
    if (this.windowSeconds >= RATE_WINDOW_SECONDS) {
      this.shotsPerSecond = this.windowShots / this.windowSeconds;
      this.windowSeconds = 0;
      this.windowShots = 0;
    }
    this.statusText = `fire ${inputFiring ? 'HELD' : 'off'} | ${phase} | ${armed} | ships ${report.ships} cone ${report.inCone} ready ${report.ready} | ${this.shotsPerSecond.toFixed(0)}/s | thin ${this.thinWindows}/${this.judgedWindows} | touch: ${touchText}`;
  }

  // The thin-fire windows: only time with fire held while playing and a weapon the ships fire
  // counts, and a break (a release, the beam) starts over.
  judge(deltaSeconds, expected, report, where) {
    const window = this.window;
    if (!expected || !(report.shotsPerSecond > 0)) {
      window.seconds = 0;
      this.openThin = null;
      return;
    }
    if (window.seconds === 0) {
      window.expected = 0;
      window.shots = 0;
      window.inCone = 0;
      window.ready = 0;
      window.ships = 0;
      window.steps = 0;
    }
    window.seconds += deltaSeconds;
    window.expected += report.shotsPerSecond * deltaSeconds;
    window.shots += report.fired;
    window.inCone += report.inCone;
    window.ready += report.ready;
    window.ships += report.ships;
    window.steps += 1;
    if (window.seconds < WINDOW_SECONDS) return;
    const seconds = window.seconds;
    window.seconds = 0;
    if (window.expected < MINIMUM_EXPECTED_SHOTS) {
      this.openThin = null;
      return;
    }
    this.judgedWindows += 1;
    const share = window.shots / window.expected;
    if (share >= THIN_SHARE) {
      this.openThin = null;
      return;
    }
    this.thinWindows += 1;
    if (this.openThin === null) {
      this.openThin = { time: this.time - seconds, seconds: 0, share: 1, detail: '' };
      push(this.thin, this.openThin, MAXIMUM_THIN);
    }
    const entry = this.openThin;
    entry.seconds += seconds;
    if (share < entry.share) {
      entry.share = share;
      const average = (sum) => (sum / window.steps).toFixed(1);
      entry.detail = `cone ${average(window.inCone)} ready ${average(window.ready)} of ${average(window.ships)} ships; ${where}`;
    }
  }

  // The lines the overlay shows: the status, then the silences and the releases, oldest first.
  lines() {
    return [
      this.statusText,
      ...this.thin.map((entry) => `${entry.time.toFixed(1)}s THIN ${entry.seconds.toFixed(2)}s at ${Math.round(entry.share * 100)}% of the law: ${entry.detail}`),
      ...this.silences.map((entry) => `${entry.time.toFixed(1)}s SILENT ${entry.seconds.toFixed(1)}s: ${entry.reason}`),
      ...this.releases.map((entry) => `${entry.time.toFixed(1)}s ${entry.text}`),
    ];
  }
}
