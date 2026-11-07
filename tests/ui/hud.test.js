import test from 'node:test';
import assert from 'node:assert/strict';
import { createHud } from '../../src/ui/hud.js';

function createFakeDocument() {
  const make = (tagName) => {
    const classes = new Set();
    const listeners = {};
    return {
      tagName, textContent: '', children: [], style: {}, hidden: false,
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
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

test('layout uses the bands when both are at least 80 px, else the top edge', () => {
  const { hud } = setup();
  const arena = (x, width) => ({ x, y: 0, width, height: 400 });
  assert.equal(hud.layout(arena(100, 800), { width: 1000, height: 400 }), 'bands');
  assert.equal(hud.layout(arena(20, 960), { width: 1000, height: 540 }), 'top');
  assert.equal(hud.layout(arena(100, 840), { width: 1000, height: 400 }), 'top');
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
