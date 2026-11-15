import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BEAM_TIME_TITLE_Z_INDEX, BeamTimeTitleTimeline, TITLE_SECONDS, TITLE_TEXT, createBeamTimeTitle, titleFrame,
} from '../../src/ui/beam-time-title.js';

function fakeDocument() {
  return { createElement: () => ({ style: {}, className: '', textContent: '' }) };
}

test('the title pops in with an overshoot, holds, and fades out by TITLE_SECONDS', () => {
  assert.equal(titleFrame(0).opacity, 0);
  assert.ok(titleFrame(0).scale < 0.7);
  const popped = titleFrame(0.125);
  assert.ok(popped.scale > 1, `overshoot, got ${popped.scale}`);
  assert.equal(titleFrame(0.25).scale, 1);
  assert.equal(titleFrame(0.5).opacity, 1);
  const fading = titleFrame(1.5).opacity;
  assert.ok(fading > 0 && fading < 1);
  assert.equal(titleFrame(TITLE_SECONDS).opacity, 0);
  assert.ok(TITLE_SECONDS >= 1.5 && TITLE_SECONDS <= 2);
});

test('reduced motion never scales and shows at once', () => {
  for (const seconds of [0, 0.05, 0.125, 0.25, 1]) assert.equal(titleFrame(seconds, true).scale, 1);
  assert.equal(titleFrame(0, true).opacity, 1);
  assert.equal(titleFrame(TITLE_SECONDS, true).opacity, 0);
});

test('a rise from idle starts the title once; staying active does not restart it', () => {
  const timeline = new BeamTimeTitleTimeline();
  assert.equal(timeline.update(0, 0.016).started, false);
  const first = timeline.update(1, 0.016);
  assert.equal(first.started, true);
  assert.equal(first.opacity, 0);
  let opacity = 0;
  for (let step = 0; step < 20; step += 1) {
    const frame = timeline.update(1 - step * 0.01, 0.05);
    assert.equal(frame.started, false);
    opacity = Math.max(opacity, frame.opacity);
  }
  assert.equal(opacity, 1);
  for (let step = 0; step < 20; step += 1) timeline.update(0.5, 0.05);
  assert.equal(timeline.update(0.4, 0.05).opacity, 0);
});

test('a second beam time start shows the title again', () => {
  const timeline = new BeamTimeTitleTimeline();
  timeline.update(0, 0.016);
  timeline.update(1, 0.016);
  for (let step = 0; step < 50; step += 1) timeline.update(0.5, 0.05);
  timeline.update(0, 0.016);
  assert.equal(timeline.update(1, 0.016).started, true);
  assert.equal(timeline.update(1, 0.2).opacity > 0, true);
});

test('a page that begins mid beam time, and idle updates, show nothing', () => {
  const timeline = new BeamTimeTitleTimeline();
  assert.deepEqual(timeline.update(0.7, 0.016), { started: false, opacity: 0, scale: 1 });
  for (let step = 0; step < 5; step += 1) assert.equal(timeline.update(0.6, 0.1).opacity, 0);
  const idle = new BeamTimeTitleTimeline();
  for (let step = 0; step < 5; step += 1) assert.equal(idle.update(0, 0.1).opacity, 0);
  assert.equal(new BeamTimeTitleTimeline().update(Number.NaN, 0.1).started, false);
});

test('the element is created once, hidden, and driven by opacity and transform alone', () => {
  const parent = { children: [], append(item) { this.children.push(item); } };
  let reduced = false;
  const title = createBeamTimeTitle(parent, { documentObject: fakeDocument(), isReducedMotion: () => reduced });
  assert.equal(parent.children.length, 1);
  assert.equal(title.element.textContent, TITLE_TEXT);
  assert.equal(title.element.style.opacity, '0');
  assert.equal(title.element.style.zIndex, BEAM_TIME_TITLE_Z_INDEX);
  title.update(0, 0.016);
  title.update(1, 0.016);
  title.update(1, 0.125);
  assert.ok(Number(title.element.style.opacity) > 0);
  assert.match(title.element.style.transform, /scale\(1\.\d+/);
  reduced = true;
  title.update(1, 0.01);
  assert.match(title.element.style.transform, /scale\(1\)/);
  assert.equal(parent.children.length, 1);
});

const css = readFileSync(new URL('../../src/ui/beam-time-title.css', import.meta.url), 'utf8');
const menuCss = readFileSync(new URL('../../src/ui/menu.css', import.meta.url), 'utf8');

test('the css is fixed, takes no touches, uses the beam hue and sits under the menus', () => {
  assert.match(css, /position: fixed/);
  assert.match(css, /pointer-events: none/);
  assert.match(css, /hsl\(331, 100%, 70%\)/);
  const menuZ = Number(/\.menu \{[^}]*z-index: (\d+)/.exec(menuCss)[1]);
  assert.ok(Number(BEAM_TIME_TITLE_Z_INDEX) < menuZ);
});

test('index.html links the stylesheet and main.js creates and updates the title', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, /beam-time-title\.css/);
  const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /createBeamTimeTitle\(document\.body/);
  assert.match(main, /beamTimeTitle\.update\(state\.beamTime, deltaSeconds\)/);
});
