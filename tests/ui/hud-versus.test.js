import test from 'node:test';
import assert from 'node:assert/strict';
import { createHud } from '../../src/ui/hud.js';
import { gameOverBanner } from '../../src/ui/hud-seat.js';
import { SEAT_COLORS } from '../../src/game/seat-colors.js';

function createFakeDocument() {
  const make = (tagName) => {
    const classes = new Set();
    const style = { setProperty(name, value) { this[name] = value; } };
    return {
      tagName, textContent: '', children: [], style, hidden: false, attributes: {},
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = [...nodes]; },
      addEventListener() {},
    };
  };
  return { createElement: make };
}

function find(node, className) {
  if (node.classList?.contains(className)) return node;
  for (const child of node.children ?? []) {
    const found = find(child, className);
    if (found) return found;
  }
  return null;
}

test('a versus game over names the winner in its seat color, and the next game over is GAME OVER again', () => {
  const documentObject = createFakeDocument();
  const root = documentObject.createElement('div');
  const hud = createHud(root, { documentObject, now: () => 0 });
  hud.showGameOver(10, () => {}, gameOverBanner({ winner: 1, draw: false }));
  const title = find(root, 'hud-gameover-title');
  assert.equal(title.textContent, 'PLAYER 2 WINS');
  assert.equal(title.style.color, SEAT_COLORS[1].css);
  hud.hideGameOver();
  hud.showGameOver(10, () => {});
  assert.equal(title.textContent, 'GAME OVER');
  assert.equal(title.style.color, '');
});
