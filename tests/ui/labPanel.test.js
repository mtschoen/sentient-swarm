import test from 'node:test';
import assert from 'node:assert/strict';
import { createLabPanel } from '../../src/ui/labPanel.js';
import { LAB_KNOB_DEFAULTS, captureMix, mixFromHash } from '../../src/ui/lab.js';
import { BUNDLED_MIXES, SAVED_MIXES_KEY, listMixes } from '../../src/ui/labPresets.js';
import { SpawnPressure } from '../../src/sim/spawner.js';
import { SpawnDirector } from '../../src/sim/spawn-director.js';
import { defaultMatrix, defaultSpecies, normalizeShares } from '../../src/sim/species.js';
import { DEFAULT_RENDER_SETTINGS } from '../../src/render/renderer.js';
import { SPECIES_COUNT } from '../../src/sim/layout.js';
import { TimeWarp } from '../../src/game/time-warp.js';

const CAPACITY = 65536;

// A DOM fake that keeps the tree (parent links, children), listeners the test can fire, and the
// properties the panel sets.
function createFakeDocument() {
  const make = (tagName) => {
    const listeners = {};
    const element = {
      tagName: tagName.toUpperCase(), children: [], parent: null, dataset: {}, style: {}, attributes: {}, hidden: false, value: '', textContent: '', blurs: 0, removed: false,
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } },
      replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
      remove() { this.removed = true; },
      blur() { this.blurs += 1; },
      addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
      fire(type, event = {}) { (listeners[type] ?? []).forEach((listener) => listener(event)); },
    };
    return element;
  };
  const body = make('body');
  return { createElement: make, body };
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function findAll(root, predicate) {
  const found = [];
  walk(root, (node) => { if (predicate(node)) found.push(node); });
  return found;
}

function createStore() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
  };
}

function createContext() {
  const simulation = {
    capacity: CAPACITY,
    neighborRadius: 0.1,
    shares: new Float32Array(SPECIES_COUNT).fill(1 / SPECIES_COUNT),
    species: defaultSpecies(),
    matrix: defaultMatrix(),
    sameSpeciesCohesion: true,
    spawnBandWidth: 0.6,
    spawnDensityBias: 0.5,
    killBurstParticles: 12,
    killFragmentParticles: 3,
    deathFloodParticles: 480,
    wallMargin: 0.5,
    wallStiffness: 40,
    comfortRadius: 1,
    coarseFieldPressure: true,
    setSpeciesCalls: 0,
    setShares(shares) { this.shares = normalizeShares(shares); },
    setSpecies(rows, matrix) { this.species = rows; this.matrix = matrix; this.setSpeciesCalls += 1; },
    setSameSpeciesCohesion(enabled) { this.sameSpeciesCohesion = enabled; },
    setSpawnBandWidth(value) { this.spawnBandWidth = value; },
    setSpawnDensityBias(value) { this.spawnDensityBias = value; },
    setKillBurstParticles(value) { this.killBurstParticles = value; },
    setKillFragmentParticles(value) { this.killFragmentParticles = value; },
    setDeathFloodParticles(value) { this.deathFloodParticles = value; },
    setWallMargin(value) { this.wallMargin = value; },
    setWallStiffness(value) { this.wallStiffness = value; },
    setComfortRadius(value) { this.comfortRadius = value; },
    setCoarseFieldPressure(enabled) { this.coarseFieldPressure = enabled; },
  };
  const game = {
    simulation,
    spawnPressure: new SpawnPressure({ capacity: CAPACITY }),
    spawnDirector: new SpawnDirector({ random: () => 0.5 }),
    projectiles: {
      baseKillBudget: 0,
      beamSweepThresholdDegrees: 0,
      setBaseKillBudget(value) { this.baseKillBudget = value; },
      setBeamSweepThreshold(value) { this.beamSweepThresholdDegrees = value; },
    },
    beamTurnRevolutionsPerSecond: 1.5,
    setBeamTurnRate(value) { this.beamTurnRevolutionsPerSecond = value; },
    pickupBlastRadius: 1.5,
    setPickupBlastRadius(value) { this.pickupBlastRadius = value; },
    timeWarp: new TimeWarp(),
    simulationRate: 'full',
    setSimulationRate(rate) { this.simulationRate = rate; },
    watching: false,
    setWatch() {},
  };
  const renderer = {
    settings: { ...DEFAULT_RENDER_SETTINGS },
    particles: { particleDevicePixels: 4, setParticleDevicePixels(value) { this.particleDevicePixels = value; } },
  };
  return { game, renderer, lab: { watchAliveFraction: LAB_KNOB_DEFAULTS.watchAliveFraction } };
}

function setup({ withArm = true, stats = null, onCapacityChange } = {}) {
  const documentObject = createFakeDocument();
  const windowListeners = {};
  const history = { replaced: [], replaceState(...args) { this.replaced.push(args); } };
  const clipboard = { written: [], writeText(text) { this.written.push(text); return Promise.reject(new Error('denied')); } };
  const windowObject = {
    location: { href: 'https://example.test/game?x=1' },
    history,
    navigator: { clipboard },
    __murmuration: { stats },
    addEventListener(type, listener) { (windowListeners[type] ??= []).push(listener); },
    removeEventListener(type, listener) { windowListeners[type] = (windowListeners[type] ?? []).filter((entry) => entry !== listener); },
  };
  const context = createContext();
  const calls = { setMode: [], leave: 0, enter: 0, applied: [], attached: null };
  const lab = {
    active: true,
    canEnter: true,
    context,
    game: context.game,
    setMode: (mode) => calls.setMode.push(mode),
    leave: () => { calls.leave += 1; },
    enter: () => { calls.enter += 1; },
    apply: (mix) => calls.applied.push(mix),
    capture: () => captureMix(context),
    attachPanel: (panel) => { calls.attached = panel; },
  };
  const frames = { callbacks: [], cancelled: [], nextHandle: 1 };
  const capacityRequests = [];
  const store = createStore();
  const armed = [];
  const panel = createLabPanel({
    lab,
    getSimulation: () => context.game.simulation,
    onCapacityChange: onCapacityChange ?? ((...args) => { capacityRequests.push(args); return Promise.resolve(true); }),
    capacityOptions: [65536, 131072],
    onArmWeapon: withArm ? (name, tier) => armed.push([name, tier]) : null,
    store,
    windowObject,
    documentObject,
    requestFrame: (callback) => { frames.callbacks.push(callback); return frames.nextHandle++; },
    cancelFrame: (handle) => frames.cancelled.push(handle),
  });
  const root = panel.element;
  const tab = documentObject.body.children[0];
  const knob = (name) => findAll(root, (node) => node.tagName === 'INPUT' && node.dataset.knob === name);
  const byClass = (className) => findAll(root, (node) => node.className === className)[0];
  const rowOutput = (input) => input.parent.children[2];
  const select = (firstOptionText) => findAll(root, (node) => node.tagName === 'SELECT' && node.children[0]?.textContent === firstOptionText)[0];
  const keydown = (event) => (windowListeners.keydown ?? []).forEach((listener) => listener(event));
  const fieldset = findAll(root, (node) => node.tagName === 'FIELDSET')[0];
  return { panel, root, tab, context, lab, calls, frames, capacityRequests, store, armed, windowObject, windowListeners, history, clipboard, knob, byClass, rowOutput, select, keydown, fieldset };
}

test('the panel and its tab mount hidden and exclusive to touch, and attach themselves to the lab', () => {
  const { panel, root, tab, calls } = setup();
  assert.equal(root.hidden, true);
  assert.equal(panel.isOpen, false);
  assert.ok('data-touch-exclusive' in root.attributes && 'data-touch-exclusive' in tab.attributes);
  assert.equal(calls.attached, panel);
});

test('open starts the readout loop, refreshes the controls and close cancels the frame', () => {
  const { panel, root, tab, frames, byClass } = setup({ stats: { aliveTotal: 1234, alivePerSpecies: [1, 2, 3, 4, 5] } });
  panel.open();
  assert.equal(panel.isOpen, true);
  assert.equal(tab.hidden, true);
  assert.equal(frames.callbacks.length, 1);
  assert.match(root.children.at(-1).textContent, /alive: 1,234/);
  // Opening an open panel starts no second loop.
  panel.open();
  assert.equal(frames.callbacks.length, 1);
  // The readout refreshes every 15th frame and the loop reschedules itself.
  let timestamp = 0;
  for (let index = 0; index < 15; index += 1) frames.callbacks.at(-1)((timestamp += 10));
  assert.equal(frames.callbacks.length, 16);
  assert.match(root.children.at(-1).textContent, /frames per second: 100\.0/);
  assert.equal(byClass('lab-status').hidden, true);
  panel.close();
  assert.equal(panel.isOpen, false);
  assert.deepEqual(frames.cancelled, [16]);
  assert.equal(tab.hidden, true, 'close hides the tab as well');
});

test('the readout says it is waiting when the page has no stats yet', () => {
  const { panel, root } = setup();
  panel.open();
  assert.match(root.children.at(-1).textContent, /waiting for stats/);
});

test('header buttons switch the mode, fold the panel into the tab and leave the lab', () => {
  const { panel, tab, byClass, calls } = setup();
  panel.open();
  byClass('lab-mode lab-watch').fire('click');
  byClass('lab-mode lab-play').fire('click');
  assert.deepEqual(calls.setMode, ['watch', 'play']);
  byClass('lab-hide').fire('click');
  assert.equal(panel.isOpen, false);
  assert.equal(tab.hidden, false, 'the folded lab leaves a tab');
  tab.fire('click');
  assert.equal(panel.isOpen, true);
  assert.equal(tab.hidden, true);
  byClass('lab-leave').fire('click');
  assert.equal(calls.leave, 1);
});

test('setMode marks the pressed mode button', () => {
  const { panel, byClass } = setup();
  panel.setMode('play');
  assert.equal(byClass('lab-mode lab-watch').attributes['aria-pressed'], 'false');
  assert.equal(byClass('lab-mode lab-play').attributes['aria-pressed'], 'true');
  panel.setMode('watch');
  assert.equal(byClass('lab-mode lab-watch').attributes['aria-pressed'], 'true');
});

test('picking a mix applies it, reports it and resets the select; the blank choice applies nothing', () => {
  const { byClass, calls } = setup();
  const mixSelect = byClass('lab-mixes');
  assert.deepEqual(mixSelect.children.map((option) => option.value), ['', ...Object.keys(BUNDLED_MIXES)]);
  mixSelect.value = 'latticeStorm';
  mixSelect.fire('change');
  assert.deepEqual(calls.applied, [BUNDLED_MIXES.latticeStorm]);
  assert.equal(byClass('lab-status').textContent, 'Applied latticeStorm.');
  assert.equal(byClass('lab-status').hidden, false);
  assert.equal(mixSelect.value, '');
  assert.equal(mixSelect.blurs, 1);
  mixSelect.value = '';
  mixSelect.fire('change');
  assert.equal(calls.applied.length, 1);
});

test('Save stores the captured mix under a new name and refuses a bundled name', () => {
  const { byClass, store } = setup();
  const nameInput = byClass('lab-name');
  nameInput.value = '  my mix ';
  byClass('lab-save').fire('click');
  assert.equal(byClass('lab-status').textContent, 'Saved my mix.');
  assert.deepEqual(listMixes(store), [...Object.keys(BUNDLED_MIXES), 'my mix']);
  assert.ok(store.getItem(SAVED_MIXES_KEY).includes('my mix'));
  assert.equal(byClass('lab-mixes').children.at(-1).value, 'my mix', 'the list gains the saved name');
  nameInput.value = 'default';
  byClass('lab-save').fire('click');
  assert.match(byClass('lab-status').textContent, /^Not saved/);
  assert.equal(listMixes(store).filter((name) => name === 'default').length, 1);
});

test('Share writes the mix into the URL hash, the share field and the clipboard, tolerating a refused clipboard', async () => {
  const { byClass, history, clipboard } = setup();
  byClass('lab-share').fire('click');
  await new Promise((resolve) => setImmediate(resolve));
  const [state, title, href] = history.replaced[0];
  assert.equal(state, null);
  assert.equal(title, '');
  assert.match(href, /^https:\/\/example\.test\/game\?x=1#mix=/);
  assert.equal(byClass('lab-share-url').value, href);
  assert.deepEqual(clipboard.written, [href]);
  const { present, mix } = mixFromHash(new URL(href).hash);
  assert.equal(present, true);
  assert.deepEqual(mix, captureMix(createContext()));
  assert.match(byClass('lab-status').textContent, /address bar/);
});

test('Share works without a clipboard', () => {
  const { byClass, windowObject, history } = setup();
  windowObject.navigator = {};
  byClass('lab-share').fire('click');
  assert.equal(history.replaced.length, 1);
});

test('a capacity change disables the controls during the swap and re-enables them after', async () => {
  const { select, fieldset, capacityRequests, context } = setup();
  const capacitySelect = select('65,536');
  assert.deepEqual(capacitySelect.children.map((option) => option.textContent), ['65,536', '131,072']);
  capacitySelect.value = '131072';
  capacitySelect.fire('change');
  assert.equal(fieldset.disabled, true);
  assert.equal(capacitySelect.blurs, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(capacityRequests, [[131072]]);
  assert.equal(fieldset.disabled, false);
  assert.equal(capacitySelect.value, String(context.game.simulation.capacity), 'refresh re-reads the live capacity');
});

test('a rejected capacity swap shows the failure and keeps the panel usable', async () => {
  const { select, fieldset, byClass } = setup({ onCapacityChange: () => Promise.reject(new Error('out of memory')) });
  const capacitySelect = select('65,536');
  capacitySelect.value = '131072';
  capacitySelect.fire('change');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(byClass('lab-status').textContent, 'Capacity 131,072 failed, kept the current simulation: out of memory');
  assert.equal(fieldset.disabled, false);
});

test('the neighbor radius slider swaps the simulation only when released', async () => {
  const { panel, knob, capacityRequests, rowOutput } = setup();
  panel.refresh();
  const [input] = knob('neighbor radius');
  assert.equal(input.value, '0.1');
  assert.equal(rowOutput(input).textContent, '0.10');
  input.value = '0.2';
  input.fire('input');
  assert.equal(rowOutput(input).textContent, '0.20');
  assert.deepEqual(capacityRequests, []);
  input.fire('change');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(capacityRequests, [[CAPACITY, { neighborRadius: 0.2 }]]);
  assert.equal(input.blurs, 1);
});

test('the rate select and the same-species checkbox write to the game and the simulation', () => {
  const { select, root, context } = setup();
  const rateSelect = select('full rate');
  rateSelect.value = 'half';
  rateSelect.fire('change');
  assert.equal(context.game.simulationRate, 'half');
  assert.equal(rateSelect.blurs, 1);
  const label = findAll(root, (node) => node.tagName === 'LABEL' && node.children[0]?.textContent === 'same-species cohesion')[0];
  const checkbox = label.children[1];
  checkbox.checked = false;
  checkbox.fire('change');
  assert.equal(context.game.simulation.sameSpeciesCohesion, false);
  assert.equal(checkbox.blurs, 1);
});

test('a knob slider shows its value, previews while dragging and commits a clamped write', () => {
  const { panel, knob, rowOutput, context } = setup();
  panel.refresh();
  const [input] = knob('baseKillBudget');
  assert.equal(input.value, '0');
  input.value = '9999';
  input.fire('input');
  assert.equal(context.game.projectiles.baseKillBudget, 64, 'clamped to the slider maximum');
  assert.equal(rowOutput(input).textContent, '64');
  input.fire('change');
  assert.equal(input.blurs, 1);
  const [trailDecay] = knob('trailDecay');
  trailDecay.value = '0.5';
  trailDecay.fire('input');
  assert.equal(context.renderer.settings.trailDecay, 0.5);
  assert.equal(rowOutput(trailDecay).textContent, '0.50');
  panel.refresh();
  const [shipSize] = knob('shipArenaFraction');
  assert.match(rowOutput(shipSize).textContent, /^0\.\d{3}$/, 'a step under 0.01 shows three decimals');
});

test('a toggle knob is a checkbox that writes 0 or 1 and reads back', () => {
  const { panel, knob, context } = setup();
  const [checkbox] = knob('coarseFieldPressure');
  panel.refresh();
  assert.equal(checkbox.checked, true);
  checkbox.checked = false;
  checkbox.fire('change');
  assert.equal(context.game.simulation.coarseFieldPressure, false);
  assert.equal(checkbox.blurs, 1);
  panel.refresh();
  assert.equal(checkbox.checked, false);
});

test('a throwing write shows its message in the status line instead of escaping', () => {
  const { knob, context, byClass } = setup();
  context.game.projectiles.setBaseKillBudget = () => { throw new Error('budget refused'); };
  const [input] = knob('baseKillBudget');
  input.value = '3';
  input.fire('input');
  assert.equal(byClass('lab-status').textContent, 'budget refused');
  assert.equal(byClass('lab-status').hidden, false);
});

test('showStatus with empty text hides the line again', () => {
  const { panel, byClass } = setup();
  panel.showStatus('hello');
  assert.equal(byClass('lab-status').hidden, false);
  panel.showStatus('');
  assert.equal(byClass('lab-status').hidden, true);
});

test('a share slider rewrites that species share through setShares, which normalizes', () => {
  const { knob, context } = setup();
  const [firstShare] = knob('Chaser');
  firstShare.value = '1';
  firstShare.fire('input');
  const shares = context.game.simulation.shares;
  assert.ok(shares[0] > 0.2);
  assert.ok(Math.abs(shares.reduce((sum, share) => sum + share, 0) - 1) < 1e-6);
});

test('a species rule slider edits that species row and writes the table back', () => {
  const { knob, context } = setup();
  const seekSliders = knob('seek');
  assert.equal(seekSliders.length, SPECIES_COUNT);
  seekSliders[2].value = '1.5';
  seekSliders[2].fire('input');
  assert.equal(context.game.simulation.species[2].seek, 1.5);
  assert.equal(context.game.simulation.setSpeciesCalls, 1);
});

test('a matrix cell edits one entry clamped to plus or minus 4 and ignores empty or non-numeric text', () => {
  const { root, context } = setup();
  const cells = findAll(root, (node) => node.dataset.matrix !== undefined);
  assert.equal(cells.length, SPECIES_COUNT * SPECIES_COUNT);
  const cell = cells[7];
  cell.value = '9';
  cell.fire('input');
  assert.equal(context.game.simulation.matrix[7], 4);
  cell.value = '-0.5';
  cell.fire('input');
  assert.equal(context.game.simulation.matrix[7], -0.5);
  const calls = context.game.simulation.setSpeciesCalls;
  for (const text of ['', 'abc']) {
    cell.value = text;
    cell.fire('input');
  }
  assert.equal(context.game.simulation.setSpeciesCalls, calls);
  assert.equal(context.game.simulation.matrix[7], -0.5);
});

test('the arm weapon selects call onArmWeapon with the weapon and tier', () => {
  const { select, armed } = setup();
  const armSelect = select('base');
  const tierSelect = select('tier 1');
  const weaponName = armSelect.children[1].value;
  tierSelect.value = '1';
  armSelect.value = weaponName;
  armSelect.fire('change');
  assert.deepEqual(armed.at(-1), [weaponName, 1]);
  tierSelect.value = '3';
  tierSelect.fire('change');
  assert.deepEqual(armed.at(-1), [weaponName, 3]);
  assert.equal(armSelect.blurs, 2);
  assert.equal(tierSelect.blurs, 2);
});

test('without onArmWeapon the arm weapon section is absent', () => {
  const { root } = setup({ withArm: false });
  assert.equal(findAll(root, (node) => node.tagName === 'H3' && node.textContent === 'Arm weapon (Play)').length, 0);
});

test('the backquote shortcut folds an active lab, enters from the title and ignores repeats', () => {
  const { panel, keydown, calls, lab } = setup();
  panel.open();
  keydown({ code: 'Backquote', repeat: false, target: { tagName: 'BODY' } });
  assert.equal(panel.isOpen, false, 'an open panel folds');
  keydown({ code: 'Backquote', repeat: false, target: { tagName: 'BODY' } });
  assert.equal(panel.isOpen, true, 'a folded panel opens');
  keydown({ code: 'Backquote', repeat: true, target: { tagName: 'BODY' } });
  keydown({ code: 'KeyA', repeat: false, target: { tagName: 'BODY' } });
  assert.equal(panel.isOpen, true);
  lab.active = false;
  keydown({ code: 'Backquote', repeat: false, target: {} });
  assert.equal(calls.enter, 1);
  lab.canEnter = false;
  keydown({ code: 'Backquote', repeat: false, target: {} });
  assert.equal(calls.enter, 1);
});

test('dispose closes the panel, removes the key listener and both elements', () => {
  const { panel, root, tab, windowListeners, frames, keydown, calls, lab } = setup();
  panel.open();
  panel.dispose();
  assert.equal(root.removed && tab.removed, true);
  assert.equal((windowListeners.keydown ?? []).length, 0);
  assert.equal(frames.cancelled.length, 1);
  lab.active = false;
  keydown({ code: 'Backquote', repeat: false, target: {} });
  assert.equal(calls.enter, 0);
});
