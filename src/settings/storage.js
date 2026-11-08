import { PRESETS } from './presets.js';

export const DEFAULT_SETTINGS = Object.freeze({
  preset: null,
  adapterKey: null,
  effects: 100,
  shake: 100,
  trails: 100,
  music: 80,
  effectsVolume: 80,
  reducedMotion: false,
  stickDeadZone: 0.15,
  stickRadius: 1.0,
  rumble: true,
});

// The range of each numeric setting: the settings panel slider range (stored units), so a hand-edited
// or corrupted store cannot push a value the panel could never produce.
export const SETTING_RANGES = Object.freeze({
  effects: [0, 300], shake: [0, 300], trails: [0, 300], music: [0, 100], effectsVolume: [0, 100],
  stickDeadZone: [0, 0.5], stickRadius: [0.5, 2],
});

// preset and adapterKey are nullable strings (preset only a known PRESETS name, so an unknown one
// loads as absent); the rest match their default's type.
function matchesDefault(key, value) {
  if (key === 'preset') {
    return value === null || (typeof value === 'string' && Object.hasOwn(PRESETS, value));
  }
  if (key === 'adapterKey') {
    return value === null || typeof value === 'string';
  }
  if (typeof DEFAULT_SETTINGS[key] === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  return typeof value === typeof DEFAULT_SETTINGS[key];
}

export class SettingsStore {
  // storage is read lazily so importing this module never touches localStorage.
  constructor({ storage = null, key = 'murmuration.settings.v1' } = {}) {
    this.injectedStorage = storage;
    this.key = key;
  }

  get storage() {
    return this.injectedStorage ?? globalThis.localStorage ?? null;
  }

  load() {
    const settings = { ...DEFAULT_SETTINGS };
    let parsed;
    try {
      parsed = JSON.parse(this.storage?.getItem(this.key) ?? 'null');
    } catch {
      return settings;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return settings;
    }
    for (const name of Object.keys(DEFAULT_SETTINGS)) {
      if (!matchesDefault(name, parsed[name])) continue;
      const range = SETTING_RANGES[name];
      settings[name] = range ? Math.min(range[1], Math.max(range[0], parsed[name])) : parsed[name];
    }
    return settings;
  }

  save(settings) {
    try {
      this.storage?.setItem(this.key, JSON.stringify(settings));
    } catch {
      // Storage may be full or denied; settings are best effort.
    }
  }
}
