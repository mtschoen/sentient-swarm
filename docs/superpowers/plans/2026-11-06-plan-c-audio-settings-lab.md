# Plan C: Audio, Settings, Lab, and Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the game around the Plan A and Plan B core: quality presets chosen by an in-play frame-time probe with live capacity changes, a settings panel with calibrated sliders, a one-tap entry with landscape lock and pause, procedural techno and synthesized effects driven by the game, the lab mode with shareable mixes, touch control polish with mobile smoke coverage, and shipping documentation.

**Architecture:** Settings and presets are plain CPU modules persisted in `localStorage`. The probe watches frame times during real play and asks the game to step the preset up or down; stepping recreates GPU resources at a frame boundary (the Plan A `recreateWithCapacity` path). Audio is a Web Audio graph built on the first user gesture: a step sequencer schedules kick, hats, bass and lead ahead of time against `AudioContext.currentTime`, with an intensity value from the game opening filters and adding layers; effects are short synthesized voices. The lab is the Plan A debug panel grown into a shipped mode with presets, URL hash export, and a watch mode.

**Tech Stack:** As Plans A and B, plus Web Audio API, `screen.orientation`, `localStorage`.

**Spec:** `docs/superpowers/specs/2026-11-06-murmuration-design.md`

## Global Constraints

- Everything in Plan A's Global Constraints still binds.
- Instant start: exactly one user input (tap, click or button) between page load and play, and that input also unlocks audio. Danger and scoring start half a second after it.
- Portrait on a phone shows the rotate overlay and nothing else; `screen.orientation.lock('landscape')` is attempted and its rejection is ignored.
- Gameplay never depends on capacity. Presets change counts and visual budgets only.
- The probe leaves about 40 percent of the frame budget free (target frame time 10 ms at 60 Hz) and never steps more than once per 3 seconds. It runs underneath real play, never as a blocking screen.
- Effects sliders read 100 percent at the tuned default and range 0 to 300 percent. Reduced motion is opt-in and defaults off.
- Music is procedural, four-on-the-floor, 124 to 134 beats per minute, and scheduled at least 100 ms ahead using `AudioContext.currentTime`; no `setTimeout`-driven notes.
- Tests inject time and fake the audio context; no wall-clock assertions.
- Commit after every task; messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A phone that throttles after two minutes must step down smoothly (particles, bloom, then capacity) without a hitch longer than one frame or a device loss. Pinned in Tasks C1 and C2.
2. Rotating to portrait mid-run must pause the game, show the overlay, and resume on rotation back without losing the run. Pinned in Task C4.
3. Audio must stay silent until the start gesture and must not throw on browsers that suspend the context on tab switch; resume on focus. Pinned in Task C5.
4. A lab URL with a malformed hash must load defaults and not crash. Pinned in Task C6.
5. Touch sticks must not fire when a thumb lands on the HUD or the bomb button. Pinned in Task C7.

---

## Phase 5: Presets and probe

### Task C1: Presets, probe, and persistence

**Files:**
- Create: `src/settings/presets.js`, `src/settings/probe.js`, `src/settings/storage.js`, `tests/settings/presets.test.js`, `tests/settings/probe.test.js`, `tests/settings/storage.test.js`

**Interfaces:**
- `presets.js`: `PRESETS` ordered low to high: `phoneLow { capacity: 65536, particleCapacity: 32768, neighborRadius: 0.12, bloomQuality: 'low', simulationRate: 'half' }`, `phoneHigh { 131072, 65536, 0.1, 'medium', 'full' }`, `desktop { 524288, 131072, 0.1, 'high', 'full' }`, `desktopUltra { 2097152, 262144, 0.08, 'high', 'full' }`; `initialPresetFor({ isMobile, maxStorageBufferBindingSize }) -> name` (mobile gets `phoneLow`, desktop `desktop`, and never a preset whose agent buffer exceeds half the binding limit); `stepPreset(name, direction) -> name`.
- `probe.js`: `class FrameTimeProbe { constructor({ targetMilliseconds = 10, warmupFrames = 120, windowFrames = 180, minimumSecondsBetweenSteps = 3, downRatio = 1.35, upRatio = 0.6 }); recordFrame(frameMilliseconds, nowSeconds) -> 'up' | 'down' | null }` returning `'down'` when the window's 90th percentile exceeds `target * downRatio`, `'up'` when the window's 90th percentile is below `target * upRatio`, and null otherwise, never within the warmup, never twice within the minimum interval; `reset()`.
- `storage.js`: `class SettingsStore { constructor({ storage = localStorage, key = 'murmuration.settings.v1' }); load() -> Settings ; save(settings) }` with defaults `{ preset: null, adapterKey: null, effects: 100, shake: 100, music: 80, effectsVolume: 80, reducedMotion: false, stickDeadZone: 0.15, stickRadius: 1.0 }`; a malformed stored value yields defaults.

- [ ] **Step 1: Write failing tests:** `initialPresetFor` mobile returns `phoneLow`, desktop returns `desktop`, and a 64 MiB binding limit caps `desktopUltra` down to `desktop`; probe returns null during warmup, `'down'` after a window at 16 ms, then null for 3 seconds, then `'up'` after a window at 4 ms; `SettingsStore.load` with garbage JSON returns defaults and `save` then `load` round-trips.
- [ ] **Step 2: Run `npm test`; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`; expect PASS.**
- [ ] **Step 5: Commit** `Add quality presets, frame-time probe, and settings persistence`.

### Task C2: Apply presets live

**Files:**
- Create: `src/game/quality.js`, `tests/game/quality.test.js`, `tests/browser/quality.mjs`
- Modify: `src/game/game.js`, `src/render/renderer.js`, `src/render/glyphs.js`, `src/render/shaders/glyphs.wgsl`, `src/sim/simulation.js`

**Interfaces:**
- `class QualityController { constructor({ game, store, probe, presets = PRESETS }); start(initialName) ; onFrame(frameMilliseconds, nowSeconds) ; async apply(name) ; get current }`. `apply` runs between frames: `simulation.recreateWithCapacity`, `particlePool.resize`, `renderer.setBloomQuality`, `simulation.setNeighborRadius`, `game.setSimulationRate`, then persists `preset` with the adapter key. Down steps first reduce particles and bloom (a sub-step inside the same preset), then capacity.
- Half-rate simulation: the simulation steps every other frame; the glyph shader reads both the previous and current agent buffers and interpolates by `alpha`; `Simulation` exposes `previousAgentsBuffer`.
- Frame time comes from `performance.now` deltas by default and from GPU timestamp queries when `hasTimestampQuery`.

- [ ] **Step 1: Write failing tests** with fakes: a `'down'` from the probe first halves particles and lowers bloom, a second `'down'` steps the preset; `apply` persists; `apply` of the current preset is a no-op.
- [ ] **Step 2: Write `tests/browser/quality.mjs`:** start at `desktop`, step down to `phoneHigh` mid-run, assert alive agents survive within 5 percent, no console errors, and the next 10 frames all render (frame counter advances).
- [ ] **Step 3: Run both; expect FAIL. Implement. Run; expect pass.**
- [ ] **Step 4: Commit** `Apply quality presets live with half-rate interpolation`.

## Phase 6: Entry, settings, and audio

### Task C3: Settings panel

**Files:**
- Create: `src/ui/settings.js`, `src/ui/settings.css`, `tests/ui/settings.test.js`
- Modify: `src/main.js`, `src/render/renderer.js` (effects and shake scale), `src/input/touch.js` (dead zone and radius)

**Interfaces:**
- `createSettingsPanel({ store, onChange, presets, onRerunProbe }) -> { element, open(), close(), isOpen }`: preset select, `Effects` and `Shake` sliders 0 to 300 reading `100%` at default, `Music` and `Effects volume` 0 to 100, `Reduced motion` checkbox, `Stick dead zone` and `Stick size` sliders, `Re-run probe` button. `onChange(settings)` fires on every change and the store saves.
- Effects slider maps to particle multiplier (`effects / 100`) and bloom strength; shake maps to the impulse strength multiplier; reduced motion disables trails and halves particles.

- [ ] **Step 1: Write failing tests** with the DOM stub from Plan B's HUD test: slider at default shows `100%`; changing a slider calls `onChange` with the new value and the store's `save` once.
- [ ] **Step 2: Run `npm test`; expect FAIL. Implement and wire. Run; expect PASS and smoke ok.**
- [ ] **Step 3: Commit** `Add settings panel with calibrated sliders`.

### Task C4: Menu, one-tap start, landscape lock, pause

**Files:**
- Create: `src/ui/menu.js`, `src/ui/rotateOverlay.js`, `src/ui/menu.css`, `tests/ui/menu.test.js`, `tests/ui/rotateOverlay.test.js`
- Modify: `src/main.js`, `src/game/game.js`

**Interfaces:**
- `createRotateOverlay({ screenObject = screen, matchMedia = window.matchMedia, isMobile }) -> { element, update() -> boolean }` returning true when the overlay is showing (mobile and portrait); calls `screenObject.orientation.lock('landscape').catch(() => {})` once.
- `createMenu({ onStart, onLab, onSettings }) -> { element, show(), hide() }`: title, `Play` (large, also triggered by any tap on the arena, Enter, Space, or a gamepad face button), `Lab`, `Settings`. `onStart` is the single gesture that also calls `audio.unlock()` (Task C5).
- `Game` gains `pause()` and `resume()`; `main.js` pauses on `visibilitychange` hidden, window blur, Escape, the pause button, and when the rotate overlay shows; resumes on gesture.

- [ ] **Step 1: Write failing tests:** overlay `update` returns true for mobile portrait and false for desktop portrait; `lock` is called once; menu `Play` calls `onStart` once per click.
- [ ] **Step 2: Run `npm test`; expect FAIL. Implement and wire. Run; expect PASS. Extend smoke: the page shows the menu, a click starts play, and `stats.score > 0` after 600 frames; a mobile-emulated portrait load (viewport 390 by 844, mobile user agent) shows the overlay and does not start.**
- [ ] **Step 3: Commit** `Add menu, one-tap start, landscape overlay, and pause`.

### Task C5: Procedural music and effects

**Files:**
- Create: `src/audio/audio.js`, `src/audio/music.js`, `src/audio/sfx.js`, `src/audio/sequencer.js`, `tests/audio/sequencer.test.js`, `tests/audio/music.test.js`
- Modify: `src/game/game.js`, `src/main.js`

**Interfaces:**
- `audio.js`: `class AudioEngine { constructor({ contextFactory = () => new AudioContext() }); unlock() ; get context ; setMusicVolume(0..1) ; setEffectsVolume(0..1) ; resume() ; suspend() }` creating the context on `unlock` only.
- `sequencer.js`: `class StepSequencer { constructor({ stepsPerBar = 16, lookaheadSeconds = 0.1, scheduleIntervalSeconds = 0.025 }); setTempo(beatsPerMinute) ; update(currentTime, scheduleStep(stepIndex, stepTime)) }` scheduling every step whose time falls before `currentTime + lookaheadSeconds` exactly once, in order, and surviving large jumps in `currentTime` by skipping missed steps.
- `music.js`: `class ProceduralMusic { constructor(engine); start() ; stop() ; setIntensity(0..1) ; cue(name: 'pickup' | 'expiry' | 'death' | 'bomb') ; update(currentTime) }`: kick on every beat, closed hat on offbeats, open hat every fourth, a sub bass following a four-bar progression, a lead that enters above intensity 0.4; intensity maps to tempo `124 + 10 * intensity`, lowpass cutoff on the bass and lead, and layer gains; `pickup` is a one-bar riser, `expiry` drops the lead and hats for two bars, `death` is a two-beat dropout, `bomb` a crash.
- `sfx.js`: `class EffectsSynth { constructor(engine); weaponFire(kind, tier) ; kills(count) ; pickup() ; bomb() ; death() ; expiry() }` with rate limiting so `kills` plays at most 8 voices per second scaled in gain by `log2(1 + count)`.
- `Game` sets intensity to `clamp(0.2 + 0.1 * (multiplierIndex) + 0.4 * aliveFraction, 0, 1)` each frame and cues on the matching events.

- [ ] **Step 1: Write failing tests** with a fake context (`currentTime` settable, `createOscillator`/`createGain` returning stubs that record `start(time)`): sequencer schedules steps 0 to 3 for a 0.1 s lookahead at 128 bpm and never schedules a step twice; a jump of 10 seconds in `currentTime` skips ahead without scheduling 300 steps; `ProceduralMusic.setIntensity(0)` leaves the lead gain at 0 and `setIntensity(1)` sets tempo 134.
- [ ] **Step 2: Run `npm test`; expect FAIL. Implement and wire. Run; expect PASS. Smoke: no console errors with audio unlocked by the start click.**
- [ ] **Step 3: Listen in Chrome for one minute: the music must lock to the beat, intensity must audibly change with the multiplier, and expiry must be felt as a drop. Write what you changed after listening in the report.**
- [ ] **Step 4: Commit** `Add procedural techno and synthesized effects`.

## Phase 7: Lab, touch polish, and shipping

### Task C6: Lab mode

**Files:**
- Create: `src/ui/lab.js`, `src/ui/labPresets.js`, `tests/ui/labPresets.test.js`
- Modify: `src/ui/debugPanel.js` (becomes the lab panel), `src/game/game.js`, `src/game/pickups.js`

**Interfaces:**
- `labPresets.js`: `encodeMix(mix) -> string` (URL-safe base64 of compact JSON), `decodeMix(string) -> mix | null` (null on any error), `BUNDLED_MIXES` (`allChasers`, `mixedFive`, `predatorsVsPrey`, `latticeStorm`, plus the shipped default), `saveMix(store, name, mix)`, `listMixes(store)`.
- Lab mode: entered from the menu; the lab panel is open; a `Watch` toggle disables weapons, spawning pressure follows the panel's alive target, and the player point follows the pointer; a `Play` toggle runs the full game with the current mix; `Share` writes `#mix=<encoded>` to the URL; loading a URL with `#mix=` applies it (or defaults when malformed). The panel exposes the same-species toggle, the coarse-field toggle, species shares, all rule weights, the matrix, neighbor radius, sim rate, and the renderer sliders.
- Pickup placement now uses a coarse-field readback every 15 frames (species density channels only) to pick the spawn direction with the lowest density among 8 candidates. `PickupDirector.update` accepts `densityAt(x, y)`.

- [ ] **Step 1: Write failing tests:** `encodeMix` then `decodeMix` round-trips; `decodeMix('%%%')` and `decodeMix(encode of wrong shape)` return null; `listMixes` returns bundled plus saved names.
- [ ] **Step 2: Run `npm test`; expect FAIL. Implement and wire. Run; expect PASS. Smoke: loading `/#mix=<malformed>` renders and logs no errors.**
- [ ] **Step 3: Commit** `Add lab mode with shareable mixes and density-aware pickups`.

### Task C7: Touch polish and mobile smoke

**Files:**
- Create: `src/ui/touchOverlay.js`, `tests/input/touchZones.test.js`, `tests/browser/mobile-smoke.mjs`
- Modify: `src/input/touch.js`, `src/ui/hud.css`, `index.html`

**Interfaces:**
- `touchOverlay.js`: draws the floating stick bases and knobs at the current touch origins (DOM elements, pointer-events none) and the bomb button in the lower right band; the bomb button is a real element that captures its touch so the aim stick never starts under it. `touch.js` ignores touches that start on elements marked `data-touch-exclusive`.
- Haptics: `navigator.vibrate?.(10)` on bomb and death when available.
- `mobile-smoke.mjs` runs the page under Playwright mobile emulation at 844 by 390 and 915 by 412 with touch, starts with a tap, drives both sticks for 300 frames, asserts `stats.score > 0`, no console errors, and that a tap on the bomb button decrements `bombs` without producing an aim vector.

- [ ] **Step 1: Write failing tests:** a touch starting on an exclusive element yields no stick; a touch on the right half produces aim; two simultaneous touches drive both sticks.
- [ ] **Step 2: Run `npm test`; expect FAIL. Implement. Run `npm test` and `node tests/browser/mobile-smoke.mjs`; expect PASS.**
- [ ] **Step 3: Commit** `Polish touch controls and add mobile smoke coverage`.

### Task C8: Shipping documentation and smoke checklist

**Files:**
- Create: `SMOKE.md`
- Modify: `README.md`, `AGENTS.md`, `index.html` (title, description meta, theme color)

- [ ] **Step 1: Write `SMOKE.md`:** the owner's phone checklist for a pull request preview (open the preview link on the foldable Android in Chrome and on an iPhone in Safari; rotate; tap to start; sticks; bomb; pick up a weapon and let it expire; die once; check frame rate feels smooth after two minutes; note which preset the probe chose from the settings panel). Keep it factual, no narrative.
- [ ] **Step 2: Update docs affected by this plan:** run the docs-update check across `README.md`, `AGENTS.md`, inline comments; README gains Settings, Lab, Audio sections and the preset table; AGENTS gains the audio scheduling rule and the probe contract.
- [ ] **Step 3: Run `npm test`, `npm run smoke`, `node tests/browser/mobile-smoke.mjs`; expect all PASS.**
- [ ] **Step 4: Commit** `Document settings, lab, audio, and the phone smoke checklist`.

---

## Self-review notes

- Spec coverage for this plan's scope: instant start with one gesture that unlocks audio (C4, C5), landscape lock and rotate overlay (C4), pause on focus loss (C4), probe under real play with live stepping and thermal headroom (C1, C2), presets shown and editable (C3), calibrated sliders and reduced motion opt-in (C3), half-rate sim with interpolation (C2), procedural four-on-the-floor music driven by multiplier and density with pickup and expiry cues (C5), synthesized effects scaled by kill count (C5), lab mode as a shipped mode with bundled presets, local saves, URL sharing, watch mode (C6), pickup placement away from dense mass (C6), touch sticks, bomb button, no gestures (C7), phone testing via previews (C8).
- Left out on purpose: PWA install, leaderboards, beat-synced visuals (nice-to-have after the owner plays it).
- Names reused: `PRESETS`, `initialPresetFor`, `stepPreset`, `FrameTimeProbe`, `SettingsStore`, `QualityController`, `createSettingsPanel`, `createMenu`, `createRotateOverlay`, `AudioEngine`, `StepSequencer`, `ProceduralMusic`, `EffectsSynth`, `encodeMix`, `decodeMix`, `BUNDLED_MIXES`, `Game.pause`, `Game.resume`, `Game.setSimulationRate`.
