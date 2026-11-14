// Swarm feel (experiment) group for the settings panel: three sliders with numeric readouts, a
// bees default and a fish (today's) reset, and the query string for the current values (also kept
// in the address bar through onChange). Meant to be deleted with src/game/swarm-feel.js.
import { BEES_FEEL, FEEL_DIALS, FISH_FEEL, feelToSearch } from '../game/swarm-feel.js';

// feel: the live object the swarm reads; the panel mutates it in place. onChange(feel) after any change.
export function createSwarmFeelGroup({ feel, onChange = () => {}, documentObject = document }) {
  const make = (tagName, className, textContent = '') => {
    const created = documentObject.createElement(tagName);
    if (className) created.classList.add(className);
    created.textContent = textContent;
    return created;
  };
  const root = make('div', 'swarm-feel');
  root.setAttribute('data-swarm-feel', '');
  root.append(make('div', 'swarm-feel-title', 'Swarm feel (experiment)'));
  const query = make('code', 'swarm-feel-query');
  query.setAttribute('data-swarm-feel-query', '');
  const sliders = new Map();
  const readouts = new Map();

  const show = () => {
    for (const spec of FEEL_DIALS) {
      sliders.get(spec.key).value = String(feel[spec.key]);
      readouts.get(spec.key).textContent = feel[spec.key].toFixed(2);
    }
    query.textContent = feelToSearch(feel);
  };
  const set = (key, value) => {
    feel[key] = value;
    show();
    onChange(feel);
  };

  for (const spec of FEEL_DIALS) {
    const row = make('label', 'swarm-feel-row');
    const slider = make('input', 'settings-input');
    slider.type = 'range';
    slider.setAttribute('data-swarm-feel-dial', spec.key);
    slider.setAttribute('min', String(spec.minimum));
    slider.setAttribute('max', String(spec.maximum));
    slider.setAttribute('step', String(spec.step));
    slider.addEventListener('input', () => set(spec.key, Number(slider.value)));
    const readout = make('span', 'settings-readout');
    readout.setAttribute('data-swarm-feel-readout', spec.key);
    sliders.set(spec.key, slider);
    readouts.set(spec.key, readout);
    row.append(make('span', 'settings-label', spec.label), slider, readout);
    root.append(row);
  }

  const apply = (values) => {
    for (const spec of FEEL_DIALS) feel[spec.key] = values[spec.key];
    show();
    onChange(feel);
  };
  const buttons = make('div', 'swarm-feel-buttons');
  const bees = make('button', 'settings-button', 'Bees (default)');
  bees.addEventListener('click', () => apply(BEES_FEEL));
  const fish = make('button', 'settings-button', 'Fish (current)');
  fish.addEventListener('click', () => apply(FISH_FEEL));
  buttons.append(bees, fish);
  root.append(buttons, query);
  show();
  return { element: root, refresh: show };
}
