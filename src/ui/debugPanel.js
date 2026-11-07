// Demo controls panel: plain DOM, hidden until the corner button or the backquote key opens it.
// It is a sibling of the canvas in the page, so pointer events on it never reach the canvas's
// input listeners and sliding a slider cannot fire the debug kill. The panel keeps no copy of the
// species rows, matrix or shares: it edits what getSimulation() holds and writes the change back
// through setSpecies / setShares, so a capacity change (which carries them over) needs no re-sync.
// This panel is the seed of the lab mode and is kept.
import { WEAPON_TYPE_NAMES } from '../game/weaponTypes.js';
import { SPECIES_COUNT } from '../sim/layout.js';
import { SPECIES_NAMES } from '../sim/species.js';
import { CAPACITY_OPTIONS, FramesPerSecond, RENDER_SLIDERS, SHARE_SLIDER, SPECIES_SLIDERS, describeStats } from './panelModel.js';

const READOUT_INTERVAL_FRAMES = 15;
const MATRIX_STEP = 0.1;
const TOGGLE_KEY = '`';
const ARM_TIERS = [1, 2, 3];

const STYLE = `
.murmuration-panel-button { position: fixed; top: 8px; right: 8px; z-index: 11; font: 12px system-ui, sans-serif;
  background: #101820; color: #cfe8ff; border: 1px solid #36506a; border-radius: 4px; padding: 4px 8px; cursor: pointer; opacity: 0.7; }
.murmuration-panel { position: fixed; top: 40px; right: 8px; bottom: 8px; width: 320px; overflow-y: auto; z-index: 10;
  background: rgba(8, 12, 18, 0.92); color: #cfe8ff; font: 12px/1.4 system-ui, sans-serif; padding: 8px 10px;
  border: 1px solid #36506a; border-radius: 4px; }
.murmuration-panel[hidden] { display: none; }
.murmuration-panel h3 { margin: 10px 0 4px; font-size: 12px; text-transform: uppercase; color: #7fb4e8; }
.murmuration-panel label { display: grid; grid-template-columns: 1fr 110px 44px; align-items: center; gap: 6px; }
.murmuration-panel pre { margin: 0; font: 12px/1.4 ui-monospace, monospace; }
.murmuration-panel .matrix { display: grid; grid-template-columns: repeat(6, 1fr); gap: 2px; }
.murmuration-panel .matrix input { width: 100%; box-sizing: border-box; }
.murmuration-panel fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
.murmuration-panel .status { margin: 4px 0; color: #ffb4a8; }
`;

function element(documentObject, tagName, properties = {}, children = []) {
  const created = Object.assign(documentObject.createElement(tagName), properties);
  created.append(...children);
  return created;
}

function slider(documentObject, spec, value, onChange) {
  const input = element(documentObject, 'input', { type: 'range', min: spec.minimum, max: spec.maximum, step: spec.step, value });
  const output = element(documentObject, 'span', { textContent: Number(value).toFixed(2) });
  input.addEventListener('input', () => {
    output.textContent = Number(input.value).toFixed(2);
    onChange(Number(input.value));
  });
  // Release focus so WASD moves the player again after a slider is used.
  input.addEventListener('change', () => input.blur());
  return element(documentObject, 'label', {}, [element(documentObject, 'span', { textContent: spec.label }), input, output]);
}

export function createDebugPanel({
  getSimulation,
  renderer,
  onCapacityChange,
  onArmWeapon = null,
  windowObject = window,
  documentObject = document,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (handle) => cancelAnimationFrame(handle),
  readStats = () => windowObject.__murmuration?.stats ?? null,
}) {
  const style = element(documentObject, 'style', { textContent: STYLE });
  const root = element(documentObject, 'div', { className: 'murmuration-panel', hidden: true });
  const button = element(documentObject, 'button', { className: 'murmuration-panel-button', type: 'button', textContent: 'debug (' + TOGGLE_KEY + ')' });
  const readout = element(documentObject, 'pre');
  // Every control sits in this fieldset, so disabling it disables them all during a capacity swap.
  const controls = element(documentObject, 'fieldset');
  const status = element(documentObject, 'p', { className: 'status', hidden: true });
  const framesPerSecond = new FramesPerSecond();
  let frameHandle = null;
  let framesSinceReadout = 0;

  const applySpecies = () => {
    const simulation = getSimulation();
    simulation.setSpecies(simulation.species, simulation.matrix);
  };
  const section = (title) => {
    controls.append(element(documentObject, 'h3', { textContent: title }));
  };
  const showStatus = (text) => {
    status.textContent = text;
    status.hidden = text === '';
  };

  // Capacity select and the same-species cohesion toggle.
  section('Simulation');
  const capacitySelect = element(documentObject, 'select', {}, CAPACITY_OPTIONS.map((capacity) => element(documentObject, 'option', { value: capacity, textContent: capacity.toLocaleString('en-US') })));
  capacitySelect.value = String(getSimulation().capacity);
  // The UI boundary for a capacity change: a rejection (for example an allocation the device
  // cannot hold) is shown here and the previous simulation keeps running.
  capacitySelect.addEventListener('change', async () => {
    const requested = Number(capacitySelect.value);
    controls.disabled = true;
    showStatus('');
    try {
      await onCapacityChange(requested);
    } catch (error) {
      showStatus(`Capacity ${requested.toLocaleString('en-US')} failed, kept ${getSimulation().capacity.toLocaleString('en-US')}: ${error.message}`);
    } finally {
      capacitySelect.value = String(getSimulation().capacity);
      controls.disabled = false;
      capacitySelect.blur();
    }
  });
  const cohesionToggle = element(documentObject, 'input', { type: 'checkbox', checked: getSimulation().sameSpeciesCohesion });
  cohesionToggle.addEventListener('change', () => {
    getSimulation().setSameSpeciesCohesion(cohesionToggle.checked);
    cohesionToggle.blur();
  });
  controls.append(
    element(documentObject, 'label', {}, [element(documentObject, 'span', { textContent: 'capacity' }), capacitySelect]),
    status,
    element(documentObject, 'label', {}, [element(documentObject, 'span', { textContent: 'same-species cohesion' }), cohesionToggle]),
  );

  // Spawn shares: raw slider values, normalized inside setShares.
  section('Spawn shares');
  const rawShares = Array.from(getSimulation().shares);
  SPECIES_NAMES.forEach((name, index) => {
    controls.append(slider(documentObject, { ...SHARE_SLIDER, label: name }, rawShares[index], (value) => {
      rawShares[index] = value;
      getSimulation().setShares(rawShares);
    }));
  });

  // One collapsible block of sliders per species row.
  section('Species');
  getSimulation().species.slice(0, SPECIES_COUNT).forEach((row, index) => {
    const body = SPECIES_SLIDERS.map((spec) => slider(documentObject, spec, row[spec.key], (value) => {
      getSimulation().species[index][spec.key] = value;
      applySpecies();
    }));
    controls.append(element(documentObject, 'details', {}, [element(documentObject, 'summary', { textContent: SPECIES_NAMES[index] }), ...body]));
  });

  // Matrix: the row is the acting species, the column the species it reacts to.
  section('Matrix (row reacts to column)');
  const matrixGrid = element(documentObject, 'div', { className: 'matrix' }, [element(documentObject, 'span')]);
  SPECIES_NAMES.forEach((name) => matrixGrid.append(element(documentObject, 'span', { textContent: name.slice(0, 3) })));
  SPECIES_NAMES.forEach((name, row) => {
    matrixGrid.append(element(documentObject, 'span', { textContent: name.slice(0, 3) }));
    for (let column = 0; column < SPECIES_COUNT; column += 1) {
      const cell = element(documentObject, 'input', { type: 'number', step: MATRIX_STEP, value: getSimulation().matrix[row * SPECIES_COUNT + column] });
      cell.addEventListener('input', () => {
        const value = Number(cell.value);
        if (!Number.isFinite(value)) return;
        getSimulation().matrix[row * SPECIES_COUNT + column] = value;
        applySpecies();
      });
      matrixGrid.append(cell);
    }
  });
  controls.append(matrixGrid);

  // Arms a weapon (full charge) at a tier, for looking at each weapon without hunting pickups.
  if (onArmWeapon !== null) {
    section('Weapons');
    const armSelect = element(documentObject, 'select', {}, ['base', ...WEAPON_TYPE_NAMES].map((name) => element(documentObject, 'option', { value: name, textContent: name })));
    const tierSelect = element(documentObject, 'select', {}, ARM_TIERS.map((tier) => element(documentObject, 'option', { value: tier, textContent: 'tier ' + tier })));
    const arm = () => {
      onArmWeapon(armSelect.value, Number(tierSelect.value));
      armSelect.blur();
      tierSelect.blur();
    };
    armSelect.addEventListener('change', arm);
    tierSelect.addEventListener('change', arm);
    controls.append(element(documentObject, 'label', {}, [element(documentObject, 'span', { textContent: 'arm weapon' }), armSelect, tierSelect]));
  }

  section('Renderer');
  RENDER_SLIDERS.forEach((spec) => {
    controls.append(slider(documentObject, spec, renderer.settings[spec.key], (value) => {
      renderer.settings[spec.key] = value;
    }));
  });

  root.append(controls, element(documentObject, 'h3', { textContent: 'Readout' }), readout);

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

  // The readout loop runs only while the panel is open.
  const setOpen = (open) => {
    root.hidden = !open;
    if (open && frameHandle === null) {
      framesPerSecond.reset();
      refreshReadout();
      frameHandle = requestFrame(tick);
    } else if (!open && frameHandle !== null) {
      cancelFrame(frameHandle);
      frameHandle = null;
    }
  };
  const toggle = () => setOpen(root.hidden);
  const onKeyDown = (event) => {
    if (event.key === TOGGLE_KEY) toggle();
  };
  button.addEventListener('click', toggle);
  windowObject.addEventListener('keydown', onKeyDown);

  documentObject.head.append(style);
  documentObject.body.append(button, root);

  function dispose() {
    setOpen(false);
    button.removeEventListener('click', toggle);
    windowObject.removeEventListener('keydown', onKeyDown);
    style.remove();
    button.remove();
    root.remove();
  }

  return { element: root, dispose };
}
