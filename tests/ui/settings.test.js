import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_SLIDERS, createSettingsPanel, killBurstParticlesFor, shakeMultiplierFor, trailDecayFor, bloomStrengthFor,
} from '../../src/ui/settings.js';
import { DEFAULT_SETTINGS, SETTING_RANGES } from '../../src/settings/storage.js';
import { PRESETS, PRESET_ORDER } from '../../src/settings/presets.js';

function createFakeDocument() {
  const make = (tagName) => {
    const classes = new Set();
    const listeners = {};
    return {
      tagName: tagName.toUpperCase(), textContent: '', children: [], hidden: false, disabled: false, value: '', checked: false,
      style: { setProperty() {} },
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      blurs: 0,
      blur() { this.blurs += 1; },
      append(...nodes) { this.children.push(...nodes); },
      addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
      fire(type, event = {}) { (listeners[type] ?? []).forEach((listener) => listener({ preventDefault() {}, stopPropagation() {}, ...event })); },
    };
  };
  return { createElement: make };
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) if (typeof child !== 'string') walk(child, visit);
}
const byName = (root, name) => {
  let found = null;
  walk(root, (node) => { if (node.attributes?.['data-setting'] === name) found = node; });
  return found;
};
const readout = (root, name) => {
  let found = null;
  walk(root, (node) => { if (node.attributes?.['data-readout'] === name) found = node; });
  return found;
};

function setup({ stored = {}, canChangePreset = true, documentObject = createFakeDocument() } = {}) {
  const saves = [];
  const changes = [];
  const probeRuns = [];
  const state = { ...DEFAULT_SETTINGS, ...stored };
  const store = { load: () => ({ ...state }), save: (settings) => { saves.push(settings); Object.assign(state, settings); } };
  const panel = createSettingsPanel({
    store, onChange: (settings) => changes.push(settings), presets: PRESET_ORDER.map((name) => ({ name, ...PRESETS[name] })),
    onRerunProbe: () => probeRuns.push(true), canChangePreset, documentObject,
  });
  return { panel, saves, changes, probeRuns };
}

test('sliders read 100% at the default', () => {
  const { panel } = setup();
  for (const name of ['effects', 'shake', 'trails']) assert.equal(readout(panel.element, name).textContent, '100%', name);
  assert.equal(byName(panel.element, 'effects').attributes.min, '0');
  assert.equal(byName(panel.element, 'effects').attributes.max, '300');
  assert.equal(readout(panel.element, 'stickDeadZone').textContent, '15%');
});

test('changing a slider calls onChange with the new value and saves once', () => {
  const { panel, saves, changes } = setup();
  const slider = byName(panel.element, 'effects');
  slider.value = '150';
  slider.fire('input');
  assert.equal(saves.length, 1);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].effects, 150);
  assert.equal(saves[0].effects, 150);
  assert.equal(readout(panel.element, 'effects').textContent, '150%');
});

test('fractional settings are stored as fractions', () => {
  const { panel, changes } = setup();
  const slider = byName(panel.element, 'stickDeadZone');
  slider.value = '30';
  slider.fire('input');
  assert.equal(changes[0].stickDeadZone, 0.3);
});

test('checkboxes, preset select and re-run probe', () => {
  const { panel, changes, probeRuns } = setup();
  const reduced = byName(panel.element, 'reducedMotion');
  reduced.checked = true;
  reduced.fire('change');
  assert.equal(changes.at(-1).reducedMotion, true);
  const rumble = byName(panel.element, 'rumble');
  assert.equal(rumble.checked, true);
  rumble.checked = false;
  rumble.fire('change');
  assert.equal(changes.at(-1).rumble, false);
  const preset = byName(panel.element, 'preset');
  preset.value = 'desktop';
  preset.fire('change');
  assert.equal(changes.at(-1).preset, 'desktop');
  byName(panel.element, 'rerunProbe').fire('click');
  assert.equal(probeRuns.length, 1);
});

test('the preset select is disabled when the preset cannot change', () => {
  assert.equal(byName(setup({ canChangePreset: false }).panel.element, 'preset').disabled, true);
});

test('open, close and isOpen; open reloads the stored values', () => {
  const { panel } = setup({ stored: { effects: 220 } });
  assert.equal(panel.isOpen, false);
  assert.equal(panel.element.hidden, true);
  panel.open();
  assert.equal(panel.isOpen, true);
  assert.equal(panel.element.hidden, false);
  assert.equal(readout(panel.element, 'effects').textContent, '220%');
  panel.close();
  assert.equal(panel.isOpen, false);
});

test('mappings read 100% as the tuned default', () => {
  assert.equal(trailDecayFor(DEFAULT_SETTINGS), 0.6);
  assert.equal(trailDecayFor({ ...DEFAULT_SETTINGS, trails: 0 }), 0);
  assert.ok(trailDecayFor({ ...DEFAULT_SETTINGS, trails: 300 }) < 1);
  assert.ok(trailDecayFor({ ...DEFAULT_SETTINGS, trails: 200 }) > 0.6);
  assert.equal(trailDecayFor({ ...DEFAULT_SETTINGS, reducedMotion: true }), 0);
  assert.equal(killBurstParticlesFor(DEFAULT_SETTINGS), 12);
  assert.equal(killBurstParticlesFor({ ...DEFAULT_SETTINGS, effects: 300 }), 36);
  assert.equal(killBurstParticlesFor({ ...DEFAULT_SETTINGS, effects: 0 }), 0);
  assert.equal(killBurstParticlesFor({ ...DEFAULT_SETTINGS, reducedMotion: true }), 6);
  assert.equal(shakeMultiplierFor(DEFAULT_SETTINGS), 1);
  assert.equal(shakeMultiplierFor({ ...DEFAULT_SETTINGS, shake: 300 }), 3);
  assert.equal(shakeMultiplierFor({ ...DEFAULT_SETTINGS, reducedMotion: true }), 0.5);
  assert.equal(bloomStrengthFor(DEFAULT_SETTINGS), 0.8);
  assert.ok(Math.abs(bloomStrengthFor({ ...DEFAULT_SETTINGS, effects: 150 }) - 1.2) < 1e-9);
});

test('the select and checkboxes give up focus once changed (sliders only on a pointer change)', () => {
  const { panel } = setup();
  for (const name of ['preset', 'reducedMotion']) {
    const control = byName(panel.element, name);
    control.fire('change');
    assert.equal(control.blurs, 1, name);
  }
});

test('close blurs the focused element', () => {
  const documentObject = createFakeDocument();
  const { panel } = setup({ documentObject });
  panel.open();
  const focused = byName(panel.element, 'rerunProbe');
  documentObject.activeElement = focused;
  panel.close();
  assert.equal(panel.isOpen, false);
  assert.equal(focused.blurs, 1);
});

test('arrow keys on a focused slider keep its focus; a pointer-driven change releases it', () => {
  const { panel, changes } = setup();
  const slider = byName(panel.element, 'music');
  slider.value = '70';
  slider.fire('input');
  slider.fire('change');
  assert.equal(slider.blurs, 0, 'a keyboard step keeps focus');
  assert.equal(changes.at(-1).music, 70);
  slider.fire('pointerdown');
  slider.value = '60';
  slider.fire('input');
  slider.fire('change');
  assert.equal(slider.blurs, 1, 'a pointer drag releases focus');
  slider.value = '55';
  slider.fire('input');
  slider.fire('change');
  assert.equal(slider.blurs, 1, 'the next keyboard step keeps focus again');
});

test('SETTING_RANGES matches the slider ranges in stored units and every ranged setting has a slider', () => {
  const sliderKeys = SETTINGS_SLIDERS.map((slider) => slider.key).sort();
  assert.deepEqual(sliderKeys, Object.keys(SETTING_RANGES).sort());
  for (const slider of SETTINGS_SLIDERS) {
    assert.deepEqual(SETTING_RANGES[slider.key], [slider.minimum / slider.scale, slider.maximum / slider.scale], slider.key);
  }
});
