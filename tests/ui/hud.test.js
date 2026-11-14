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
  assert.equal(find(root, 'hud-lives').textContent, '▲ 2');
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

test('touch Play again restarts once for pointerdown then click', () => {
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

test('the pause button is blurred after a click so Space cannot re-click it', () => {
  const documentObject = createFakeDocument();
  const root = documentObject.createElement('div');
  createHud(root, { documentObject, now: () => 0, onPause: () => {} });
  const pauseButton = find(root, 'hud-pause');
  let blurs = 0;
  pauseButton.blur = () => { blurs += 1; };
  pauseButton.fire('click');
  assert.equal(blurs, 1);
});

// Owner ruling R29: the rail turrets read under the weapon; the row is reserved, never popped in.
test('the turret readout shows the count and the tier above 1, and hides at 0 while keeping its row', () => {
  const { hud, root } = setup();
  const turrets = find(root, 'hud-turrets');
  assert.ok(turrets, 'a turret readout exists');
  const panel = find(root, 'hud-right');
  assert.ok(panel.children.indexOf(turrets) === panel.children.indexOf(find(root, 'hud-weapon')) + 1, 'under the weapon text');
  hud.update({ ...STATE, railTurrets: 0, railTier: 1 });
  assert.equal(turrets.style.visibility, 'hidden');
  assert.equal(turrets.hidden, false, 'the row stays in the layout');
  hud.update({ ...STATE, railTurrets: 3, railTier: 1 });
  assert.equal(turrets.style.visibility, 'visible');
  assert.equal(turrets.textContent, 'RAIL x3');
  hud.update({ ...STATE, railTurrets: 12, railTier: 2 });
  assert.equal(turrets.textContent, 'RAIL x12 II');
  assert.equal(find(root, 'hud-weapon').textContent, 'RAIL III', 'the weapon text stays the armed weapon');
  hud.update({ ...STATE });
  assert.equal(turrets.style.visibility, 'hidden');
});

// Owner ruling R31: a WARP bar under the turret readout drains over the warp; its row is reserved.
test('the warp bar sits under the turret readout, drains with the warp and hides at 0 while keeping its row', () => {
  const { hud, root } = setup();
  const warp = find(root, 'hud-warp');
  assert.ok(warp, 'a warp bar exists');
  const panel = find(root, 'hud-right');
  assert.equal(panel.children.indexOf(warp), panel.children.indexOf(find(root, 'hud-turrets')) + 1, 'under the turret readout');
  assert.equal(find(warp, 'hud-warp-label').textContent, 'WARP');
  const fill = find(warp, 'hud-warp-fill');
  hud.update({ ...STATE, timeWarp: 0 });
  assert.equal(warp.style.visibility, 'hidden');
  assert.equal(warp.hidden, false, 'the row stays in the layout');
  hud.update({ ...STATE, timeWarp: 1 });
  assert.equal(warp.style.visibility, 'visible');
  assert.equal(fill.style.width, '100%');
  hud.update({ ...STATE, timeWarp: 0.25 });
  assert.equal(fill.style.width, '25%');
  hud.update({ ...STATE });
  assert.equal(warp.style.visibility, 'hidden');
});

test('the time warp offer reads NEXT TIME WARP', () => {
  const { hud, root } = setup();
  hud.update({ ...STATE, offeredType: 'timewarp' });
  assert.equal(find(root, 'hud-offer').textContent, 'NEXT TIME WARP');
});

test('the charge bar shows for an armed weapon, fills to the clamped charge and hides on the base gun', () => {
  const { hud, root } = setup();
  const charge = find(root, 'hud-charge');
  const fill = find(root, 'hud-charge-fill');
  hud.update({ ...STATE, charge: 0.5 });
  assert.equal(charge.style.visibility, 'visible');
  assert.equal(fill.style.width, '50%');
  hud.update({ ...STATE, charge: 1.7 });
  assert.equal(fill.style.width, '100%');
  hud.update({ ...STATE, charge: -2 });
  assert.equal(fill.style.width, '0%');
  hud.update({ ...STATE, charge: undefined });
  assert.equal(fill.style.width, '0%');
  hud.update({ ...STATE, armed: 'base', charge: 0.4 });
  assert.equal(charge.style.visibility, 'hidden', 'the row stays reserved but invisible');
  hud.update({ ...STATE, armed: undefined });
  assert.equal(charge.style.visibility, 'hidden');
});

test('layout switches the panels between the hud-bands and hud-top classes, never both', () => {
  const { hud, root } = setup();
  const panels = [find(root, 'hud-left'), find(root, 'hud-right')];
  const arena = (x, width) => ({ x, y: 10, width, height: 400 });
  assert.equal(hud.layout(arena(150, 700), { width: 1000, height: 420 }), 'bands');
  for (const panel of panels) {
    assert.equal(panel.classList.contains('hud-bands'), true);
    assert.equal(panel.classList.contains('hud-top'), false);
    assert.equal(panel.style.opacity, '1');
    assert.equal(panel.style.top, '10px');
  }
  assert.equal(panels[0].style.left, '0px');
  assert.equal(panels[0].style.width, '150px');
  assert.equal(panels[1].style.left, '850px');
  assert.equal(panels[1].style.width, '150px');
  assert.equal(hud.layout(arena(20, 960), { width: 1000, height: 540 }), 'top');
  for (const panel of panels) {
    assert.equal(panel.classList.contains('hud-top'), true);
    assert.equal(panel.classList.contains('hud-bands'), false);
    assert.equal(panel.style.opacity, '0.6');
  }
  // Top mode: the two panels share the arena width, left half then right half.
  assert.equal(panels[0].style.left, '20px');
  assert.equal(panels[0].style.width, '480px');
  assert.equal(panels[1].style.left, '500px');
  assert.equal(panels[1].style.width, '480px');
  // Going back to bands drops the top class again.
  assert.equal(hud.layout(arena(150, 700), { width: 1000, height: 420 }), 'bands');
  assert.equal(panels[0].classList.contains('hud-top'), false);
  assert.equal(panels[0].classList.contains('hud-bands'), true);
});

test('layout centres the pause button on the arena top edge', () => {
  const { hud, root } = setup();
  hud.layout({ x: 100, y: 30, width: 800, height: 450 }, { width: 1000, height: 510 });
  const pause = find(root, 'hud-pause');
  assert.equal(pause.style.left, '483px');
  assert.equal(pause.style.top, '34px');
});

test('solo state, with no seats or one seat, keeps the seat rows hidden', () => {
  const { hud, root } = setup();
  const seats = find(root, 'hud-seats');
  hud.update(STATE);
  assert.equal(seats.hidden, true);
  hud.update({ ...STATE, seats: [{ ships: 12, armed: 'base', tier: 1, down: false }] });
  assert.equal(seats.hidden, true);
});

test('two seats show P1 and P2 rows with ships and weapon in the seat colors', () => {
  const { hud, root } = setup();
  hud.update({
    ...STATE,
    seats: [
      { ships: 12, armed: 'base', tier: 1, down: false },
      { ships: 30, armed: 'scatter', tier: 2, down: false },
    ],
  });
  const seats = find(root, 'hud-seats');
  assert.equal(seats.hidden, false);
  const [first, second] = seats.children;
  assert.equal(first.textContent, 'P1 ▲ 12 BASE');
  assert.equal(second.textContent, 'P2 ▲ 30 SCATTER II');
  assert.equal(first.style.color, '#ffffff');
  assert.equal(second.style.color, 'hsl(130, 90%, 65%)');
  assert.equal(find(root, 'hud-weapon').textContent, 'RAIL III');
});

test('a downed seat reads DOWN with its revive progress', () => {
  const { hud, root } = setup();
  hud.update({
    ...STATE,
    seats: [
      { ships: 12, armed: 'base', tier: 1, down: false },
      { ships: 0, armed: 'base', tier: 1, down: true, reviveKills: 37, reviveKillsNeeded: 100 },
    ],
  });
  const seats = find(root, 'hud-seats');
  assert.equal(seats.hidden, false);
  assert.equal(seats.children[1].textContent, 'P2 DOWN 37/100');
  assert.equal(seats.children[0].textContent, 'P1 ▲ 12 BASE');
});
