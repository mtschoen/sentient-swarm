// Lab browser smoke (Plan C task C6b). Serves the page with the Vite dev server (server.mjs;
// SMOKE_PORT picks the port) and checks:
//   - a malformed hash (/#mix=%%%) and a well-formed but wrong-shaped one (#mix=<encoded
//     {"version":1}>) both render, open the lab on the defaults with its status line, and log no
//     console errors;
//   - on a desktop viewport the title menu's Lab button opens the lab in Watch: the run stays in
//     Ready, the player point follows the pointer, the inspect zoom is on; Play starts the run and
//     Watch returns to it; two sliders (the base gun kill budget and the Chaser share) are moved,
//     Share writes #mix= into the URL, and a fresh page loaded with that URL opens the lab with the
//     same knob, share and mix (the round trip);
//   - Title leaves the lab: the menu shows and the inspect zoom is off again;
//   - on a phone in landscape (844 by 390, touch) the Lab button opens a panel that fits the
//     viewport height, scrolls, is marked data-touch-exclusive and has touch-sized rows.
// Saves artifacts/lab-panel-1280x720.png and artifacts/lab-panel-844x390.png (page screenshots; the
// WebGPU canvas may be blank in headless Chromium).
// Exit codes: 0 ok, 1 failure, 2 WebGPU adapter unavailable.
import { mkdir, writeFile } from 'node:fs/promises';
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';

const SEARCH = '?probe=off&capacity=262144';
const READY_TIMEOUT_MILLISECONDS = 15_000;
const STEP_TIMEOUT_MILLISECONDS = 30_000;
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_NO_ADAPTER = 2;
const SETTLE_FRAMES = 20;
const DESKTOP_VIEWPORT = { width: 1280, height: 720 };
const PHONE_LANDSCAPE = { width: 844, height: 390 };
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const MINIMUM_TOUCH_ROW_PIXELS = 30;
const KILL_BUDGET = 5;
const CHASER_SHARE = 0.9;
const COMFORT_RADIUS = 2.5;
const ARTIFACTS_DIRECTORY = new URL('../../artifacts/', import.meta.url);
// base64url of {"version":1}: decodes as JSON, fails the mix schema.
const WRONG_SHAPE = Buffer.from(JSON.stringify({ version: 1 })).toString('base64url');

class NoAdapterError extends Error {}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function savePng(name, bytes) {
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  await writeFile(new URL(name, ARTIFACTS_DIRECTORY), bytes);
}

const isShown = (page, selector) => page.evaluate((query) => {
  const element = document.querySelector(query);
  return element !== null && !element.hidden && getComputedStyle(element).display !== 'none';
}, selector);

async function waitFrames(page, count) {
  const start = await page.evaluate(() => window.__murmuration.frame);
  await page.waitForFunction((target) => window.__murmuration.frame >= target, start + count, { timeout: STEP_TIMEOUT_MILLISECONDS });
}

async function open(url, contextOptions) {
  const launched = await launchWebGpuBrowser({ contextOptions });
  const { page } = launched;
  await page.goto(url);
  const available = await page.evaluate(async () => (navigator.gpu ? (await navigator.gpu.requestAdapter()) !== null : false));
  if (!available) {
    await launched.browser.close();
    throw new NoAdapterError('WebGPU adapter unavailable');
  }
  await page.waitForFunction(() => window.__murmuration?.ready === true && window.__murmuration.stats != null, null, { timeout: READY_TIMEOUT_MILLISECONDS });
  return launched;
}

function expectNoErrors(page, label) {
  expect(page.consoleErrors.length === 0, `${label}: console errors:\n${page.consoleErrors.join('\n')}`);
}

async function checkBadHash(baseUrl, hash, label) {
  const { browser, page } = await open(`${baseUrl}${SEARCH}${hash}`, { viewport: DESKTOP_VIEWPORT });
  try {
    await waitFrames(page, SETTLE_FRAMES);
    const state = await page.evaluate(() => ({ active: window.__murmuration.lab.active, watching: window.__murmuration.game.watching }));
    expect(state.active && state.watching, `${label}: the lab should open in Watch on the defaults, got ${JSON.stringify(state)}`);
    expect(await isShown(page, '.lab-status'), `${label}: the status line should say the mix could not be read`);
    expectNoErrors(page, label);
    console.log(`smoke-lab: ${label} renders, lab on the defaults, no console errors`);
  } finally {
    await browser.close();
  }
}

// Moves a range input to value and fires input and change, as a drag would.
const setSlider = (page, knob, value) => page.evaluate(({ name, wanted }) => {
  const input = document.querySelector(`.lab-panel input[data-knob="${name}"]`);
  input.value = String(wanted);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, { name: knob, wanted: value });

const readLab = (page) => page.evaluate(() => {
  const { game, lab } = window.__murmuration;
  return {
    active: lab.active,
    watching: game.watching,
    phase: game.run.phase,
    zoomEnabled: lab.viewport.inspectZoomEnabled,
    killBudget: game.projectiles.baseKillBudget,
    comfortRadius: game.simulation.comfortRadius,
    coarseFieldPressure: game.simulation.coarseFieldPressure,
    shares: Array.from(game.simulation.shares),
    mix: lab.capture(),
    player: game.player.position,
  };
});

async function checkDesktop(baseUrl) {
  const { browser, page } = await open(`${baseUrl}${SEARCH}`, { viewport: DESKTOP_VIEWPORT });
  let sharedUrl;
  let source;
  try {
    await page.click('.menu-title-screen .menu-item:has-text("Lab")');
    await waitFrames(page, SETTLE_FRAMES);
    let state = await readLab(page);
    expect(state.active && state.watching && state.phase === 'ready', `the Lab button should open Watch, got ${JSON.stringify({ ...state, mix: undefined })}`);
    expect(state.zoomEnabled, 'the inspect zoom should be on in the lab');
    expect(await isShown(page, '.lab-panel'), 'the lab panel should be open');
    expect(!(await isShown(page, '.menu-title-screen')), 'the title menu should be hidden in the lab');

    await page.mouse.move(DESKTOP_VIEWPORT.width * 0.2, DESKTOP_VIEWPORT.height * 0.3);
    await waitFrames(page, SETTLE_FRAMES);
    state = await readLab(page);
    expect(state.player.x < 6 && state.player.y < 4, `the watch point should follow the pointer to the upper left, got ${JSON.stringify(state.player)}`);
    expect(state.phase === 'ready', `a pointer move must not start the run in Watch, got ${state.phase}`);

    await page.click('.lab-panel .lab-play');
    await waitFrames(page, SETTLE_FRAMES);
    state = await readLab(page);
    expect(!state.watching && state.phase === 'playing', `Play should start the run, got watching ${state.watching} phase ${state.phase}`);
    await page.click('.lab-panel .lab-watch');
    await waitFrames(page, SETTLE_FRAMES);
    state = await readLab(page);
    expect(state.watching && state.phase === 'ready', `Watch should return to Ready, got watching ${state.watching} phase ${state.phase}`);

    await setSlider(page, 'baseKillBudget', KILL_BUDGET);
    await setSlider(page, 'Chaser', CHASER_SHARE);
    await setSlider(page, 'comfortRadius', COMFORT_RADIUS);
    await page.evaluate(() => document.querySelector('.lab-panel input[data-knob="coarseFieldPressure"]').click());
    await page.click('.lab-panel .lab-share');
    sharedUrl = await page.evaluate(() => location.href);
    expect(sharedUrl.includes('#mix='), `Share should write #mix= into the URL, got ${sharedUrl}`);
    source = await readLab(page);
    expect(source.killBudget === KILL_BUDGET, `the kill budget slider should set ${KILL_BUDGET}, got ${source.killBudget}`);
    expect(source.comfortRadius === COMFORT_RADIUS && source.coarseFieldPressure === false,
      `the comfort radius slider and coarse-field toggle should set ${COMFORT_RADIUS} and off, got ${source.comfortRadius} and ${source.coarseFieldPressure}`);
    await savePng('lab-panel-1280x720.png', await page.screenshot());

    await page.click('.lab-panel .lab-leave');
    await waitFrames(page, SETTLE_FRAMES);
    state = await readLab(page);
    expect(!state.active && !state.zoomEnabled && state.phase === 'ready', `Title should leave the lab, got ${JSON.stringify({ ...state, mix: undefined })}`);
    expect(await isShown(page, '.menu-title-screen'), 'the title menu should show after leaving the lab');
    expect(state.killBudget === 0 && state.comfortRadius === 1 && state.coarseFieldPressure === true,
      `leaving should restore the shipped knobs, got kill budget ${state.killBudget}, comfort radius ${state.comfortRadius}, coarse field ${state.coarseFieldPressure}`);
    expectNoErrors(page, 'desktop lab');
  } finally {
    await browser.close();
  }

  const reopened = await open(sharedUrl, { viewport: DESKTOP_VIEWPORT });
  try {
    await waitFrames(reopened.page, SETTLE_FRAMES);
    const state = await readLab(reopened.page);
    expect(state.active, 'the shared link should open the lab');
    expect(state.killBudget === KILL_BUDGET, `the shared kill budget should be ${KILL_BUDGET}, got ${state.killBudget}`);
    expect(state.comfortRadius === COMFORT_RADIUS && state.coarseFieldPressure === false,
      `the shared comfort radius and coarse-field toggle should be ${COMFORT_RADIUS} and off, got ${state.comfortRadius} and ${state.coarseFieldPressure}`);
    expect(state.shares.every((share, index) => Math.abs(share - source.shares[index]) < 1e-6), `shares should round-trip: ${source.shares} -> ${state.shares}`);
    expect(JSON.stringify(state.mix) === JSON.stringify(source.mix), 'the whole mix should round-trip through the shared link');
    expectNoErrors(reopened.page, 'shared link');
    console.log(`smoke-lab: desktop Watch, Play, Share and the shared link round trip ok (kill budget ${state.killBudget}, comfort radius ${state.comfortRadius}, coarse field ${state.coarseFieldPressure ? 'on' : 'off'}, Chaser share ${state.shares[0].toFixed(3)})`);
  } finally {
    await reopened.browser.close();
  }
}

async function checkPhone(baseUrl) {
  const contextOptions = { viewport: PHONE_LANDSCAPE, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: MOBILE_USER_AGENT };
  const { browser, page } = await open(`${baseUrl}${SEARCH}`, contextOptions);
  try {
    await page.tap('.menu-title-screen .menu-item:has-text("Lab")');
    await waitFrames(page, SETTLE_FRAMES);
    const layout = await page.evaluate(() => {
      const panel = document.querySelector('.lab-panel');
      const bounds = panel.getBoundingClientRect();
      const rows = Array.from(panel.querySelectorAll('.lab-row')).map((row) => row.getBoundingClientRect().height);
      return {
        top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right,
        scrolls: panel.scrollHeight > panel.clientHeight,
        exclusive: panel.hasAttribute('data-touch-exclusive'),
        shortestRow: Math.min(...rows),
        watching: window.__murmuration.game.watching,
      };
    });
    expect(layout.watching, 'the Lab button should open Watch on the phone');
    expect(layout.top >= 0 && layout.bottom <= PHONE_LANDSCAPE.height && layout.left >= 0 && layout.right <= PHONE_LANDSCAPE.width, `the panel should fit the viewport: ${JSON.stringify(layout)}`);
    expect(layout.scrolls, 'the panel should scroll on a phone');
    expect(layout.exclusive, 'the panel should be marked data-touch-exclusive');
    expect(layout.shortestRow >= MINIMUM_TOUCH_ROW_PIXELS, `rows should be touch-sized (at least ${MINIMUM_TOUCH_ROW_PIXELS} px), shortest ${layout.shortestRow}`);
    await savePng('lab-panel-844x390.png', await page.screenshot());
    expectNoErrors(page, 'phone lab');
    console.log(`smoke-lab: phone panel fits ${PHONE_LANDSCAPE.width}x${PHONE_LANDSCAPE.height}, scrolls, shortest row ${layout.shortestRow.toFixed(1)} px`);
  } finally {
    await browser.close();
  }
}

async function run() {
  let server = null;
  try {
    server = await startServer();
    const baseUrl = server.url.endsWith('/') ? server.url : `${server.url}/`;
    await checkBadHash(baseUrl, '#mix=%%%', '#mix=%%%');
    await checkBadHash(baseUrl, `#mix=${WRONG_SHAPE}`, '#mix=<wrong shape>');
    await checkDesktop(baseUrl);
    await checkPhone(baseUrl);
    console.log('smoke-lab: ok');
    return EXIT_OK;
  } catch (error) {
    if (error instanceof NoAdapterError) {
      console.error('smoke-lab: WebGPU adapter unavailable');
      return EXIT_NO_ADAPTER;
    }
    console.error(`smoke-lab: FAIL ${error.message}`);
    return EXIT_FAILURE;
  } finally {
    if (server) server.child.kill();
  }
}

process.exitCode = await run();
