// The lab panel (task C6b; the Plan A debug panel grown up): plain DOM, open while the lab mode
// (lab.js LabMode) is active. It is a sibling of the canvas marked data-touch-exclusive, so
// pointer and touch input on it never reaches the game (no shot, no stick). Watch and Play switch
// the lab's mode, Hide folds the panel into a small Lab tab, Title leaves the lab. Mixes: the
// bundled and saved list (applied on pick), Save under a name, Share into the URL hash. Every
// control reads its value live (refresh() after a mix is applied); the panel keeps no copy of the
// species rows, matrix or shares: it edits what getSimulation() holds and writes the change back
// through setSpecies / setShares, so a capacity change (which carries them over) needs no re-sync.
// Styles: lab.css. Laid out for a phone in landscape (844 x 390): scrollable, touch-sized rows.
import { WEAPON_TYPE_NAMES } from '../game/weaponTypes.js';
import { SPECIES_COUNT } from '../sim/layout.js';
import { SPECIES_NAMES } from '../sim/species.js';
import { LAB_KNOB_GROUPS, FramesPerSecond, RENDER_SLIDERS, SHARE_SLIDER, SPECIES_SLIDERS, clampToSpec, describeStats } from './panelModel.js';
import { encodeMix, listMixes, loadMix, saveMix } from './labPresets.js';
import { hashForMix, readKnob, writeKnob } from './lab.js';

const READOUT_INTERVAL_FRAMES = 15;
const MATRIX_STEP = 0.1;
const MATRIX_LIMIT = 4;
const TOGGLE_CODE = 'Backquote';
const ARM_TIERS = [1, 2, 3];
const NEIGHBOR_RADIUS_SLIDER = { label: 'neighbor radius', minimum: 0.05, maximum: 0.3, step: 0.01 };
const TYPING_TAGS = ['INPUT', 'SELECT', 'TEXTAREA'];

function element(documentObject, tagName, properties = {}, children = []) {
  const created = Object.assign(documentObject.createElement(tagName), properties);
  created.append(...children);
  return created;
}

function formatValue(spec, value) {
  if (spec.integer || spec.step >= 1) return String(Math.round(value));
  return Number(value).toFixed(spec.step < 0.01 ? 3 : 2);
}

export function createLabPanel({
  lab,
  getSimulation,
  onCapacityChange,
  capacityOptions,
  onArmWeapon = null,
  store = null,
  windowObject = window,
  documentObject = document,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (handle) => cancelAnimationFrame(handle),
  readStats = () => windowObject.__murmuration?.stats ?? null,
}) {
  const make = (tagName, properties, children) => element(documentObject, tagName, properties, children);
  const root = make('div', { className: 'lab-panel', hidden: true });
  const tab = make('button', { className: 'lab-tab', type: 'button', textContent: 'Lab', hidden: true });
  for (const touchTarget of [root, tab]) touchTarget.setAttribute('data-touch-exclusive', '');
  const readout = make('pre');
  // Every control sits in this fieldset, so disabling it disables them all during a capacity swap.
  const controls = make('fieldset');
  const status = make('p', { className: 'lab-status', hidden: true });
  const framesPerSecond = new FramesPerSecond();
  const syncs = [];
  let frameHandle = null;
  let framesSinceReadout = 0;

  const showStatus = (text) => {
    status.textContent = text;
    status.hidden = text === '';
  };
  const guarded = (action) => {
    try {
      action();
    } catch (error) {
      showStatus(error.message);
    }
  };
  const section = (title) => controls.append(make('h3', { textContent: title }));
  const labeled = (text, ...inputs) => make('label', { className: 'lab-row' }, [make('span', { textContent: text }), ...inputs]);

  // A range slider bound to read() and write(value); returns its row.
  const slider = (spec, read, write, { commitOn = 'input' } = {}) => {
    const input = make('input', { type: 'range', min: spec.minimum, max: spec.maximum, step: spec.step });
    const output = make('output');
    const sync = () => {
      const value = read();
      input.value = String(value);
      output.textContent = formatValue(spec, value);
    };
    input.addEventListener('input', () => { output.textContent = formatValue(spec, clampToSpec(spec, Number(input.value))); });
    input.addEventListener(commitOn, () => guarded(() => write(clampToSpec(spec, Number(input.value)))));
    // Release focus so WASD moves the player again after a slider is used.
    input.addEventListener('change', () => input.blur());
    input.dataset.knob = spec.key ?? spec.label;
    syncs.push(sync);
    return labeled(spec.label, input, output);
  };
  const knobSlider = (spec) => slider(spec, () => readKnob(lab.context, spec), (value) => writeKnob(lab.context, spec, value));

  // Header: mode, hide and leave.
  const watchButton = make('button', { type: 'button', className: 'lab-mode lab-watch', textContent: 'Watch' });
  const playButton = make('button', { type: 'button', className: 'lab-mode lab-play', textContent: 'Play' });
  const hideButton = make('button', { type: 'button', className: 'lab-hide', textContent: 'Hide' });
  const titleButton = make('button', { type: 'button', className: 'lab-leave', textContent: 'Title' });
  watchButton.addEventListener('click', () => lab.setMode('watch'));
  playButton.addEventListener('click', () => lab.setMode('play'));
  hideButton.addEventListener('click', () => setOpen(false));
  titleButton.addEventListener('click', () => lab.leave());
  tab.addEventListener('click', () => setOpen(true));
  const header = make('div', { className: 'lab-header' }, [make('span', { className: 'lab-title', textContent: 'Lab' }), watchButton, playButton, hideButton, titleButton]);

  // Mixes: pick to apply, Save by name, Share into the URL.
  const mixSelect = make('select', { className: 'lab-mixes' });
  const fillMixes = () => {
    mixSelect.replaceChildren(make('option', { value: '', textContent: 'apply a mix...' }), ...listMixes(store).map((name) => make('option', { value: name, textContent: name })));
  };
  mixSelect.addEventListener('change', () => {
    const mix = mixSelect.value === '' ? null : loadMix(store, mixSelect.value);
    if (mix !== null) {
      lab.apply(mix);
      showStatus(`Applied ${mixSelect.value}.`);
    }
    mixSelect.value = '';
    mixSelect.blur();
  });
  const nameInput = make('input', { type: 'text', placeholder: 'mix name', className: 'lab-name' });
  const saveButton = make('button', { type: 'button', className: 'lab-save', textContent: 'Save' });
  saveButton.addEventListener('click', () => {
    const saved = saveMix(store, nameInput.value, lab.capture());
    showStatus(saved ? `Saved ${nameInput.value.trim()}.` : 'Not saved: give a new name (bundled names are taken).');
    if (saved) fillMixes();
  });
  const shareButton = make('button', { type: 'button', textContent: 'Share', className: 'lab-share' });
  const shareOutput = make('input', { type: 'text', readOnly: true, className: 'lab-share-url' });
  shareButton.addEventListener('click', () => {
    const url = new URL(windowObject.location.href);
    url.hash = hashForMix(encodeMix(lab.capture()));
    windowObject.history.replaceState(null, '', url.href);
    shareOutput.value = url.href;
    windowObject.navigator?.clipboard?.writeText?.(url.href)?.catch?.(() => {});
    showStatus('The link to this mix is in the address bar.');
  });
  fillMixes();
  const mixes = make('div', { className: 'lab-mix-block' }, [
    labeled('mix', mixSelect), labeled('save as', nameInput, saveButton), labeled('share', shareButton, shareOutput),
  ]);

  // Simulation: capacity, neighbor radius (a capacity swap), rate and the same-species toggle.
  section('Simulation');
  const capacitySelect = make('select', {}, capacityOptions.map((capacity) => make('option', { value: capacity, textContent: capacity.toLocaleString('en-US') })));
  syncs.push(() => { capacitySelect.value = String(getSimulation().capacity); });
  // A swap (capacity or neighbor radius) is the UI boundary: a rejection (for example an
  // allocation the device cannot hold) shows here and the previous simulation keeps running.
  const swap = async (describe, request) => {
    controls.disabled = true;
    showStatus('');
    try {
      await request();
    } catch (error) {
      showStatus(`${describe} failed, kept the current simulation: ${error.message}`);
    } finally {
      controls.disabled = false;
      refresh();
    }
  };
  capacitySelect.addEventListener('change', () => {
    const requested = Number(capacitySelect.value);
    capacitySelect.blur();
    swap(`Capacity ${requested.toLocaleString('en-US')}`, () => onCapacityChange(requested));
  });
  const neighborRow = slider(NEIGHBOR_RADIUS_SLIDER, () => clampToSpec(NEIGHBOR_RADIUS_SLIDER, getSimulation().neighborRadius),
    (value) => swap(`Neighbor radius ${value}`, () => onCapacityChange(getSimulation().capacity, { neighborRadius: value })), { commitOn: 'change' });
  const rateSelect = make('select', {}, ['full', 'half'].map((rate) => make('option', { value: rate, textContent: rate + ' rate' })));
  syncs.push(() => { rateSelect.value = lab.game.simulationRate; });
  rateSelect.addEventListener('change', () => {
    lab.game.setSimulationRate(rateSelect.value);
    rateSelect.blur();
  });
  const cohesionToggle = make('input', { type: 'checkbox' });
  syncs.push(() => { cohesionToggle.checked = getSimulation().sameSpeciesCohesion; });
  cohesionToggle.addEventListener('change', () => {
    getSimulation().setSameSpeciesCohesion(cohesionToggle.checked);
    cohesionToggle.blur();
  });
  controls.append(
    labeled('capacity', capacitySelect), neighborRow, labeled('simulation', rateSelect), labeled('same-species cohesion', cohesionToggle),
    make('p', { className: 'lab-note', textContent: 'Right mouse button: inspect zoom (lab only).' }),
  );

  for (const group of LAB_KNOB_GROUPS) {
    section(group.title);
    controls.append(...group.knobs.map(knobSlider));
  }

  // Spawn shares: raw slider values, normalized inside setShares.
  section('Spawn shares');
  SPECIES_NAMES.forEach((name, index) => {
    controls.append(slider({ ...SHARE_SLIDER, label: name }, () => getSimulation().shares[index], (value) => {
      const shares = Array.from(getSimulation().shares);
      shares[index] = value;
      getSimulation().setShares(shares);
    }));
  });

  // One collapsible block of rule sliders per species row.
  section('Species rules');
  SPECIES_NAMES.slice(0, SPECIES_COUNT).forEach((name, index) => {
    const body = SPECIES_SLIDERS.map((spec) => slider(spec, () => getSimulation().species[index][spec.key], (value) => {
      const simulation = getSimulation();
      simulation.species[index][spec.key] = value;
      simulation.setSpecies(simulation.species, simulation.matrix);
    }));
    controls.append(make('details', {}, [make('summary', { textContent: name }), ...body]));
  });

  // Matrix: the row is the acting species, the column the species it reacts to.
  section('Matrix (row reacts to column)');
  const matrixGrid = make('div', { className: 'lab-matrix' }, [make('span')]);
  SPECIES_NAMES.forEach((name) => matrixGrid.append(make('span', { textContent: name.slice(0, 3) })));
  SPECIES_NAMES.forEach((name, row) => {
    matrixGrid.append(make('span', { textContent: name.slice(0, 3) }));
    for (let column = 0; column < SPECIES_COUNT; column += 1) {
      const index = row * SPECIES_COUNT + column;
      const cell = make('input', { type: 'number', step: MATRIX_STEP, min: -MATRIX_LIMIT, max: MATRIX_LIMIT });
      cell.dataset.matrix = String(index);
      syncs.push(() => { cell.value = String(Number(getSimulation().matrix[index].toFixed(3))); });
      cell.addEventListener('input', () => {
        const value = Number(cell.value);
        if (cell.value === '' || !Number.isFinite(value)) return;
        const simulation = getSimulation();
        simulation.matrix[index] = Math.min(MATRIX_LIMIT, Math.max(-MATRIX_LIMIT, value));
        simulation.setSpecies(simulation.species, simulation.matrix);
      });
      matrixGrid.append(cell);
    }
  });
  controls.append(matrixGrid);

  // Arms a weapon (full charge) at a tier, for looking at each weapon in Play without hunting pickups.
  if (onArmWeapon !== null) {
    section('Arm weapon (Play)');
    const armSelect = make('select', {}, ['base', ...WEAPON_TYPE_NAMES].map((name) => make('option', { value: name, textContent: name })));
    const tierSelect = make('select', {}, ARM_TIERS.map((tier) => make('option', { value: tier, textContent: 'tier ' + tier })));
    const arm = () => {
      onArmWeapon(armSelect.value, Number(tierSelect.value));
      armSelect.blur();
      tierSelect.blur();
    };
    armSelect.addEventListener('change', arm);
    tierSelect.addEventListener('change', arm);
    controls.append(labeled('weapon', armSelect, tierSelect));
  }

  section('Renderer');
  controls.append(...RENDER_SLIDERS.map(knobSlider));

  root.append(header, status, mixes, controls, make('h3', { textContent: 'Readout' }), readout);

  function refresh() {
    syncs.forEach((sync) => sync());
  }
  const refreshReadout = () => {
    readout.textContent = describeStats(readStats(), framesPerSecond.value);
  };
  const tick = (timestamp) => {
    framesPerSecond.record(timestamp);
    framesSinceReadout += 1;
    if (framesSinceReadout >= READOUT_INTERVAL_FRAMES) {
      framesSinceReadout = 0;
      refreshReadout();
    }
    frameHandle = requestFrame(tick);
  };

  // The readout loop runs only while the panel is open; the tab shows while the lab is folded.
  function setOpen(open) {
    root.hidden = !open;
    tab.hidden = open || !lab.active;
    if (open && frameHandle === null) {
      framesPerSecond.reset();
      refresh();
      refreshReadout();
      frameHandle = requestFrame(tick);
    } else if (!open && frameHandle !== null) {
      cancelFrame(frameHandle);
      frameHandle = null;
    }
  }

  // Backquote (a developer shortcut) enters the lab, then folds and unfolds the panel.
  const onKeyDown = (event) => {
    if (event.code !== TOGGLE_CODE || event.repeat || TYPING_TAGS.includes(event.target?.tagName)) return;
    if (!lab.active) lab.enter();
    else setOpen(root.hidden);
  };
  windowObject.addEventListener('keydown', onKeyDown);
  documentObject.body.append(tab, root);

  const panel = {
    element: root,
    open: () => setOpen(true),
    close: () => {
      setOpen(false);
      tab.hidden = true;
    },
    refresh,
    showStatus,
    setMode(mode) {
      watchButton.setAttribute('aria-pressed', String(mode === 'watch'));
      playButton.setAttribute('aria-pressed', String(mode === 'play'));
    },
    get isOpen() { return !root.hidden; },
    dispose() {
      setOpen(false);
      windowObject.removeEventListener('keydown', onKeyDown);
      tab.remove();
      root.remove();
    },
  };
  lab.attachPanel(panel);
  return panel;
}
