import test from 'node:test';
import assert from 'node:assert/strict';
import { MODE_ITEM_ID, ModeChoice, createModeControl, modeItemView } from '../../src/ui/mode-choice.js';
import { createMenu } from '../../src/ui/menu.js';
import { gameOverBanner } from '../../src/ui/hud-seat.js';
import { SEAT_COLORS } from '../../src/game/seat-colors.js';

function createFakeDocument() {
  const make = (tagName) => {
    const classes = new Set();
    const listeners = {};
    return {
      tagName: tagName.toUpperCase(), textContent: '', children: [], hidden: false, attributes: {},
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...nodes) { this.children.push(...nodes); },
      addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
      fire(type, event = {}) { (listeners[type] ?? []).forEach((listener) => listener({ stopPropagation() {}, preventDefault() {}, ...event })); },
    };
  };
  return { createElement: make };
}

function allButtons(node) {
  const found = node.tagName === 'BUTTON' ? [node] : [];
  return found.concat((node.children ?? []).flatMap(allButtons));
}
const focusedLabel = (menu) => allButtons(menu.element).find((node) => node.classList.contains('menu-focused'))?.textContent;
const modeButton = (menu) => allButtons(menu.element).find((node) => node.classList.contains('menu-mode'));

function titleWithMode() {
  const control = createModeControl();
  const calls = { start: 0, lab: 0 };
  const menu = createMenu({
    onStart: () => { calls.start += 1; },
    onLab: () => { calls.lab += 1; },
    onSettings() {},
    modeItem: control.menuItem,
    documentObject: createFakeDocument(),
  });
  control.attach(menu);
  return { control, menu, calls };
}

test('ModeChoice is co-op until player 2 joins, toggles only then, and resets when player 2 leaves', () => {
  const choice = new ModeChoice();
  assert.equal(choice.mode, 'coop');
  assert.equal(choice.toggle(), false);
  assert.equal(choice.mode, 'coop');
  choice.setJoined(true);
  assert.equal(choice.toggle(), true);
  assert.equal(choice.mode, 'versus');
  choice.setJoined(false);
  assert.equal(choice.mode, 'coop');
  choice.setJoined(true);
  assert.equal(choice.mode, 'coop', 'a rejoin starts at co-op again');
});

test('modeItemView ghosts SOLO without player 2 and names the pick with player 2', () => {
  const choice = new ModeChoice();
  assert.deepEqual(modeItemView(choice), { label: 'MODE: SOLO', enabled: false });
  choice.setJoined(true);
  assert.deepEqual(modeItemView(choice), { label: 'MODE: CO-OP', enabled: true });
  choice.toggle();
  assert.deepEqual(modeItemView(choice), { label: 'MODE: VERSUS', enabled: true });
});

test('the title always lays out the mode item, ghosted and skipped by the focus ring without player 2', () => {
  const { menu, calls } = titleWithMode();
  const button = modeButton(menu);
  assert.equal(button.textContent, 'MODE: SOLO');
  assert.equal(button.attributes['aria-disabled'], 'true');
  assert.ok(button.classList.contains('menu-disabled'));
  menu.handleAction('down');
  assert.equal(focusedLabel(menu), 'Lab', 'down from Play skips the ghosted item');
  menu.handleAction('up');
  assert.equal(focusedLabel(menu), 'Play');
  button.fire('pointerenter');
  assert.equal(focusedLabel(menu), 'Play', 'hovering a ghosted item does not take the focus');
  button.fire('click');
  assert.equal(button.textContent, 'MODE: SOLO');
  assert.equal(calls.start, 0, 'a click on the ghosted item does not start the run');
});

test('with player 2 the mode item steps co-op, versus, hives by confirm and by click, and never starts the run', () => {
  const { control, menu, calls } = titleWithMode();
  control.update({ joined: true });
  const button = modeButton(menu);
  assert.equal(button.textContent, 'MODE: CO-OP');
  assert.equal(button.attributes['aria-disabled'], 'false');
  menu.handleAction('down');
  assert.equal(focusedLabel(menu), 'MODE: CO-OP');
  menu.handleAction('confirm');
  assert.equal(control.mode, 'versus');
  assert.equal(button.textContent, 'MODE: VERSUS');
  button.fire('click');
  assert.equal(control.mode, 'hives');
  assert.equal(button.textContent, 'MODE: HIVES');
  button.fire('click');
  assert.equal(control.mode, 'coop');
  assert.equal(calls.start, 0);
  menu.handleAction('confirm');
  assert.equal(control.mode, 'versus');
  menu.handleAction('down');
  assert.equal(focusedLabel(menu), 'Lab');
});

test('player 2 leaving ghosts the item, hands its focus back to Play and returns to co-op', () => {
  const { control, menu } = titleWithMode();
  control.update({ joined: true });
  menu.handleAction('down');
  menu.handleAction('confirm');
  assert.equal(control.mode, 'versus');
  control.update({ joined: false });
  assert.equal(control.mode, 'coop');
  assert.equal(modeButton(menu).textContent, 'MODE: SOLO');
  assert.equal(focusedLabel(menu), 'Play');
});

test('setItem throws for an unknown id', () => {
  const { menu } = titleWithMode();
  assert.throws(() => menu.setItem('missing', { label: 'x', enabled: true }), RangeError);
  assert.equal(MODE_ITEM_ID, 'mode');
});

test('gameOverBanner is GAME OVER outside versus and names the winner in its seat color', () => {
  assert.deepEqual(gameOverBanner(null), { title: 'GAME OVER', color: null });
  assert.deepEqual(gameOverBanner(undefined), { title: 'GAME OVER', color: null });
  assert.deepEqual(gameOverBanner({ winner: 1, draw: false }), { title: 'PLAYER 2 WINS', color: SEAT_COLORS[1].css });
  assert.deepEqual(gameOverBanner({ winner: 0, draw: false }), { title: 'PLAYER 1 WINS', color: SEAT_COLORS[0].css });
  assert.deepEqual(gameOverBanner({ winner: null, draw: true }), { title: 'DRAW', color: null });
});
