// Mobile browser smoke: the page under touch emulation at two phone landscape sizes. For each
// viewport it taps the arena to start the run, spends one bomb with a held touch on the bomb
// button, drives both floating sticks with real multi-touch (Chrome DevTools Protocol
// Input.dispatchTouchEvent) for PLAY_FRAMES frames, saves PNGs mid-play, and asserts: a positive
// score, no console errors, a thumb-sized bomb button inside the viewport, and that the bomb tap
// decrements bombs without ever producing an aim vector or firing.
// artifacts/mobile-<width>x<height>.png is a page screenshot (the DOM overlay with both sticks is
// part of it; the WebGPU canvas may be blank in it in headless Chromium), and
// artifacts/mobile-<width>x<height>-arena.png is the composited arena capture from the same frame.
// SMOKE_PORT picks the server port (see server.mjs). Exit codes: 0 ok, 1 failure, 2 no adapter.
import { mkdir, writeFile } from 'node:fs/promises';
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';

const VIEWPORTS = [{ width: 844, height: 390 }, { width: 915, height: 412 }];
const DEVICE_SCALE_FACTOR = 2;
const READY_TIMEOUT_MILLISECONDS = 15_000;
const STEP_TIMEOUT_MILLISECONDS = 60_000;
const DEADLINE_MILLISECONDS = 240_000;
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_NO_ADAPTER = 2;
// The ramp starts the arena nearly empty (Plan C task C0), so the ship needs a while to score. It
// moves left first so its fire crosses the arena toward the swarm, as the desktop --play does.
const PLAY_FRAMES = 300;
const MOVE_LEFT_FRAMES = 20;
const SHOT_FRAME = 120;
const BOMB_HOLD_FRAMES = 6;
const TAP_HOLD_FRAMES = 3;
const WANDER_FRAMES = 60;
// Touch geometry: thumb origins as fractions of the viewport (move in the left half, aim in the
// right half) and the drag distance in CSS pixels (the stick radius is 60).
const MOVE_ORIGIN = { x: 0.2, y: 0.6 };
const AIM_ORIGIN = { x: 0.65, y: 0.5 };
const DRAG_PIXELS = 45;
const MINIMUM_BUTTON_CSS_PIXELS = 56;
const ARTIFACTS_DIRECTORY = new URL('../../artifacts/', import.meta.url);

async function savePng(name, bytes) {
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  await writeFile(new URL(name, ARTIFACTS_DIRECTORY), bytes);
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${milliseconds} ms`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const read = (page, label, pageFunction, argument) => withTimeout(page.evaluate(pageFunction, argument), STEP_TIMEOUT_MILLISECONDS, label);
const readFrame = (page) => read(page, 'reading the frame', () => window.__murmuration.frame);
const readStats = (page) => read(page, 'reading stats', () => window.__murmuration.stats);

function waitForFrame(page, target) {
  return page.waitForFunction((frame) => window.__murmuration.frame >= frame, target, { timeout: STEP_TIMEOUT_MILLISECONDS });
}

// Multi-touch through CDP: points is the full list of touches currently down.
function createTouchDriver(client) {
  const send = (type, points) => client.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map(({ id, x, y }) => ({ id, x, y })),
  });
  return {
    start: (points) => send('touchStart', points),
    move: (points) => send('touchMove', points),
    end: () => send('touchEnd', []),
  };
}

async function measureBombButton(page, label, viewport) {
  const button = await read(page, 'measuring the bomb button', () => {
    const element = document.querySelector('.touch-bomb');
    const rectangle = element.getBoundingClientRect();
    return { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height, visible: getComputedStyle(element).display !== 'none' && !element.hidden };
  });
  const small = button.width < MINIMUM_BUTTON_CSS_PIXELS || button.height < MINIMUM_BUTTON_CSS_PIXELS;
  if (!button.visible || small) throw new Error(`${label}: bomb button not visible or too small ${JSON.stringify(button)}`);
  const outside = button.x < 0 || button.y < 0 || button.x + button.width > viewport.width || button.y + button.height > viewport.height;
  if (outside) throw new Error(`${label}: bomb button outside the viewport ${JSON.stringify(button)}`);
  return button;
}

// A held touch on the bomb button spends one bomb and never starts the aim stick or fires.
async function checkBombTap(page, driver, label, button) {
  await read(page, 'installing the aim watch', () => {
    window.__bombWatch = { aimSeen: false };
    const watch = () => {
      const { input } = window.__murmuration;
      const aiming = input.touch.origins.aim !== null || input.state.firing || Math.hypot(input.state.aim.x, input.state.aim.y) > 0;
      if (aiming) window.__bombWatch.aimSeen = true;
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  const bombsBefore = (await readStats(page)).bombs;
  await driver.start([{ id: 7, x: button.x + button.width / 2, y: button.y + button.height / 2 }]);
  await waitForFrame(page, (await readFrame(page)) + BOMB_HOLD_FRAMES);
  await driver.end();
  await waitForFrame(page, (await readFrame(page)) + BOMB_HOLD_FRAMES);
  const bombsAfter = (await readStats(page)).bombs;
  const { aimSeen } = await read(page, 'reading the aim watch', () => window.__bombWatch);
  console.log(`mobile-smoke ${label}: bombs ${bombsBefore} -> ${bombsAfter}, aim vector or fire seen during the bomb tap: ${aimSeen}`);
  if (bombsAfter !== bombsBefore - 1) throw new Error(`${label}: expected one bomb spent, ${bombsBefore} -> ${bombsAfter}`);
  if (aimSeen) throw new Error(`${label}: the bomb tap produced an aim vector or firing`);
}

async function savePlayPngs(page, label) {
  const overlay = await read(page, 'reading the overlay', () => [...document.querySelectorAll('.touch-stick-base')].map((element) => !element.hidden));
  if (!overlay.every(Boolean)) throw new Error(`${label}: both stick bases should be visible mid-play, got ${JSON.stringify(overlay)}`);
  await savePng(`mobile-${label}.png`, await page.screenshot());
  const capture = await read(page, 'the arena capture', () => window.__murmuration.capture());
  const base64 = capture.pngDataUrl.slice(capture.pngDataUrl.indexOf(',') + 1);
  await savePng(`mobile-${label}-arena.png`, Buffer.from(base64, 'base64'));
}

// Both sticks for PLAY_FRAMES frames: the move thumb pushes left, then wanders up and down in
// small drags; the aim thumb holds a drag to the right, firing toward the arena center.
async function playWithBothSticks(page, driver, label, viewport) {
  const moveOrigin = { x: viewport.width * MOVE_ORIGIN.x, y: viewport.height * MOVE_ORIGIN.y };
  const aimOrigin = { x: viewport.width * AIM_ORIGIN.x, y: viewport.height * AIM_ORIGIN.y };
  const movePoint = { id: 1, ...moveOrigin };
  const aimPoint = { id: 2, ...aimOrigin };
  const aimDragged = { ...aimPoint, x: aimOrigin.x + DRAG_PIXELS };
  const begin = await readFrame(page);
  await driver.start([movePoint, aimPoint]);
  await driver.move([{ ...movePoint, x: moveOrigin.x - DRAG_PIXELS }, aimDragged]);
  await waitForFrame(page, begin + MOVE_LEFT_FRAMES);
  let saved = false;
  let direction = -1;
  for (let frame = MOVE_LEFT_FRAMES; frame < PLAY_FRAMES; frame += WANDER_FRAMES) {
    await driver.move([{ ...movePoint, x: moveOrigin.x, y: moveOrigin.y + (direction * DRAG_PIXELS) / 2 }, aimDragged]);
    direction = -direction;
    if (!saved && frame + WANDER_FRAMES > SHOT_FRAME) {
      saved = true;
      await waitForFrame(page, begin + SHOT_FRAME);
      await savePlayPngs(page, label);
    }
    await waitForFrame(page, begin + frame + WANDER_FRAMES);
  }
  await driver.end();
}

async function checkViewport(url, viewport, resources) {
  const label = `${viewport.width}x${viewport.height}`;
  const launched = await launchWebGpuBrowser({
    contextOptions: { viewport, deviceScaleFactor: DEVICE_SCALE_FACTOR, hasTouch: true, isMobile: true },
  });
  resources.browser = launched.browser;
  const { page } = launched;
  await page.goto(url);
  const adapterAvailable = await read(page, 'the adapter probe', async () => (navigator.gpu ? (await navigator.gpu.requestAdapter()) !== null : false));
  if (!adapterAvailable) return false;
  await page.waitForFunction(() => window.__murmuration?.ready === true && window.__murmuration.stats != null, null, { timeout: READY_TIMEOUT_MILLISECONDS });
  const driver = createTouchDriver(await page.context().newCDPSession(page));

  const phaseBefore = (await readStats(page)).phase;
  if (phaseBefore !== 'ready') throw new Error(`${label}: expected phase ready before the tap, got ${phaseBefore}`);
  // Held for a few frames, as a person's tap is: input samples the touch once per step.
  await driver.start([{ id: 3, x: viewport.width / 2, y: viewport.height / 2 }]);
  await waitForFrame(page, (await readFrame(page)) + TAP_HOLD_FRAMES);
  await driver.end();
  await page.waitForFunction(() => window.__murmuration.stats?.phase === 'playing', null, { timeout: STEP_TIMEOUT_MILLISECONDS });

  const button = await measureBombButton(page, label, viewport);
  await checkBombTap(page, driver, label, button);
  const scoreBefore = (await readStats(page)).score;
  await playWithBothSticks(page, driver, label, viewport);
  const stats = await readStats(page);
  console.log(`mobile-smoke ${label}: ${PLAY_FRAMES} frames of two-stick play: score ${scoreBefore} -> ${stats.score}, kills ${stats.killsTotal}, lives ${stats.lives}, bombs ${stats.bombs}, phase ${stats.phase}`);
  if (page.consoleErrors.length > 0) throw new Error(`${label}: console errors: ${page.consoleErrors.join(' | ')}`);
  if (!(stats.score > 0)) throw new Error(`${label}: expected stats.score > 0 after ${PLAY_FRAMES} frames, got ${stats.score}`);
  await launched.browser.close();
  resources.browser = null;
  return true;
}

async function run(resources) {
  const url = process.env.SMOKE_URL ?? (resources.server = await startServer()).url;
  for (const viewport of VIEWPORTS) {
    if (!(await checkViewport(url, viewport, resources))) {
      console.error('mobile-smoke: WebGPU adapter unavailable in headless Chromium');
      return EXIT_NO_ADAPTER;
    }
  }
  console.log('mobile-smoke: ok');
  return EXIT_OK;
}

async function closeResources(resources) {
  const { browser, server } = resources;
  resources.browser = null;
  resources.server = null;
  if (browser) await browser.close().catch(() => {});
  if (server) await server.stop();
}

const resources = { server: null, browser: null };
let deadlineTimer;
const deadline = new Promise((resolve) => {
  deadlineTimer = setTimeout(() => {
    console.error(`mobile-smoke: the run did not finish within ${DEADLINE_MILLISECONDS} ms; failing`);
    resolve(EXIT_FAILURE);
  }, DEADLINE_MILLISECONDS);
});
const exitCode = await Promise.race([
  run(resources).catch((error) => {
    console.error(`mobile-smoke: ${error.message}`);
    return EXIT_FAILURE;
  }),
  deadline,
]);
clearTimeout(deadlineTimer);
await closeResources(resources);
process.exit(exitCode);
