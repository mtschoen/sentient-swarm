import test from 'node:test';
import assert from 'node:assert/strict';
import * as hudModule from '../../src/ui/hud.js';

const { createHud } = hudModule;

function createFakeDocument() {
  const make = (tagName) => {
    const classes = new Set();
    const listeners = {};
    const style = { setProperty(name, value) { this[name] = value; } };
    return {
      tagName, textContent: '', children: [], style, hidden: false,
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...nodes) { this.children.push(...nodes); },
      addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
      fire(type, event = {}) { (listeners[type] ?? []).forEach((listener) => listener(event)); },
    };
  };
  return { createElement: make };
}

function find(node, className) {
  if (node.classList?.contains(className)) return node;
  for (const child of node.children ?? []) {
    const found = typeof child === 'string' ? null : find(child, className);
    if (found) return found;
  }
  return null;
}

function setup() {
  const clock = { now: 0 };
  const documentObject = createFakeDocument();
  const root = documentObject.createElement('div');
  const hud = createHud(root, { documentObject, now: () => clock.now });
  return { hud, root, clock };
}

const STATE = { score: 123456, multiplier: 4, lives: 2, bombs: 1, armed: 'rail', tier: 3, charge: 0.5, offeredType: 'beam' };

test('update renders score, multiplier, weapon and icon rows', () => {
  const { hud, root } = setup();
  hud.update(STATE);
  assert.equal(find(root, 'hud-score').textContent, '123,456');
  assert.equal(find(root, 'hud-multiplier').textContent, 'x4');
  assert.equal(find(root, 'hud-weapon').textContent, 'RAIL III');
  assert.equal(find(root, 'hud-lives').textContent.length, 2);
  assert.equal(find(root, 'hud-bombs').textContent.length, 1);
  assert.match(find(root, 'hud-offer').textContent, /BEAM/);
});

test('base gun reads BASE', () => {
  const { hud, root } = setup();
  hud.update({ ...STATE, armed: 'base', tier: 1 });
  assert.equal(find(root, 'hud-weapon').textContent, 'BASE');
});

test('layout uses the bands when both fit the band text, else the top edge', () => {
  const { hud } = setup();
  const arena = (x, width) => ({ x, y: 0, width, height: 400 });
  assert.equal(hud.layout(arena(150, 700), { width: 1000, height: 400 }), 'bands');
  assert.equal(hud.layout(arena(20, 960), { width: 1000, height: 540 }), 'top');
  assert.equal(hud.layout(arena(100, 840), { width: 1000, height: 400 }), 'top');
});

// Letterboxed 16:9 arena rectangle for a window, as main.js passes it (CSS pixels).
function windowLayout(width, height) {
  const arenaWidth = Math.min(width, (height * 16) / 9);
  const arenaHeight = (arenaWidth * 9) / 16;
  return [{ x: (width - arenaWidth) / 2, y: (height - arenaHeight) / 2, width: arenaWidth, height: arenaHeight }, { width, height }];
}

test('band text is sized to fit its band: 1920x900 and 2560x1300 keep bands, phone landscape uses the top row', () => {
  const { hud, root } = setup();
  const { BAND_TEXT, BAND_PADDING_CSS_PIXELS, MINIMUM_BAND_FONT_CSS_PIXELS } = hudModule;
  assert.ok(BAND_TEXT, 'hud.js exports the band text widths');
  for (const [width, height] of [[1920, 900], [2560, 1300], [1600, 700]]) {
    const [arena, viewport] = windowLayout(width, height);
    assert.equal(hud.layout(arena, viewport), 'bands', `${width}x${height}`);
    const contentWidth = arena.x - BAND_PADDING_CSS_PIXELS;
    for (const panelName of ['hud-left', 'hud-right']) {
      const panel = find(root, panelName);
      for (const [name, { fullSize, width: fullWidth }] of Object.entries(BAND_TEXT)) {
        const size = Number.parseFloat(panel.style[`--hud-${name}-size`]);
        assert.ok(size >= MINIMUM_BAND_FONT_CSS_PIXELS && size <= fullSize, `${width}x${height} ${name} ${size}`);
        // Text width scales with font size; the rounding to 0.1 px may add at most 0.05 px.
        assert.ok((fullWidth * size) / fullSize <= contentWidth + 0.5, `${width}x${height} ${name} fits`);
      }
    }
  }
  for (const [width, height] of [[932, 430], [844, 390], [1280, 720], [1920, 970], [1366, 650]]) {
    assert.equal(hud.layout(...windowLayout(width, height)), 'top', `${width}x${height}`);
  }
  // Wide bands get the full sizes.
  hud.layout(...windowLayout(3440, 1000));
  assert.equal(find(root, 'hud-left').style['--hud-multiplier-size'], '54.0px');
});

test('game over shows the score and restarts from the button', () => {
  const { hud, root } = setup();
  let restarts = 0;
  hud.showGameOver(98765, () => { restarts += 1; });
  assert.equal(find(root, 'hud-gameover').hidden, false);
  assert.equal(find(root, 'hud-final-score').textContent, '98,765');
  find(root, 'hud-play-again').fire('click');
  assert.equal(restarts, 1);
  hud.hideGameOver();
  assert.equal(find(root, 'hud-gameover').hidden, true);
});

test('touch tap restarts only after the guard delay and mouse taps never do', () => {
  const { hud, root, clock } = setup();
  let restarts = 0;
  hud.showGameOver(1, () => { restarts += 1; });
  const overlay = find(root, 'hud-gameover');
  overlay.fire('pointerdown', { pointerType: 'touch' });
  assert.equal(restarts, 0);
  clock.now += 1000;
  overlay.fire('pointerdown', { pointerType: 'mouse' });
  assert.equal(restarts, 0);
  overlay.fire('pointerdown', { pointerType: 'touch' });
  assert.equal(restarts, 1);
});

test('a touch tap on Play again (pointerdown, then click) restarts once', () => {
  const { hud, root, clock } = setup();
  let restarts = 0;
  hud.showGameOver(1, () => { restarts += 1; });
  clock.now += 1000;
  find(root, 'hud-gameover').fire('pointerdown', { pointerType: 'touch' });
  find(root, 'hud-play-again').fire('click');
  assert.equal(restarts, 1);
  // The next game over arms it again.
  hud.hideGameOver();
  hud.showGameOver(2, () => { restarts += 1; });
  find(root, 'hud-play-again').fire('click');
  assert.equal(restarts, 2);
});

test('showToast sets the text and restarts the fade; the settings button is touch exclusive', () => {
  const { hud, root } = setup();
  hud.showToast('Gamepad connected: pad');
  const toast = find(root, 'hud-toast');
  assert.equal(toast.textContent, 'Gamepad connected: pad');
  assert.ok(toast.classList.contains('hud-toast-show'));
  assert.equal(hud.settingsButton.attributes['data-touch-exclusive'], '');
});

test('the pause button calls onPause, shows only while a run is live, and is excluded from touch sticks', () => {
  const documentObject = createFakeDocument();
  const root = documentObject.createElement('div');
  let pauses = 0;
  const hud = createHud(root, { documentObject, now: () => 0, onPause: () => { pauses += 1; } });
  const pauseButton = find(root, 'hud-pause');
  assert.ok(pauseButton, 'a pause button exists');
  assert.ok('data-touch-exclusive' in pauseButton.attributes);
  pauseButton.fire('click');
  assert.equal(pauses, 1);
  hud.update({ ...STATE, phase: 'ready' });
  assert.equal(pauseButton.hidden, true);
  hud.update({ ...STATE, phase: 'playing' });
  assert.equal(pauseButton.hidden, false);
  hud.update({ ...STATE, phase: 'paused' });
  assert.equal(pauseButton.hidden, true);
  hud.update({ ...STATE, phase: 'gameOver' });
  assert.equal(pauseButton.hidden, true);
});
