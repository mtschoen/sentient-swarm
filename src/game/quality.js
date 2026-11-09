// Live quality presets. QualityController feeds frame times (from the frame timer in main.js) to
// a FrameTimeProbe while the game is in play, and acts on its decisions between frames:
//   'down': first a sub-step inside the current preset (particle budget halved, bloom one level
//           lower), then on the next 'down' the preset one rung lower;
//   'up':   undoes the sub-step if one is in effect, otherwise the preset one rung higher, never
//           past the ceiling (the binding-limit cap) and only while up steps are allowed.
// apply(name) changes capacity, neighbor radius and particle budget through Game.setCapacity (the
// CapacitySwap path), then bloom quality and simulation rate, then persists the preset with the
// adapter key. Up steps are allowed when no stored preset matched this adapter, or after
// rerunProbe(); a stored preset only ever steps down (phones throttle after minutes of play).
import { PRESETS, PRESET_ORDER, highestPresetFor, initialPresetFor, stepPreset } from '../settings/presets.js';

const BLOOM_ORDER = ['low', 'medium', 'high'];

function lowerBloom(quality) {
  return BLOOM_ORDER[Math.max(0, BLOOM_ORDER.indexOf(quality) - 1)];
}

// Mobile detection for the initial preset: navigator.userAgentData.mobile where the browser
// reports it (Chromium), otherwise a coarse primary pointer together with touch points (Safari
// and Firefox; a touch laptop has a fine primary pointer, so it stays desktop).
export function detectMobile({ navigatorObject = globalThis.navigator, matchMedia = globalThis.matchMedia } = {}) {
  const reported = navigatorObject?.userAgentData?.mobile;
  if (typeof reported === 'boolean') return reported;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return Boolean(coarse && (navigatorObject?.maxTouchPoints ?? 0) > 0);
}

// A touch-first device: the primary pointer is coarse and there are touch points. Unlike
// detectMobile this ignores the browser's own mobile flag, which a foldable or a tablet reports
// as false even on a phone-sized screen; fullscreen play (main.js) accepts either.
export function detectTouchDevice({ navigatorObject = globalThis.navigator, matchMedia = globalThis.matchMedia } = {}) {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return Boolean(coarse && (navigatorObject?.maxTouchPoints ?? 0) > 0);
}

// A stable string for the adapter (GPUAdapter.info): vendor, architecture, device, description.
export function adapterKeyFrom(info) {
  if (!info) return 'unknown';
  return [info.vendor, info.architecture, info.device, info.description].map((part) => part ?? '').join('|');
}

// The preset to start at and whether the probe may step up. A stored preset counts only when it
// is a known name stored for this adapter; it is capped at the ceiling.
export function resolveInitialPreset({ settings, adapterKey, isMobile, maxStorageBufferBindingSize }) {
  const ceiling = highestPresetFor({ maxStorageBufferBindingSize });
  const stored = settings?.preset;
  if (typeof stored === 'string' && Object.hasOwn(PRESETS, stored) && settings.adapterKey === adapterKey) {
    const index = Math.min(PRESET_ORDER.indexOf(stored), PRESET_ORDER.indexOf(ceiling));
    return { name: PRESET_ORDER[index], allowUp: false, ceiling };
  }
  return { name: initialPresetFor({ isMobile, maxStorageBufferBindingSize }), allowUp: true, ceiling };
}

// The settings panel's change handler for the preset select. quality.current follows the probe's
// steps too, so a slider move never re-applies the preset. A capacity swap carries the burst size
// over, but the live settings (sliders may have moved during the swap's prepare) are applied again
// once it has settled; liveSettings is read at that moment, not captured when the swap starts.
// Returns the settle promise, or null when no swap was asked for. A failed swap leaves the old
// simulation installed; onFailure (optional) runs then so the caller can re-sync its display.
export function settleApply({ quality, liveSettings, applySettings }) {
  return (current, onFailure = () => {}) => {
    if (!current.preset || current.preset === quality.current) return null;
    return quality.apply(current.preset).then(() => applySettings(liveSettings()), () => onFailure());
  };
}

export class QualityController {
  // game: Game (setCapacity, setSimulationRate, simulation.particlePool, renderer,
  // acceptsProbeFrames); store: SettingsStore; probe: FrameTimeProbe (or anything with
  // recordFrame and reset). ceiling: the highest preset an up step may reach.
  constructor({ game, store, probe, presets = PRESETS, adapterKey = null, ceiling = PRESET_ORDER[PRESET_ORDER.length - 1] }) {
    this.game = game;
    this.store = store;
    this.probe = probe;
    this.presets = presets;
    this.adapterKey = adapterKey;
    this.ceiling = ceiling ?? PRESET_ORDER[PRESET_ORDER.length - 1];
    this.currentName = null;
    this.reducedValue = false;
    this.allowUp = true;
    this.applying = false;
    // Resolves when the newest apply started by a probe decision has finished.
    this.settled = Promise.resolve();
  }

  get current() { return this.currentName; }
  // True while the down sub-step (halved particles, lower bloom) is in effect.
  get reduced() { return this.reducedValue; }

  // The game was built at initialName's capacity, neighbor radius and particle budget; this sets
  // the rest of the preset (bloom, simulation rate) without a capacity swap.
  start(initialName, { allowUp = true } = {}) {
    const preset = this.presetNamed(initialName);
    this.currentName = initialName;
    this.reducedValue = false;
    this.allowUp = allowUp;
    this.game.renderer.setBloomQuality(preset.bloomQuality);
    this.game.setSimulationRate(preset.simulationRate);
  }

  // The player asked for a fresh probe (Settings): up steps are allowed again.
  rerunProbe() {
    this.allowUp = true;
    this.probe.reset();
  }

  // One measured frame. Returns the probe's decision (or null); acting on it may start an apply.
  onFrame(frameMilliseconds, nowSeconds) {
    if (this.currentName === null || this.applying || !this.game.acceptsProbeFrames) return null;
    const decision = this.probe.recordFrame(frameMilliseconds, nowSeconds);
    if (decision === 'down') this.stepDown();
    else if (decision === 'up' && this.allowUp) this.stepUp();
    return decision;
  }

  stepDown() {
    if (!this.reducedValue) {
      const preset = this.presetNamed(this.currentName);
      const pool = this.game.simulation.particlePool;
      pool.resize(Math.max(1, Math.floor(pool.capacity / 2)));
      this.game.renderer.setBloomQuality(lowerBloom(preset.bloomQuality));
      this.reducedValue = true;
      return;
    }
    const next = stepPreset(this.currentName, 'down');
    if (next !== this.currentName) this.startApply(next);
  }

  stepUp() {
    if (this.reducedValue) {
      this.startApply(this.currentName);
      return;
    }
    const next = stepPreset(this.currentName, 'up');
    if (next === this.currentName || PRESET_ORDER.indexOf(next) > PRESET_ORDER.indexOf(this.ceiling)) return;
    this.startApply(next);
  }

  // A failed step keeps the old preset (the swap leaves the old simulation installed); it is
  // reported as a warning, since the game plays on.
  startApply(name) {
    this.settled = this.apply(name).catch((error) => {
      console.warn(`Quality preset ${name} could not be applied: ${error.message}`);
      return false;
    });
  }

  // Applies the named preset between frames; resolves false for the current preset with full
  // budgets (nothing to do), while another apply runs, or when Game.setCapacity resolves false.
  // A failed or timed-out swap (CapacitySwapTimeout) rejects, leaving the old preset in effect.
  async apply(name) {
    const preset = this.presetNamed(name);
    if (this.applying || (name === this.currentName && !this.reducedValue)) return false;
    this.applying = true;
    try {
      const { capacity, neighborRadius, particleCapacity } = preset;
      // false: the swap was ignored (another is in flight), so nothing of this preset is applied
      // or persisted.
      if (!(await this.game.setCapacity(capacity, { neighborRadius, particleCapacity }))) return false;
      // The swap is skipped when capacity, radius and budget already match (restoring a sub-step).
      const pool = this.game.simulation.particlePool;
      if (pool.capacity !== particleCapacity) pool.resize(particleCapacity);
      this.game.renderer.setBloomQuality(preset.bloomQuality);
      this.game.setSimulationRate(preset.simulationRate);
      this.currentName = name;
      this.reducedValue = false;
      this.store.save({ ...this.store.load(), preset: name, adapterKey: this.adapterKey });
      return true;
    } finally {
      this.applying = false;
    }
  }

  presetNamed(name) {
    if (!Object.hasOwn(this.presets, name)) throw new Error(`Unknown preset: ${name}`);
    return this.presets[name];
  }
}
