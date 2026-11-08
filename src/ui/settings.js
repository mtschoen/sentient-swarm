// Settings panel: preset select, calibrated sliders, reduced motion, rumble, stick tuning and a
// probe re-run, as plain DOM. Every change is applied live through onChange(settings) and saved
// to the store once. A pointer-driven change gives a control up its focus (as in labPanel.js), an
// arrow-key step on a slider keeps it, and close() blurs whatever has it; main.js routes Escape and
// O from a focused non-text control (menuRouting.js routeSettingsKey), so the keys reach the panel. The pure mappings
// below turn the stored percentages into the values the renderer, simulation and input use (100
// percent is the tuned default; reduced motion disables trails and halves particles and shake).
import { DEFAULT_KILL_BURST_PARTICLES, MAXIMUM_KILL_BURST_PARTICLES } from '../sim/params.js';

// Renderer defaults at 100 percent (DEFAULT_RENDER_SETTINGS.trailDecay and .bloomStrength).
const TUNED_TRAIL_DECAY = 0.6;
const TUNED_BLOOM_STRENGTH = 0.8;
// Trail decay at 300 percent: long streaks, still below 1 so the trail always fades.
const MAXIMUM_TRAIL_DECAY = 0.95;
const MAXIMUM_PERCENT = 300;
const REDUCED_MOTION_FACTOR = 0.5;

export function trailDecayFor(settings) {
  if (settings.reducedMotion) return 0;
  const fraction = settings.trails / 100;
  if (fraction <= 0) return 0;
  if (fraction <= 1) return TUNED_TRAIL_DECAY * fraction;
  const overshoot = Math.min(1, (fraction - 1) / (MAXIMUM_PERCENT / 100 - 1));
  return TUNED_TRAIL_DECAY + (MAXIMUM_TRAIL_DECAY - TUNED_TRAIL_DECAY) * overshoot;
}

export function killBurstParticlesFor(settings) {
  const factor = (settings.effects / 100) * (settings.reducedMotion ? REDUCED_MOTION_FACTOR : 1);
  const scaled = Math.round(DEFAULT_KILL_BURST_PARTICLES * factor);
  return Math.min(MAXIMUM_KILL_BURST_PARTICLES, Math.max(0, scaled));
}

export function shakeMultiplierFor(settings) {
  return (settings.shake / 100) * (settings.reducedMotion ? REDUCED_MOTION_FACTOR : 1);
}

export function bloomStrengthFor(settings) {
  return TUNED_BLOOM_STRENGTH * (settings.effects / 100);
}

// scale: displayed units per stored unit (the dead zone and stick size are stored as fractions).
const SLIDERS = [
  { key: 'effects', label: 'Effects', minimum: 0, maximum: 300, step: 5, scale: 1 },
  { key: 'shake', label: 'Shake', minimum: 0, maximum: 300, step: 5, scale: 1 },
  { key: 'trails', label: 'Trails', minimum: 0, maximum: 300, step: 5, scale: 1 },
  { key: 'music', label: 'Music', minimum: 0, maximum: 100, step: 1, scale: 1 },
  { key: 'effectsVolume', label: 'Effects volume', minimum: 0, maximum: 100, step: 1, scale: 1 },
  { key: 'stickDeadZone', label: 'Stick dead zone', minimum: 0, maximum: 50, step: 1, scale: 100 },
  { key: 'stickRadius', label: 'Stick size', minimum: 50, maximum: 200, step: 5, scale: 100 },
];
const CHECKBOXES = [
  { key: 'reducedMotion', label: 'Reduced motion' },
  { key: 'rumble', label: 'Gamepad rumble' },
];

export function createSettingsPanel({
  store, onChange = () => {}, presets = [], onRerunProbe = () => {}, canChangePreset = true,
  documentObject = document,
}) {
  const make = (tagName, className, textContent = '') => {
    const created = documentObject.createElement(tagName);
    if (className) created.classList.add(className);
    created.textContent = textContent;
    return created;
  };
  const root = make('div', 'settings-panel');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Settings');
  root.setAttribute('data-touch-exclusive', '');
  root.hidden = true;
  const header = make('div', 'settings-header');
  const closeButton = make('button', 'settings-close', 'Close');
  header.append(make('div', 'settings-title', 'Settings'), closeButton);
  const grid = make('div', 'settings-grid');
  root.append(header, grid);

  let settings = store.load();
  const controls = new Map();
  let open = false;

  const labelled = (text, control, extra = null) => {
    const row = make('label', 'settings-row');
    row.append(make('span', 'settings-label', text), control);
    if (extra) row.append(extra);
    grid.append(row);
    return row;
  };
  // Re-reads the store first so a preset the quality controller saved meanwhile is not lost.
  const commit = (key, value) => {
    settings = { ...store.load(), [key]: value };
    store.save(settings);
    onChange(settings);
  };

  const presetSelect = make('select', 'settings-input');
  presetSelect.setAttribute('data-setting', 'preset');
  presetSelect.disabled = !canChangePreset;
  for (const preset of presets) {
    const option = make('option', '', preset.name);
    option.value = preset.name;
    presetSelect.append(option);
  }
  presetSelect.addEventListener('change', () => {
    commit('preset', presetSelect.value);
    presetSelect.blur();
  });
  labelled('Quality preset', presetSelect);
  controls.set('preset', () => { presetSelect.value = settings.preset ?? ''; });

  for (const spec of SLIDERS) {
    const slider = make('input', 'settings-input');
    slider.type = 'range';
    slider.setAttribute('data-setting', spec.key);
    slider.setAttribute('min', String(spec.minimum));
    slider.setAttribute('max', String(spec.maximum));
    slider.setAttribute('step', String(spec.step));
    const readout = make('span', 'settings-readout');
    readout.setAttribute('data-readout', spec.key);
    const show = () => {
      const displayed = Math.round(settings[spec.key] * spec.scale);
      slider.value = String(displayed);
      readout.textContent = `${displayed}%`;
    };
    slider.addEventListener('input', () => {
      const displayed = Number(slider.value);
      readout.textContent = `${displayed}%`;
      commit(spec.key, displayed / spec.scale);
    });
    // Only a pointer-driven change gives up focus; an arrow step keeps it so the next one works.
    let pointerDriven = false;
    slider.addEventListener('pointerdown', () => { pointerDriven = true; });
    slider.addEventListener('change', () => {
      if (!pointerDriven) return;
      pointerDriven = false;
      slider.blur();
    });
    labelled(spec.label, slider, readout);
    controls.set(spec.key, show);
  }

  for (const spec of CHECKBOXES) {
    const box = make('input', 'settings-input');
    box.type = 'checkbox';
    box.setAttribute('data-setting', spec.key);
    box.addEventListener('change', () => {
      commit(spec.key, Boolean(box.checked));
      box.blur();
    });
    labelled(spec.label, box);
    controls.set(spec.key, () => { box.checked = Boolean(settings[spec.key]); });
  }

  const probeButton = make('button', 'settings-button', 'Re-run probe');
  probeButton.setAttribute('data-setting', 'rerunProbe');
  probeButton.addEventListener('click', () => onRerunProbe());
  grid.append(probeButton);

  const refresh = () => {
    settings = store.load();
    for (const show of controls.values()) show();
  };
  refresh();

  const close = () => {
    open = false;
    root.hidden = true;
    documentObject.activeElement?.blur?.();
  };
  closeButton.addEventListener('click', close);

  return {
    element: root,
    open() {
      refresh();
      open = true;
      root.hidden = false;
    },
    close,
    refresh,
    get isOpen() { return open; },
  };
}
