import test from 'node:test';
import assert from 'node:assert/strict';
import { createMenu, createPauseMenu } from '../../src/ui/menu.js';

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
const button = (menu, label) => allButtons(menu.element).find((node) => node.textContent === label);

function titleMenu() {
  const calls = { start: 0, lab: 0, settings: 0 };
  const menu = createMenu({
    onStart: () => { calls.start += 1; },
    onLab: () => { calls.lab += 1; },
    onSettings: () => { calls.settings += 1; },
    documentObject: createFakeDocument(),
  });
  return { menu, calls };
}

test('Play calls onStart once per click, and Lab and Settings do not start play', () => {
  const { menu, calls } = titleMenu();
  button(menu, 'Play').fire('click');
  assert.equal(calls.start, 1);
  button(menu, 'Lab').fire('click');
  button(menu, 'Settings').fire('click');
  assert.deepEqual(calls, { start: 1, lab: 1, settings: 1 });
});

test('a tap on the arena behind the buttons starts play, a click bubbling from a button does not double up', () => {
  const { menu, calls } = titleMenu();
  menu.element.fire('click', { target: menu.element });
  assert.equal(calls.start, 1);
  menu.element.fire('click', { target: button(menu, 'Lab') });
  assert.equal(calls.start, 1);
});

test('keyboard and gamepad actions move a wrapping focus ring and confirm the focused item', () => {
  const { menu, calls } = titleMenu();
  assert.equal(focusedLabel(menu), 'Play');
  menu.handleAction('down');
  assert.equal(focusedLabel(menu), 'Lab');
  menu.handleAction('down');
  assert.equal(focusedLabel(menu), 'Settings');
  menu.handleAction('down');
  assert.equal(focusedLabel(menu), 'Play', 'wraps');
  menu.handleAction('up');
  assert.equal(focusedLabel(menu), 'Settings');
  menu.handleAction('confirm');
  assert.deepEqual(calls, { start: 0, lab: 0, settings: 1 });
  menu.handleAction('up');
  menu.handleAction('up');
  menu.handleAction('confirm');
  assert.equal(calls.start, 1);
});

test('any other face button starts play from the title', () => {
  const { menu, calls } = titleMenu();
  menu.handleAction('altConfirm');
  assert.equal(calls.start, 1);
});

test('show resets the focus to the first item and hide hides the element', () => {
  const { menu } = titleMenu();
  menu.handleAction('down');
  menu.hide();
  assert.equal(menu.element.hidden, true);
  assert.equal(menu.visible, false);
  menu.show();
  assert.equal(menu.element.hidden, false);
  assert.equal(focusedLabel(menu), 'Play');
});

test('a hidden menu ignores actions and clicks', () => {
  const { menu, calls } = titleMenu();
  menu.hide();
  menu.handleAction('confirm');
  button(menu, 'Play').fire('click');
  assert.equal(calls.start, 0);
});

test('the pause menu lists Resume, Settings, Restart run and Quit to title, and back resumes', () => {
  const calls = [];
  const menu = createPauseMenu({
    onResume: () => calls.push('resume'),
    onSettings: () => calls.push('settings'),
    onRestart: () => calls.push('restart'),
    onQuit: () => calls.push('quit'),
    documentObject: createFakeDocument(),
  });
  for (const label of ['Resume', 'Settings', 'Restart run', 'Quit to title']) assert.ok(button(menu, label), label);
  assert.equal(focusedLabel(menu), 'Resume');
  menu.handleAction('down');
  menu.handleAction('down');
  menu.handleAction('confirm');
  menu.handleAction('down');
  menu.handleAction('confirm');
  menu.handleAction('back');
  assert.deepEqual(calls, ['restart', 'quit', 'resume']);
});

test('Enter or Space after hovering Lab still means Play, and arrow keys take over from the hover', () => {
  const { menu, calls } = titleMenu();
  button(menu, 'Lab').fire('pointerenter');
  assert.equal(focusedLabel(menu), 'Lab');
  menu.handleAction('confirm');
  assert.deepEqual(calls, { start: 1, lab: 0, settings: 0 });
  menu.show();
  button(menu, 'Lab').fire('pointerenter');
  menu.handleAction('down');
  menu.handleAction('confirm');
  assert.equal(calls.settings, 1, 'the keyboard moves from the hovered item and confirms the focused one');
});
