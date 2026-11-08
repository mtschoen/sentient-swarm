// Menu browser smoke (Plan C task C4, owner ruling R17). Serves the page with the Vite dev server
// (server.mjs; SMOKE_PORT picks the port) and checks, on a desktop viewport:
//   - the title menu shows, and a click on the arena behind its buttons starts the run (exactly one
//     input), after which the ship steps left (KeyA for 20 frames, off the gate aim lane) and 600
//     frames of fire score above zero;
//   - Escape pauses mid-run: the menu shows, state.phase reads paused, the render frame counter keeps
//     advancing, the score and the simulation step counter stay frozen; arrow keys move the focus
//     ring; Settings opens over the pause menu (a slider is the top element at its own center), and
//     Escape, then the gamepad back button, close it back to the still paused pause menu; Escape
//     again resumes; O mid-run pauses under the panel; the gamepad Options button (button 9) pauses
//     as well;
//   - Quit to title (keyboard only) returns to the title menu in phase ready.
// and on a phone: a portrait load (390 by 844, mobile user agent) shows the rotate overlay and a tap
// does not start the run; a landscape run that rotates to portrait pauses behind the overlay and
// resumes on rotating back with its score intact.
// Saves artifacts/menu-title.png, menu-pause.png and rotate-overlay.png (page screenshots: the DOM
// overlays are part of them, the WebGPU canvas may be blank in headless Chromium).
// Exit codes: 0 ok, 1 failure, 2 WebGPU adapter unavailable.
import { mkdir, writeFile } from 'node:fs/promises';
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';

const SEARCH = '?probe=off&capacity=262144';
const READY_TIMEOUT_MILLISECONDS = 15_000;
const STEP_TIMEOUT_MILLISECONDS = 30_000;
const DEADLINE_MILLISECONDS = 180_000;
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_NO_ADAPTER = 2;
const PLAY_FRAMES = 600;
const PAUSED_FRAMES = 30;
const HOLD_FRAMES = 3;
// The ship steps left before firing so its fire lane is not the one the gates keep clear.
const STEP_LEFT_FRAMES = 20;
const SETTLE_FRAMES = 4;
const DESKTOP_VIEWPORT = { width: 1280, height: 720 };
const PHONE_PORTRAIT = { width: 390, height: 844 };
const PHONE_LANDSCAPE = { width: 844, height: 390 };
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const ARTIFACTS_DIRECTORY = new URL('../../artifacts/', import.meta.url);

async function savePng(name, bytes) {
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  await writeFile(new URL(name, ARTIFACTS_DIRECTORY), bytes);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const readStats = (page) => page.evaluate(() => window.__murmuration.stats);
const readFrame = (page) => page.evaluate(() => window.__murmuration.frame);
const readSteps = (page) => page.evaluate(() => window.__murmuration.game.simulation.frameSequence);
const isShown = (page, selector) => page.evaluate((query) => {
  const element = document.querySelector(query);
  return element !== null && !element.hidden && getComputedStyle(element).display !== 'none';
}, selector);
// Whether the settings panel is open and a slider is the topmost element at its own center.
const settingsOnTop = (page) => page.evaluate(() => {
  const panel = document.querySelector('.settings-panel');
  const slider = panel?.querySelector('input[type="range"]');
  if (!panel || panel.hidden || !slider) return false;
  const bounds = slider.getBoundingClientRect();
  return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === slider;
});
const settingsShown = (page) => page.evaluate(() => window.__murmuration.settings.isOpen);
const focusedLabel = (page) => page.evaluate(() => document.querySelector('.menu:not([hidden]) .menu-focused')?.textContent ?? null);

function waitForFrame(page, target) {
  return page.waitForFunction((frame) => window.__murmuration.frame >= frame, target, { timeout: STEP_TIMEOUT_MILLISECONDS });
}

function waitForPhase(page, phase) {
  return page.waitForFunction((wanted) => window.__murmuration.stats?.phase === wanted, phase, { timeout: STEP_TIMEOUT_MILLISECONDS });
}

async function open(url, contextOptions, initScript = null) {
  const launched = await launchWebGpuBrowser({ contextOptions });
  const { page } = launched;
  if (initScript) await page.addInitScript(initScript);
  await page.goto(`${url}${SEARCH}`);
  const available = await page.evaluate(async () => (navigator.gpu ? (await navigator.gpu.requestAdapter()) !== null : false));
  if (!available) {
    await launched.browser.close();
    return null;
  }
  await page.waitForFunction(() => window.__murmuration?.ready === true && window.__murmuration.stats != null, null, { timeout: READY_TIMEOUT_MILLISECONDS });
  return launched;
}

// One synthetic pad (standard mapping), installed before any page script runs.
function installSyntheticGamepad() {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  const gamepad = { id: 'menu smoke pad', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons };
  window.__smokeGamepad = gamepad;
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => [gamepad] });
}

async function pressButton(page, index) {
  await page.evaluate((button) => { window.__smokeGamepad.buttons[button].pressed = true; }, index);
  await waitForFrame(page, (await readFrame(page)) + HOLD_FRAMES);
  await page.evaluate((button) => { window.__smokeGamepad.buttons[button].pressed = false; }, index);
}

async function checkDesktop(url) {
  const launched = await open(url, { viewport: DESKTOP_VIEWPORT }, installSyntheticGamepad);
  if (launched === null) return false;
  const { page, browser } = launched;
  try {
    expect((await readStats(page)).phase === 'ready', 'the game should wait in ready behind the title menu');
    expect(await isShown(page, '.menu-title-screen'), 'the title menu should show on load');
    expect(!(await isShown(page, '.menu-pause')), 'the pause menu should be hidden on load');
    await savePng('menu-title.png', await page.screenshot());

    // A tap on the arena behind the buttons (a corner) is the one input that starts play.
    await page.mouse.move(40, 40);
    await page.mouse.down();
    await waitForFrame(page, (await readFrame(page)) + HOLD_FRAMES);
    await page.mouse.up();
    await waitForPhase(page, 'playing');
    expect(!(await isShown(page, '.menu-title-screen')), 'the title menu should hide once the run starts');

    // Step left, then fire toward the swarm for PLAY_FRAMES frames.
    await page.keyboard.down('KeyA');
    await waitForFrame(page, (await readFrame(page)) + STEP_LEFT_FRAMES);
    await page.keyboard.up('KeyA');
    await page.mouse.move(DESKTOP_VIEWPORT.width * 0.8, DESKTOP_VIEWPORT.height * 0.5);
    await page.mouse.down();
    await waitForFrame(page, (await readFrame(page)) + PLAY_FRAMES);
    await page.mouse.up();
    const played = await readStats(page);
    console.log(`smoke-menu: ${PLAY_FRAMES} frames after the start click: score ${played.score}, phase ${played.phase}`);
    expect(played.score > 0, `expected stats.score > 0 after ${PLAY_FRAMES} frames, got ${played.score}`);

    // Escape pauses: the render counter advances, the run does not.
    await page.keyboard.press('Escape');
    await waitForPhase(page, 'paused');
    expect(await isShown(page, '.menu-pause'), 'the pause menu should show while paused');
    await savePng('menu-pause.png', await page.screenshot());
    const frozen = await readStats(page);
    const stepsAtPause = await readSteps(page);
    const frameAtPause = await readFrame(page);
    await waitForFrame(page, frameAtPause + PAUSED_FRAMES);
    const stillFrozen = await readStats(page);
    console.log(`smoke-menu: paused for ${PAUSED_FRAMES} frames: score ${frozen.score} -> ${stillFrozen.score}, steps ${stepsAtPause} -> ${await readSteps(page)}, phase ${stillFrozen.phase}`);
    expect(stillFrozen.phase === 'paused' && stillFrozen.score === frozen.score, 'the phase should read paused and the score stay frozen');
    expect((await readSteps(page)) === stepsAtPause, 'the simulation must not step while paused');

    // Keyboard navigation moves the focus ring; Escape resumes.
    expect((await focusedLabel(page)) === 'Resume', 'the pause menu should focus Resume first');
    await page.keyboard.press('ArrowDown');
    await waitForFrame(page, (await readFrame(page)) + 2);
    expect((await focusedLabel(page)) === 'Settings', `ArrowDown should focus Settings, got ${await focusedLabel(page)}`);
    // Settings from the pause menu sits on top of it; Escape closes only the panel.
    await page.keyboard.press('Enter');
    await waitForFrame(page, (await readFrame(page)) + SETTLE_FRAMES);
    expect(await settingsOnTop(page), 'Settings opened from the pause menu should be on top (a slider at its own center)');
    await page.keyboard.press('Escape');
    await waitForFrame(page, (await readFrame(page)) + SETTLE_FRAMES);
    expect(!(await settingsShown(page)), 'Escape should close Settings');
    expect(await isShown(page, '.menu-pause'), 'closing Settings should return to the pause menu');
    expect((await readStats(page)).phase === 'paused' && (await readSteps(page)) === stepsAtPause, 'closing Settings must leave the run paused');
    // The gamepad back button closes it too.
    await page.keyboard.press('Enter');
    await waitForFrame(page, (await readFrame(page)) + SETTLE_FRAMES);
    expect(await settingsShown(page), 'Enter on Settings should open it again');
    await pressButton(page, 1);
    await waitForFrame(page, (await readFrame(page)) + SETTLE_FRAMES);
    expect(!(await settingsShown(page)) && (await isShown(page, '.menu-pause')), 'the gamepad back button should close Settings to the pause menu');
    expect((await readStats(page)).phase === 'paused', 'the back button must leave the run paused');
    console.log('smoke-menu: Settings over the pause menu is on top and closes back to it, still paused');
    await page.keyboard.press('Escape');
    await waitForPhase(page, 'playing');
    expect(!(await isShown(page, '.menu-pause')), 'the pause menu should hide on resume');
    await waitForFrame(page, (await readFrame(page)) + PAUSED_FRAMES);
    expect((await readSteps(page)) > stepsAtPause, 'the simulation should step again after resume');

    // O mid-run pauses under the panel; Escape closes the panel to the pause menu, Escape resumes.
    await page.keyboard.press('KeyO');
    await waitForPhase(page, 'paused');
    expect((await settingsShown(page)) && (await isShown(page, '.menu-pause')), 'O mid-run should open Settings over the pause menu');
    await page.keyboard.press('Escape');
    await waitForFrame(page, (await readFrame(page)) + SETTLE_FRAMES);
    expect(!(await settingsShown(page)) && (await readStats(page)).phase === 'paused', 'Escape should close Settings and stay paused');
    // An arrow step on a focused settings slider keeps its focus, and Escape still closes the panel.
    await page.keyboard.press('KeyO');
    await waitForFrame(page, (await readFrame(page)) + SETTLE_FRAMES);
    expect(await settingsOnTop(page), 'O from the pause menu should open Settings on top');
    await page.focus('.settings-panel input[type="range"]');
    await page.keyboard.press('ArrowRight');
    await waitForFrame(page, (await readFrame(page)) + SETTLE_FRAMES);
    expect(await page.evaluate(() => document.activeElement?.matches('.settings-panel input[type="range"]')), 'an arrow step should keep the slider focused');
    await page.keyboard.press('Escape');
    await waitForFrame(page, (await readFrame(page)) + SETTLE_FRAMES);
    expect(!(await settingsShown(page)) && (await readStats(page)).phase === 'paused', 'Escape from a focused slider should close Settings and stay paused');
    expect(await isShown(page, '.menu-pause'), 'closing Settings from a slider should return to the pause menu');
    await page.keyboard.press('Escape');
    await waitForPhase(page, 'playing');

    // The gamepad Options button (9) pauses; face button A (0) on Resume resumes.
    await pressButton(page, 9);
    await waitForPhase(page, 'paused');
    await pressButton(page, 0);
    await waitForPhase(page, 'playing');

    // Quit to title with the keyboard alone: Escape, down to the last item, Enter.
    await page.keyboard.press('Escape');
    await waitForPhase(page, 'paused');
    for (let index = 0; index < 3; index += 1) {
      await page.keyboard.press('ArrowDown');
      await waitForFrame(page, (await readFrame(page)) + 2);
    }
    expect((await focusedLabel(page)) === 'Quit to title', `expected Quit to title focused, got ${await focusedLabel(page)}`);
    await page.keyboard.press('Enter');
    await waitForPhase(page, 'ready');
    expect(await isShown(page, '.menu-title-screen'), 'quitting should show the title menu');
    // Keyboard navigation on the title does not start play; Enter on Play does.
    await page.keyboard.press('ArrowDown');
    await waitForFrame(page, (await readFrame(page)) + PAUSED_FRAMES);
    expect((await readStats(page)).phase === 'ready', 'an arrow key on the title menu must not start the run');
    await page.keyboard.press('ArrowUp');
    await waitForFrame(page, (await readFrame(page)) + 2);
    await page.keyboard.press('Enter');
    await waitForPhase(page, 'playing');
    expect(page.consoleErrors.length === 0, `console errors: ${page.consoleErrors.join(' | ')}`);
    console.log('smoke-menu: desktop ok');
  } finally {
    await browser.close();
  }
  return true;
}

async function checkPhone(url) {
  const phone = { isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: MOBILE_USER_AGENT };
  const portrait = await open(url, { ...phone, viewport: PHONE_PORTRAIT });
  if (portrait === null) return false;
  try {
    expect(await isShown(portrait.page, '.rotate-overlay'), 'a mobile portrait load should show the rotate overlay');
    await savePng('rotate-overlay.png', await portrait.page.screenshot());
    await portrait.page.touchscreen.tap(PHONE_PORTRAIT.width / 2, PHONE_PORTRAIT.height / 2);
    await waitForFrame(portrait.page, (await readFrame(portrait.page)) + PAUSED_FRAMES);
    expect((await readStats(portrait.page)).phase === 'ready', 'a tap behind the rotate overlay must not start the run');
    console.log('smoke-menu: phone portrait shows the overlay and does not start');
  } finally {
    await portrait.browser.close();
  }

  const landscape = await open(url, { ...phone, viewport: PHONE_LANDSCAPE });
  if (landscape === null) return false;
  const { page } = landscape;
  try {
    expect(!(await isShown(page, '.rotate-overlay')), 'landscape must not show the rotate overlay');
    await page.touchscreen.tap(PHONE_LANDSCAPE.width / 2, PHONE_LANDSCAPE.height / 2);
    await waitForPhase(page, 'playing');
    await waitForFrame(page, (await readFrame(page)) + PAUSED_FRAMES);
    const before = await readStats(page);
    await page.setViewportSize(PHONE_PORTRAIT);
    await waitForPhase(page, 'paused');
    expect(await isShown(page, '.rotate-overlay'), 'rotating to portrait mid-run should show the overlay');
    expect(!(await isShown(page, '.menu-pause')), 'the rotate pause shows the overlay, not the pause menu');
    const steps = await readSteps(page);
    await waitForFrame(page, (await readFrame(page)) + PAUSED_FRAMES);
    expect((await readSteps(page)) === steps, 'no simulation step behind the rotate overlay');
    await page.setViewportSize(PHONE_LANDSCAPE);
    await waitForPhase(page, 'playing');
    const after = await readStats(page);
    console.log(`smoke-menu: phone rotation round trip: lives ${before.lives} -> ${after.lives}, score ${before.score} -> ${after.score}, phase ${after.phase}`);
    expect(after.score >= before.score && after.lives === before.lives, 'the run should survive the rotation');
    expect(page.consoleErrors.length === 0, `console errors: ${page.consoleErrors.join(' | ')}`);
    console.log('smoke-menu: phone ok');
  } finally {
    await landscape.browser.close();
  }
  return true;
}

async function run(resources) {
  const url = process.env.SMOKE_URL ?? (resources.server = await startServer()).url;
  if (!(await checkDesktop(url)) || !(await checkPhone(url))) {
    console.error('smoke-menu: WebGPU adapter unavailable in headless Chromium');
    return EXIT_NO_ADAPTER;
  }
  console.log('smoke-menu: ok');
  return EXIT_OK;
}

const resources = { server: null };
let deadlineTimer;
const deadline = new Promise((resolve) => {
  deadlineTimer = setTimeout(() => {
    console.error(`smoke-menu: the run did not finish within ${DEADLINE_MILLISECONDS} ms; failing`);
    resolve(EXIT_FAILURE);
  }, DEADLINE_MILLISECONDS);
});
const exitCode = await Promise.race([
  run(resources).catch((error) => {
    console.error(`smoke-menu: ${error.message}`);
    return EXIT_FAILURE;
  }),
  deadline,
]);
clearTimeout(deadlineTimer);
if (resources.server) resources.server.child.kill();
process.exit(exitCode);
