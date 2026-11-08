// Browser smoke test. Serves the page with the Vite dev server (see server.mjs).
// SMOKE_URL, when set, skips spawning and uses that URL instead. Either way the page gets
// ?probe=off&capacity=262144 (unless the URL already sets them), so the quality probe cannot
// change the capacity under the checks.
// Usage: node tests/browser/smoke.mjs [--frames N] [--play N | --pulse | --sweep | --corridor | --bursts]
// Reads the composited frame back through window.__murmuration.capture (headless Chromium may never
// composite a WebGPU canvas, so page.screenshot() is not trusted) and writes artifacts/smoke.png and
// artifacts/smoke-zoom.png (4x inspect zoom, trails off) and artifacts/smoke-ships.png (1x, trails
// off) while the game waits in Ready, then clicks to start the run, whose arena clear floods kill
// particles, and writes artifacts/smoke-kill.png (trails off, glyphs hidden: particles and grid only).
// --play N instead drives a synthetic gamepad (navigator.getGamepads stubbed before the page
// loads, read by the real input path): the left stick moves the ship 2 units left of center and
// starts the run, then the right stick fires toward the arena center for N frames; the score
// must be positive, the box around the ship (captured 60 frames into the fire, while the ship is
// alive) brighter than the arena mean, the first death after fire frame 300 or never, a run of at
// least 1800 frames must still kill and score after fire frame 900, and no console errors. It also
// writes artifacts/energy-balls.png (1x, trails off, at the ship capture) and, 1 s after the fire
// stops, measures the base gun's tunnel (owner ruling R19) with the C0b corridor metric: the
// coarse-field density along the fire line must be under half the control rows' while the ship
// still lives.
// --pulse instead arms the pulse weapon through the debug panel's arm select, fires toward the arena
// center with the synthetic gamepad, and writes artifacts/pulse-ring.png, captured the moment the
// stats report a ring detonation (ringsThisFrame), so a ring is expanding on screen.
// --sweep (task C0d) arms the beam the same way, fires it, turns the aim 120 degrees in 4 frames
// and writes artifacts/beam-sweep.png of the frame after the turn: a swept fan, not comb lines.
// --corridor and --bursts (task C0b, smoke-clearing.mjs): the beam corridor density metric, and the
// kill burst and bomb captures (artifacts/kill-burst.png, artifacts/bomb-burst.png).
// Exit codes: 0 ok, 1 failure (errors or timeout), 2 WebGPU adapter unavailable.
// Liveness: every page.evaluate is bounded by EVALUATE_TIMEOUT_MILLISECONDS (a capture resolves only
// on a later rendered frame, so a renderer that throws or stops would leave it pending forever),
// and the whole run by SMOKE_DEADLINE_MILLISECONDS, after which it closes the browser and the
// server and exits 1.
import { mkdir, writeFile } from 'node:fs/promises';
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';
import { captureBursts, checkCorridor, corridorDensities } from './smoke-clearing.mjs';

const SMOKE_SEARCH = { probe: 'off', capacity: '262144' };
const READY_TIMEOUT_MILLISECONDS = 10_000;
const EVALUATE_TIMEOUT_MILLISECONDS = 20_000;
const SMOKE_DEADLINE_MILLISECONDS = 150_000;
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_NO_ADAPTER = 2;
const MINIMUM_ALIVE_TOTAL = 1000;
// Something is drawn, and it is not a white smear.
const MINIMUM_LUMINANCE = 0.02;
const MAXIMUM_LUMINANCE = 0.6;
const RESIZE_WINDOW_FRAMES = 60;
// A resize recreates (clears) the trail textures; 20 frames at the default decay 0.6 bring them back
// to their steady state (0.6^20 is under 0.01 percent), so the luminance capture after the resize
// check is not read from half-built trails.
const TRAIL_SETTLE_FRAMES = 20;
const RESIZE_TOLERANCE = 0.05;
const PORTRAIT_VIEWPORT = { width: 800, height: 1200 };
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const MAXIMUM_BAND_LUMINANCE = 0.01;
// The start click lands this many frames into the flood capture's 30 settle frames
// (CAPTURE_SETTLE_FRAMES in capture-hook.js), so the capture sees a young flood.
const START_CLICK_SETTLE_FRAMES = 24;
const START_CLICK_HOLD_FRAMES = 3;
// The Ready arena holds only the ramp floor (about 2,700 agents at the default capacity, Plan C task
// C0); since task C0b every kill bursts 12 bright particles, and the measured rise is about 0.09
// (0.0430 -> 0.1308), well clear of the margin.
const FLOOD_MARGIN = 0.001;
const FLOOD_SETTINGS = { trailDecay: 0, shipArenaFraction: 0 };
// --play: the ship moves left at full stick for this many frames (6 units per second, about 2 units
// at 60 frames per second), then fires to the right, toward the arena center.
const PLAY_MOVE_FRAMES = 20;
const PLAY_TIMEOUT_MILLISECONDS = 60_000;
// The box around the ship, in device pixels, must be brighter than the arena as a whole.
const SHIP_BOX_DEVICE_PIXELS = 40;
// --play: fire frames before the ship capture.
const PLAY_SHIP_CAPTURE_FRAMES = 60;
// --play acceptance (owner ruling R1, Plan C task C0): the stationary firing ship's first death
// comes after this many fire frames or never, and a run of at least PLAY_LATE_RUN_FRAMES frames
// still kills and scores after PLAY_LATE_CHECK_FRAMES (the ramp must not empty the game).
const PLAY_MINIMUM_FIRST_DEATH_FRAMES = 300;
const PLAY_LATE_RUN_FRAMES = 1800;
const PLAY_LATE_CHECK_FRAMES = 900;
// --play tunnel metric: frames after the fire stops, the band half height around the ship's row
// (the 3 ball fan stays within it for the first few units) and where the band starts past the ship.
const PLAY_TUNNEL_SETTLE_FRAMES = 60;
const PLAY_TUNNEL_HALF_HEIGHT = 0.3;
const PLAY_TUNNEL_START_OFFSET = 1;
const PLAY_TUNNEL_END_X = 15;
const PLAY_TUNNEL_MAXIMUM_RATIO = 0.5;
const ARTIFACTS_DIRECTORY = new URL('../../artifacts/', import.meta.url);

async function writeDataUrl(name, dataUrl) {
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  await writeFile(new URL(name, ARTIFACTS_DIRECTORY), Buffer.from(base64, 'base64'));
}

function parseFrameCount(argumentList) {
  const index = argumentList.indexOf('--frames');
  if (index === -1) return 120;
  const frames = Number.parseInt(argumentList[index + 1], 10);
  if (!Number.isInteger(frames) || frames < 0) throw new Error('--frames needs a non-negative integer');
  return frames;
}

// Rejects when promise has not settled within milliseconds; the timer never outlives the race.
function withTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${milliseconds} ms`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function evaluateWithin(page, label, pageFunction, argument) {
  return withTimeout(page.evaluate(pageFunction, argument), EVALUATE_TIMEOUT_MILLISECONDS, label);
}

function parsePlayFrames(argumentList) {
  const index = argumentList.indexOf('--play');
  if (index === -1) return null;
  const frames = Number.parseInt(argumentList[index + 1], 10);
  if (!Number.isInteger(frames) || frames <= 0) throw new Error('--play needs a positive integer');
  return frames;
}

function waitForFrame(page, target) {
  return page.waitForFunction((frame) => window.__murmuration.frame >= frame, target, { timeout: READY_TIMEOUT_MILLISECONDS });
}

// Resizes to a portrait viewport and back, checking the agent count survives, the arena letterboxes
// and the bands stay black. Returns a failure message, or null. The spawner ramps the alive target
// (easing in over 120 seconds, so the count still grows a little per 60 frames at this point), so
// the check does not compare counts directly. Instead the growth over the 60 frames after the
// resize must match the growth over the 60 frames before it, within 5 percent of the count.
async function checkResize(page) {
  const readFrame = () => evaluateWithin(page, 'reading the frame count', () => window.__murmuration.frame);
  const readAlive = async () => (await evaluateWithin(page, 'reading stats', () => window.__murmuration.stats)).aliveTotal;
  const start = await readFrame();
  const earlier = await readAlive();
  await waitForFrame(page, start + RESIZE_WINDOW_FRAMES);
  const before = await readAlive();
  await page.setViewportSize(PORTRAIT_VIEWPORT);
  const resized = await readFrame();
  await waitForFrame(page, resized + RESIZE_WINDOW_FRAMES);
  const after = await readAlive();
  const portrait = await evaluateWithin(page, 'the portrait capture', () => window.__murmuration.capture());
  const { arenaRect } = portrait;
  const expected = { x: 0, y: 375, width: 800, height: 450 };
  if (portrait.width !== PORTRAIT_VIEWPORT.width || JSON.stringify(arenaRect) !== JSON.stringify(expected)) {
    return `smoke: expected ${PORTRAIT_VIEWPORT.width}px canvas with arenaRect ${JSON.stringify(expected)}, got ${portrait.width}x${portrait.height} ${JSON.stringify(arenaRect)}`;
  }
  const band = portrait.bandLuminance;
  if (!(band < MAXIMUM_BAND_LUMINANCE)) return `smoke: expected top band luminance < ${MAXIMUM_BAND_LUMINANCE}, got ${band}`;
  const growthBefore = before - earlier;
  const growthAfter = after - before;
  if (Math.abs(growthAfter - growthBefore) > RESIZE_TOLERANCE * before) {
    return `smoke: aliveTotal ${earlier} -> ${before} before the resize and ${before} -> ${after} after it differ by more than ${RESIZE_TOLERANCE * 100} percent`;
  }
  console.log(`smoke: resize aliveTotal ${earlier} -> ${before} -> ${after}, arenaRect ${JSON.stringify(arenaRect)}, top band luminance ${band.toFixed(4)}`);
  await page.setViewportSize(DEFAULT_VIEWPORT);
  const restored = await readFrame();
  await waitForFrame(page, restored + TRAIL_SETTLE_FRAMES);
  return page.consoleErrors.length > 0 ? `smoke: console errors after resize: ${page.consoleErrors.join(' | ')}` : null;
}

// Start clear check. The game waits in Ready until the first gesture; a click at the canvas
// center starts the run, and the start clears the arena with the kill-all pass, whose splash floods
// particles everywhere. Two captures with FLOOD_SETTINGS (overrides settle 30 frames before
// each capture): one calm, and one whose settle frames contain the click, START_CLICK_SETTLE_FRAMES
// in, so the flood is a few frames old when captured. Trails are off so history cannot saturate the
// arena, and glyphs are hidden (shipArenaFraction 0) because the clear also removes every glyph.
// The arena mean must rise by FLOOD_MARGIN and the phase must go from ready to playing. Returns a
// failure message, or null.
async function checkStartClear(page) {
  const phaseBefore = (await evaluateWithin(page, 'reading the phase', () => window.__murmuration.stats)).phase;
  if (phaseBefore !== 'ready') return `smoke: expected the game to wait in phase ready before any input, got ${phaseBefore}`;
  const captureFlood = () => evaluateWithin(page, 'a start clear capture', (settings) => window.__murmuration.capture({ settings }), FLOOD_SETTINGS);
  const calm = await captureFlood();
  const bounds = await page.locator('#arena').boundingBox();
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  await page.mouse.move(centerX, centerY);
  const settleStart = await evaluateWithin(page, 'reading the frame', () => window.__murmuration.frame);
  const floodCapture = captureFlood();
  await waitForFrame(page, settleStart + START_CLICK_SETTLE_FRAMES);
  // Held for a few frames, as a person's click is: input samples the button once per step.
  await page.mouse.down();
  try {
    await waitForFrame(page, settleStart + START_CLICK_SETTLE_FRAMES + START_CLICK_HOLD_FRAMES);
  } finally {
    await page.mouse.up();
  }
  const flood = await floodCapture;
  await writeDataUrl('smoke-kill.png', flood.pngDataUrl);
  const phaseAfter = (await evaluateWithin(page, 'reading the phase', () => window.__murmuration.stats)).phase;
  console.log(`smoke: start clear (trails off, glyphs hidden) arena mean ${calm.meanLuminance.toFixed(4)} -> ${flood.meanLuminance.toFixed(4)}, phase ${phaseBefore} -> ${phaseAfter}`);
  if (phaseAfter === 'ready') return 'smoke: expected the click to start the run, the phase is still ready';
  if (!(flood.meanLuminance - calm.meanLuminance > FLOOD_MARGIN)) {
    return `smoke: expected the start clear to raise the arena mean luminance by more than ${FLOOD_MARGIN}`;
  }
  return page.consoleErrors.length > 0 ? `smoke: console errors after the start: ${page.consoleErrors.join(' | ')}` : null;
}

const PULSE_TIMEOUT_MILLISECONDS = 60_000;

// Arms the pulse weapon (tier 3) from the debug panel, fires right from 2 units left of center, and
// captures the frame right after the first ring detonation shows in the stats. Returns a failure
// message, or null.
// Moves the ship 2 units left (starting the run), then arms weapon from the debug panel.
async function armFromPanel(page, weapon) {
  const begin = await evaluateWithin(page, 'reading the frame', () => window.__murmuration.frame);
  await setSticks(page, [-1, 0, 0, 0]);
  await waitForFrame(page, begin + PLAY_MOVE_FRAMES);
  await page.keyboard.press('Backquote');
  await page.locator('select', { has: page.locator(`option[value="${weapon}"]`) }).selectOption(weapon);
  await page.keyboard.press('Backquote');
  await page.evaluate(() => document.activeElement?.blur());
}

async function checkPulse(page) {
  await armFromPanel(page, 'pulse');
  await setSticks(page, [0, 0, 1, 0]);
  const captured = await withTimeout(page.evaluate(() => new Promise((resolve) => {
    const watch = () => {
      if ((window.__murmuration.stats?.ringsThisFrame ?? 0) > 0) resolve(window.__murmuration.capture());
      else requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  })), PULSE_TIMEOUT_MILLISECONDS, 'waiting for a pulse ring');
  await setSticks(page, [0, 0, 0, 0]);
  await writeDataUrl('pulse-ring.png', captured.pngDataUrl);
  console.log(`smoke: pulse ring captured, arena mean ${captured.meanLuminance.toFixed(4)}`);
  return page.consoleErrors.length > 0 ? `smoke: console errors during the pulse capture: ${page.consoleErrors.join(' | ')}` : null;
}

// --sweep: the beam fires at the first angle for SWEEP_HOLD_FRAMES, then the aim turns
// SWEEP_DEGREES in SWEEP_TURN_FRAMES animation frames and the next frame is captured.
const SWEEP_START_DEGREES = -60;
const SWEEP_DEGREES = 120;
const SWEEP_TURN_FRAMES = 4;
const SWEEP_HOLD_FRAMES = 20;

async function checkSweep(page) {
  await armFromPanel(page, 'beam');
  const radians = (degrees) => (degrees * Math.PI) / 180;
  await setSticks(page, [0, 0, Math.cos(radians(SWEEP_START_DEGREES)), Math.sin(radians(SWEEP_START_DEGREES))]);
  await waitForFrame(page, (await evaluateWithin(page, 'reading the frame', () => window.__murmuration.frame)) + SWEEP_HOLD_FRAMES);
  const captured = await evaluateWithin(page, 'the sweep capture', ({ start, degrees, frames }) => new Promise((resolve) => {
    let frame = 0;
    const turn = () => {
      frame += 1;
      const angle = ((start + (degrees * frame) / frames) * Math.PI) / 180;
      window.__smokeGamepad.axes = [0, 0, Math.cos(angle), Math.sin(angle)];
      if (frame < frames) requestAnimationFrame(turn);
      else resolve(window.__murmuration.capture());
    };
    requestAnimationFrame(turn);
  }), { start: SWEEP_START_DEGREES, degrees: SWEEP_DEGREES, frames: SWEEP_TURN_FRAMES });
  await setSticks(page, [0, 0, 0, 0]);
  await writeDataUrl('beam-sweep.png', captured.pngDataUrl);
  console.log(`smoke: beam sweep captured, arena mean ${captured.meanLuminance.toFixed(4)}`);
  return page.consoleErrors.length > 0 ? `smoke: console errors during the sweep capture: ${page.consoleErrors.join(' | ')}` : null;
}

// Replaces navigator.getGamepads, before any page script runs, with one standard pad whose axes
// the smoke sets through window.__smokeGamepad.
function installSyntheticGamepad() {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
  const gamepad = { id: 'smoke synthetic gamepad', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons };
  window.__smokeGamepad = gamepad;
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => [gamepad] });
}

async function setSticks(page, axes) {
  await evaluateWithin(page, 'setting the sticks', (values) => { window.__smokeGamepad.axes = values; }, axes);
}

// Moves the ship 2 units left (the first stick push starts the run), then fires right toward the
// arena center for frames frames. Returns a failure message, or null.
async function checkPlay(page, frames) {
  const begin = await evaluateWithin(page, 'reading the frame', () => window.__murmuration.frame);
  await setSticks(page, [-1, 0, 0, 0]);
  await waitForFrame(page, begin + PLAY_MOVE_FRAMES);
  await setSticks(page, [0, 0, 1, 0]);
  const firing = await evaluateWithin(page, 'reading the frame', () => window.__murmuration.frame);
  // The first frame that leaves Playing (a death) while the ship sits still and fires.
  await evaluateWithin(page, 'watching for the first death', () => {
    window.__smokeFirstDeathFrame = null;
    const watch = () => {
      const phase = window.__murmuration.stats?.phase;
      if (phase !== undefined && phase !== 'playing' && phase !== 'ready') {
        window.__smokeFirstDeathFrame = window.__murmuration.frame;
        return;
      }
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  // Captured early in the fire, while the ship is surely alive (it hides from a death until its
  // respawn, and a run can end before frames frames): the ship and its fire must stand out.
  await waitForFrame(page, firing + Math.min(PLAY_SHIP_CAPTURE_FRAMES, frames));
  const early = await evaluateWithin(page, 'reading stats', () => window.__murmuration.stats);
  const shipBox = await evaluateWithin(page, 'placing the ship box', ({ playerX, playerY, size }) => {
    const rect = window.__murmuration.arenaRect();
    return {
      x: Math.round(rect.x + (playerX / rect.arenaWidth) * rect.width - size / 2),
      y: Math.round(rect.y + (playerY / rect.arenaHeight) * rect.height - size / 2),
      width: size,
      height: size,
    };
  }, { playerX: early.playerX, playerY: early.playerY, size: SHIP_BOX_DEVICE_PIXELS });
  const capture = await evaluateWithin(page, 'the play capture', (regions) => window.__murmuration.capture({ regions }), [shipBox]);
  await writeDataUrl('smoke-play.png', capture.pngDataUrl);
  const balls = await evaluateWithin(page, 'the energy ball capture', () => window.__murmuration.capture({ settings: { trailDecay: 0 } }));
  await writeDataUrl('energy-balls.png', balls.pngDataUrl);
  const shipLuminance = capture.regionLuminances[0];
  console.log(`smoke: play ship box luminance ${shipLuminance.toFixed(4)}, arena mean ${capture.meanLuminance.toFixed(4)}, phase ${early.phase}`);
  let late = null;
  if (frames >= PLAY_LATE_RUN_FRAMES) {
    await page.waitForFunction((target) => window.__murmuration.frame >= target, firing + PLAY_LATE_CHECK_FRAMES, { timeout: PLAY_TIMEOUT_MILLISECONDS });
    late = await evaluateWithin(page, 'reading stats', () => window.__murmuration.stats);
  }
  await page.waitForFunction((target) => window.__murmuration.frame >= target, firing + frames, { timeout: PLAY_TIMEOUT_MILLISECONDS });
  const stats = await evaluateWithin(page, 'reading stats', () => window.__murmuration.stats);
  const firstDeathFrame = await evaluateWithin(page, 'reading the first death', () => window.__smokeFirstDeathFrame);
  await setSticks(page, [0, 0, 0, 0]);
  const tunnel = await measureTunnel(page, stats);
  console.log(firstDeathFrame === null
    ? `smoke: play first death: none in ${frames} frames of fire`
    : `smoke: play first death at fire frame ${firstDeathFrame - firing} (${((firstDeathFrame - firing) / 60).toFixed(1)} s at 60 Hz)`);
  console.log(`smoke: play ${frames} frames: score ${stats.score}, multiplier ${stats.multiplier}, lives ${stats.lives}, bombs ${stats.bombs}, armed ${stats.armed} ${stats.tier}, phase ${stats.phase}, aliveTotal ${stats.aliveTotal}`);
  if (late) console.log(`smoke: play fire frame ${PLAY_LATE_CHECK_FRAMES}: score ${late.score}, kills ${late.killsTotal}; at the end: score ${stats.score}, kills ${stats.killsTotal}`);
  if (page.consoleErrors.length > 0) return `smoke: console errors during play: ${page.consoleErrors.join(' | ')}`;
  if (!(stats.score > 0)) return `smoke: expected a positive score after ${frames} frames of fire, got ${stats.score}`;
  if (early.phase !== 'playing') return `smoke: expected the run to be playing at the ship capture, got ${early.phase}`;
  if (firstDeathFrame !== null && firstDeathFrame - firing <= PLAY_MINIMUM_FIRST_DEATH_FRAMES) {
    return `smoke: expected the first death after fire frame ${PLAY_MINIMUM_FIRST_DEATH_FRAMES} or never, got fire frame ${firstDeathFrame - firing}`;
  }
  if (late && !(stats.score > late.score && stats.killsTotal > late.killsTotal)) {
    return `smoke: expected kills and score growth after fire frame ${PLAY_LATE_CHECK_FRAMES}: score ${late.score} -> ${stats.score}, kills ${late.killsTotal} -> ${stats.killsTotal}`;
  }
  if (tunnel.failure) return tunnel.failure;
  if (!(shipLuminance > capture.meanLuminance)) {
    return `smoke: expected the ${SHIP_BOX_DEVICE_PIXELS}px box around the ship (${shipLuminance.toFixed(4)}) to be brighter than the arena mean (${capture.meanLuminance.toFixed(4)})`;
  }
  return null;
}

// The base gun's tunnel 1 s after the fire stops: the corridor metric along the ship's row from
// PLAY_TUNNEL_START_OFFSET past the ship to PLAY_TUNNEL_END_X. Returns { failure } (null when it
// passes, or when the ship died during the run, which clears the arena and voids the metric).
async function measureTunnel(page, statsAtStop) {
  const settleStart = await evaluateWithin(page, 'reading the frame', () => window.__murmuration.frame);
  await page.waitForFunction((target) => window.__murmuration.frame >= target, settleStart + PLAY_TUNNEL_SETTLE_FRAMES, { timeout: PLAY_TIMEOUT_MILLISECONDS });
  const field = Float32Array.from(await evaluateWithin(page, 'reading the coarse field', async () => Array.from(await window.__murmuration.game.simulation.readCoarseField())));
  const after = await evaluateWithin(page, 'reading stats', () => window.__murmuration.stats);
  const died = await evaluateWithin(page, 'reading the first death', () => window.__smokeFirstDeathFrame !== null);
  const densities = corridorDensities(field, statsAtStop.playerY, {
    halfHeight: PLAY_TUNNEL_HALF_HEIGHT, startX: statsAtStop.playerX + PLAY_TUNNEL_START_OFFSET, endX: PLAY_TUNNEL_END_X,
  });
  const text = `corridor ${densities.corridor.toFixed(3)}, control ${densities.control.toFixed(3)}, ratio ${densities.ratio.toFixed(3)}`;
  if (died || after.phase !== 'playing') {
    console.log(`smoke: play tunnel ${PLAY_TUNNEL_SETTLE_FRAMES} frames after the fire: not measured, the ship died during the run (${text})`);
    return { failure: null };
  }
  console.log(`smoke: play tunnel ${PLAY_TUNNEL_SETTLE_FRAMES} frames after the fire: ${text}`);
  if (!(densities.ratio < PLAY_TUNNEL_MAXIMUM_RATIO)) {
    return { failure: `smoke: expected the base gun tunnel under ${PLAY_TUNNEL_MAXIMUM_RATIO} of the control density 1 s after the fire, got ${text}` };
  }
  return { failure: null };
}

// Audio check. The start clear check's click is the page's first gesture, so it must have created the
// AudioContext and started the sequencer (the browser runs muted). Waits briefly for steps to be
// scheduled, then requires no console errors. Returns a failure message, or null.
async function checkAudioUnlocked(page) {
  const readAudio = () => evaluateWithin(page, 'reading audio state', () => {
    const { engine, music } = window.__murmuration.audio;
    return { state: engine.context?.state ?? null, steps: music.sequencer.nextStepIndex, hint: document.getElementById('audio-hint')?.textContent };
  });
  let audio = await readAudio();
  for (let attempt = 0; attempt < 20 && audio.steps < 8; attempt += 1) {
    await page.waitForTimeout(100);
    audio = await readAudio();
  }
  console.log(`smoke: audio context ${audio.state}, ${audio.steps} steps scheduled, hint "${audio.hint}"`);
  if (audio.state === null || audio.steps < 8) return `smoke: expected the audio to unlock on the start click and schedule steps, got ${JSON.stringify(audio)}`;
  return page.consoleErrors.length > 0 ? `smoke: console errors after the audio unlock: ${page.consoleErrors.join(' | ')}` : null;
}

// resources holds the server and browser so the deadline path can close them too.
async function closeResources(resources) {
  const { browser, server } = resources;
  resources.browser = null;
  resources.server = null;
  if (browser) await browser.close().catch(() => {});
  if (server) server.child.kill();
}

async function run(resources) {
  const frames = parseFrameCount(process.argv.slice(2));
  const playFrames = parsePlayFrames(process.argv.slice(2));
  try {
    let url = process.env.SMOKE_URL;
    if (!url) {
      resources.server = await startServer();
      url = resources.server.url;
    }
    const pageUrl = new URL(url);
    for (const [key, value] of Object.entries(SMOKE_SEARCH)) {
      if (!pageUrl.searchParams.has(key)) pageUrl.searchParams.set(key, value);
    }
    url = pageUrl.href;
    const launched = await launchWebGpuBrowser();
    resources.browser = launched.browser;
    const { page } = launched;
    const pulseMode = process.argv.includes('--pulse');
    const sweepMode = process.argv.includes('--sweep');
    const clearingMode = ['--corridor', '--bursts'].find((flag) => process.argv.includes(flag)) ?? null;
    if (playFrames !== null || pulseMode || sweepMode || clearingMode) await page.addInitScript(installSyntheticGamepad);

    await page.goto(url);
    const adapterAvailable = await evaluateWithin(page, 'the adapter probe', async () => {
      if (!navigator.gpu) return false;
      return (await navigator.gpu.requestAdapter()) !== null;
    });
    if (!adapterAvailable) {
      console.error('smoke: WebGPU adapter unavailable in headless Chromium (navigator.gpu missing or requestAdapter() returned null)');
      return EXIT_NO_ADAPTER;
    }

    try {
      await page.waitForFunction(() => window.__murmuration?.ready === true, null, { timeout: READY_TIMEOUT_MILLISECONDS });
      await page.waitForFunction(
        (target) => window.__murmuration.frame >= target,
        frames,
        { timeout: READY_TIMEOUT_MILLISECONDS },
      );
      await page.waitForFunction(() => window.__murmuration?.stats != null, null, { timeout: READY_TIMEOUT_MILLISECONDS });
    } catch (error) {
      console.error(`smoke: timed out waiting for ready, ${frames} frames and stats:${error.message.split('\n')[0]}`);
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }

    if (page.consoleErrors.length > 0) {
      console.error('smoke: console errors:');
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    if (clearingMode) {
      const helpers = { evaluateWithin, setSticks, writeDataUrl };
      const failure = clearingMode === '--corridor' ? await checkCorridor(page, helpers) : await captureBursts(page, helpers);
      if (failure) {
        console.error(failure);
        return EXIT_FAILURE;
      }
      console.log(`smoke: ok (${clearingMode.slice(2)})`);
      return EXIT_OK;
    }
    if (pulseMode || sweepMode) {
      const failure = pulseMode ? await checkPulse(page) : await checkSweep(page);
      if (failure) {
        console.error(failure);
        return EXIT_FAILURE;
      }
      console.log(`smoke: ok (${pulseMode ? 'pulse' : 'sweep'})`);
      return EXIT_OK;
    }
    if (playFrames !== null) {
      const playFailure = await checkPlay(page, playFrames);
      if (playFailure) {
        console.error(playFailure);
        return EXIT_FAILURE;
      }
      console.log('smoke: ok (play)');
      return EXIT_OK;
    }
    const stats = await evaluateWithin(page, 'reading stats', () => window.__murmuration.stats);
    if (!stats || !(stats.aliveTotal > MINIMUM_ALIVE_TOTAL)) {
      console.error(`smoke: expected stats.aliveTotal > ${MINIMUM_ALIVE_TOTAL}, got ${JSON.stringify(stats)}`);
      return EXIT_FAILURE;
    }
    const resizeFailure = await checkResize(page);
    if (resizeFailure) {
      console.error(resizeFailure);
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    const capture = await evaluateWithin(page, 'the main capture', () => window.__murmuration.capture());
    await writeDataUrl('smoke.png', capture.pngDataUrl);
    // Trails off so the 4x frame shows glyph shapes rather than motion smears.
    const zoomCapture = await evaluateWithin(page, 'the zoom capture', () => window.__murmuration.capture({ inspectZoom: 4, settings: { trailDecay: 0 } }));
    await writeDataUrl('smoke-zoom.png', zoomCapture.pngDataUrl);
    // The same at 1x, the visual gate that ships read as ships rather than dots at native size.
    const shipsCapture = await evaluateWithin(page, 'the 1x ships capture', () => window.__murmuration.capture({ settings: { trailDecay: 0 } }));
    await writeDataUrl('smoke-ships.png', shipsCapture.pngDataUrl);
    const luminance = capture.meanLuminance;
    if (!(luminance > MINIMUM_LUMINANCE && luminance < MAXIMUM_LUMINANCE)) {
      console.error(`smoke: expected ${MINIMUM_LUMINANCE} < arena mean luminance < ${MAXIMUM_LUMINANCE}, got ${luminance.toFixed(4)} (${capture.width}x${capture.height})`);
      return EXIT_FAILURE;
    }
    if (page.consoleErrors.length > 0) {
      console.error('smoke: console errors after capture:');
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    const startFailure = await checkStartClear(page);
    if (startFailure) {
      console.error(startFailure);
      return EXIT_FAILURE;
    }
    const audioFailure = await checkAudioUnlocked(page);
    if (audioFailure) {
      console.error(audioFailure);
      return EXIT_FAILURE;
    }
    const capturedStats = await evaluateWithin(page, 'reading stats', () => window.__murmuration.stats);
    console.log(`smoke: ok (aliveTotal ${stats.aliveTotal}, aliveTotal at capture ${capturedStats.aliveTotal}, arena mean luminance ${luminance.toFixed(4)})`);
    return EXIT_OK;
  } catch (error) {
    console.error(`smoke: ${error.message}`);
    return EXIT_FAILURE;
  } finally {
    await closeResources(resources);
  }
}

const resources = { server: null, browser: null };
let deadlineTimer;
const deadline = new Promise((resolve) => {
  deadlineTimer = setTimeout(() => {
    console.error(`smoke: the run did not finish within ${SMOKE_DEADLINE_MILLISECONDS} ms; failing`);
    resolve(EXIT_FAILURE);
  }, SMOKE_DEADLINE_MILLISECONDS);
});
const exitCode = await Promise.race([run(resources), deadline]);
clearTimeout(deadlineTimer);
await closeResources(resources);
process.exit(exitCode);
