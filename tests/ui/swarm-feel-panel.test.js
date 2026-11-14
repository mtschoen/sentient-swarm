import test from 'node:test';
import assert from 'node:assert/strict';
import { createSwarmFeelGroup } from '../../src/ui/swarm-feel-panel.js';
import { BEES_FEEL, FISH_FEEL } from '../../src/game/swarm-feel.js';

function createFakeDocument() {
  const make = (tagName) => {
    const classes = new Set();
    const listeners = {};
    return {
      tagName: tagName.toUpperCase(), textContent: '', children: [], value: '', attributes: {},
      classList: { add: (name) => classes.add(name) },
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...nodes) { this.children.push(...nodes); },
      addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
      fire(type) { (listeners[type] ?? []).forEach((listener) => listener({})); },
    };
  };
  return { createElement: make };
}

function find(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  for (const child of node.children) find(child, predicate, found);
  return found;
}

function setup() {
  const feel = { ...BEES_FEEL };
  const changes = [];
  const group = createSwarmFeelGroup({ feel, onChange: (value) => changes.push({ ...value }), documentObject: createFakeDocument() });
  const slider = (key) => find(group.element, (node) => node.attributes['data-swarm-feel-dial'] === key)[0];
  const readout = (key) => find(group.element, (node) => node.attributes['data-swarm-feel-readout'] === key)[0];
  const query = find(group.element, (node) => 'data-swarm-feel-query' in node.attributes)[0];
  const button = (text) => find(group.element, (node) => node.tagName === 'BUTTON' && node.textContent === text)[0];
  return { feel, changes, slider, readout, query, button };
}

test('the group shows each dial value and the query string for the current values', () => {
  const { slider, readout, query } = setup();
  assert.equal(slider('tightness').value, String(BEES_FEEL.tightness));
  assert.equal(readout('alignment').textContent, '0.10');
  assert.equal(query.textContent, '?swarmAlignment=0.1&swarmTightness=2&swarmBuzz=1.5&swarmFollow=1');
});

test('moving a slider updates the live feel object, the readout, the query and calls onChange', () => {
  const { feel, changes, slider, readout, query } = setup();
  slider('buzz').value = '2.5';
  slider('buzz').fire('input');
  assert.equal(feel.buzz, 2.5);
  assert.equal(readout('buzz').textContent, '2.50');
  assert.match(query.textContent, /swarmBuzz=2\.5&/);
  assert.equal(changes.length, 1);
});

test('the fish and bees buttons reset every dial in the same live object', () => {
  const { feel, changes, button, query } = setup();
  button('Fish (current)').fire('click');
  assert.deepEqual(feel, { ...FISH_FEEL });
  assert.equal(query.textContent, '?swarmAlignment=1&swarmTightness=0&swarmBuzz=0&swarmFollow=0');
  button('Bees (default)').fire('click');
  assert.deepEqual(feel, { ...BEES_FEEL });
  assert.equal(changes.length, 2);
});
