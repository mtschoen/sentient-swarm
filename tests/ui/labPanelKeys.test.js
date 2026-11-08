import test from 'node:test';
import assert from 'node:assert/strict';
import { createLabPanel } from '../../src/ui/labPanel.js';

// A forgiving fake DOM: every element records listeners and accepts the properties the panel sets.
function createFakeDocument() {
  const make = (tagName) => {
    const listeners = {};
    const element = {
      tagName: tagName.toUpperCase(), children: [], dataset: {}, style: {}, attributes: {}, hidden: false, value: '', textContent: '',
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      remove() {},
      blur() {},
      addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
    };
    return element;
  };
  return { createElement: make, body: { append() {} } };
}

function setup() {
  const listeners = {};
  const windowObject = {
    addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
    removeEventListener() {},
  };
  const calls = { enter: 0 };
  const lab = {
    active: false,
    canEnter: true,
    enter() { calls.enter += 1; },
    attachPanel() {},
    game: { simulationRate: 'full' },
    context: {},
  };
  createLabPanel({
    lab,
    getSimulation: () => ({}),
    onCapacityChange: () => {},
    capacityOptions: [65536],
    windowObject,
    documentObject: createFakeDocument(),
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  const press = (target) => (listeners.keydown ?? []).forEach((listener) => listener({ code: 'Backquote', repeat: false, target }));
  return { press, calls };
}

test('backquote in a lab number field does not toggle the lab', () => {
  const { press, calls } = setup();
  press({ tagName: 'INPUT', type: 'number' });
  assert.equal(calls.enter, 0);
  press({ tagName: 'BODY' });
  assert.equal(calls.enter, 1);
});
