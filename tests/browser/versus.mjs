// Versus browser check (not part of check:gpu): drives the real page in headless Chromium with
// synthetic gamepads (as coop.mjs) through one versus match:
//   A. two pads at 1280 by 720: the mode item is laid out and ghosted (MODE: SOLO) before pad 1
//      joins, then reads MODE: CO-OP; the d-pad and face button pick versus, two clicks pick hives then co-op,
//      the arrow keys and Enter pick versus again. Enter on Play starts a versus run with ?swarm=1
//      and seat 1 invulnerable while both seats fire at each other and every update clears the neutral
//      swarm (a kill-all, so only seat 1's projectiles can hit seat 2's ship); seat 2 is wiped and the
//      game over reads PLAYER 1 WINS in seat 1's color. A fresh pad press after the restart guard restarts the
//      versus match; Escape and Quit to title return to a title in co-op with the item ghosted.
//      Screenshots artifacts/versus-fight.png (the seats' tinted shots) and versus-winner.png.
//   B. the title at 844 by 390 and at 1280 by 720 with pad 1 joined: the mode item lies inside the
//      window and overlaps no other button, the title, the link, the join banner or a pad status row
//      (artifacts/versus-title-844x390.png and versus-title-1280x720.png).
// The pages get no user gesture the audio could unlock on, and the browser is launched muted.
// Usage: SMOKE_PORT=5193 node tests/browser/versus.mjs
// Exit codes: 0 ok, 1 failure.
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';

const ARTIFACTS_DIRECTORY = new URL('../../artifacts/', import.meta.url);
const DESKTOP_VIEWPORT = { width: 1280, height: 720 };
const PHONE_VIEWPORT = { width: 844, height: 390 };
const TIMEOUT_MILLISECONDS = 120_000;
const HOLD_FRAMES = 4;
const SEARCH_FRAMES = 60;
const WIPE_FRAMES = 7200;
const GAME_OVER_FRAMES = 240;
const RESTART_GUARD_FRAMES = 60;
const DPAD_DOWN = 13;
const SEAT_ONE_COLOR = 'rgb(255, 255, 255)';

function installSyntheticGamepads() {
  window.__pads = [];
  window.__makePad = (index) => ({
    id: `versus synthetic gamepad ${index}`,
    index,
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
  });
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => window.__pads });
}

const currentFrame = (page) => page.evaluate(() => window.__murmuration.frame);
const waitFrames = async (page, count) => {
  const target = (await currentFrame(page)) + count;
  await page.waitForFunction((goal) => window.__murmuration.frame >= goal, target, { timeout: TIMEOUT_MILLISECONDS });
};
const addPad = (page, index) => page.evaluate((padIndex) => {
  window.__pads = [...window.__pads, window.__makePad(padIndex)];
}, index);
const setButton = (page, index, button, pressed) => page.evaluate(([padIndex, buttonIndex, value]) => {
  const pad = window.__pads.find((candidate) => candidate && candidate.index === padIndex);
  pad.buttons[buttonIndex] = { pressed: value, value: value ? 1 : 0 };
}, [index, button, pressed]);
const setAxes = (page, index, axes) => page.evaluate(([padIndex, values]) => {
  window.__pads.find((candidate) => candidate && candidate.index === padIndex).axes = values;
}, [index, axes]);
async function tap(page, index, button) {
  await setButton(page, index, button, true);
  await waitFrames(page, HOLD_FRAMES);
  await setButton(page, index, button, false);
  await waitFrames(page, HOLD_FRAMES);
}
async function press(page, key) {
  await page.keyboard.press(key);
  await waitFrames(page, HOLD_FRAMES);
}

const phaseOf = (page) => page.evaluate(() => window.__murmuration.game.state.phase);
const modeItem = (page) => page.evaluate(() => {
  const button = document.querySelector('.menu-title-screen .menu-mode');
  return { text: button.textContent, disabled: button.getAttribute('aria-disabled') === 'true', chosen: window.__murmuration.modeChoice.mode };
});

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(page, predicate, frames, step = 60) {
  let waited = 0;
  while (!(await predicate()) && waited < frames) {
    await waitFrames(page, step);
    waited += step;
  }
  return waited;
}

async function openPage(browser, server, { viewport = DESKTOP_VIEWPORT, search = {} } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') page.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => page.consoleErrors.push(error.message));
  await page.addInitScript(installSyntheticGamepads);
  const url = new URL(server.url);
  url.searchParams.set('probe', 'off');
  url.searchParams.set('capacity', '262144');
  for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
  await page.goto(url.href);
  await page.waitForFunction(() => window.__murmuration?.ready === true && window.__murmuration.stats != null, null, { timeout: TIMEOUT_MILLISECONDS });
  return { context, page };
}

async function finish(name, page, context) {
  expect(page.consoleErrors.length === 0, `${name}: console errors: ${page.consoleErrors.join(' | ')}`);
  await context.close();
}

async function joinSeatTwo(page) {
  await addPad(page, 0);
  await addPad(page, 1);
  await waitFrames(page, SEARCH_FRAMES);
  await tap(page, 1, 0);
  expect(await page.evaluate(() => window.__murmuration.coop.playerCount) === 2, 'pad 1 did not join seat 2');
  expect(await phaseOf(page) === 'ready', 'the joining press started the run');
}

async function runA(browser, server) {
  const { context, page } = await openPage(browser, server, { search: { swarm: '1' } });
  await addPad(page, 0);
  await waitFrames(page, SEARCH_FRAMES);
  let item = await modeItem(page);
  expect(item.text === 'MODE: SOLO' && item.disabled, `A: before the join the item reads "${item.text}", disabled ${item.disabled}`);
  await addPad(page, 1);
  await waitFrames(page, SEARCH_FRAMES);
  await tap(page, 1, 0);
  item = await modeItem(page);
  expect(item.text === 'MODE: CO-OP' && !item.disabled && item.chosen === 'coop', `A: after the join the item reads "${item.text}", disabled ${item.disabled}`);
  // Pad: the d-pad moves to the item and the south button picks versus.
  await tap(page, 0, DPAD_DOWN);
  await tap(page, 0, 0);
  item = await modeItem(page);
  expect(item.chosen === 'versus' && item.text === 'MODE: VERSUS', `A: the pad did not pick versus ("${item.text}")`);
  expect(await phaseOf(page) === 'ready', 'A: picking the mode started the run');
  // Mouse: a click picks hives, the next one co-op again (the item steps co-op, versus, hives).
  await page.click('.menu-title-screen .menu-mode');
  await waitFrames(page, HOLD_FRAMES);
  item = await modeItem(page);
  expect(item.chosen === 'hives' && item.text === 'MODE: HIVES', `A: the click did not pick hives ("${item.text}")`);
  await page.click('.menu-title-screen .menu-mode');
  await waitFrames(page, HOLD_FRAMES);
  item = await modeItem(page);
  expect(item.chosen === 'coop', `A: the click did not pick co-op ("${item.text}")`);
  expect(await phaseOf(page) === 'ready', 'A: the click started the run');
  // Keyboard: the arrows take the focus back from the pointer and Enter picks versus.
  await page.mouse.move(2, 2);
  await press(page, 'ArrowUp');
  await press(page, 'ArrowDown');
  await press(page, 'Enter');
  item = await modeItem(page);
  expect(item.chosen === 'versus', `A: Enter did not pick versus ("${item.text}")`);
  await press(page, 'ArrowUp');
  await press(page, 'Enter');
  expect(await phaseOf(page) === 'playing', `A: Enter on Play did not start the run, phase ${await phaseOf(page)}`);
  const started = await page.evaluate(() => ({ mode: window.__murmuration.game.mode, seats: window.__murmuration.game.seats.length }));
  expect(started.mode === 'versus' && started.seats === 2, `A: the run is ${started.mode} with ${started.seats} seats`);

  // Seat 1 is invulnerable and fires right, at seat 2 to its right; seat 2 fires back. The neutral
  // swarm is cleared before every update, so nothing but seat 1's shots can reach seat 2.
  await page.evaluate(() => {
    const { game } = window.__murmuration;
    game.debugInvulnerable(true, 0);
    const update = game.update.bind(game);
    game.update = (deltaSeconds) => {
      if (game.run.phase === 'playing') game.simulation.requestKillAll();
      update(deltaSeconds);
    };
  });
  await setAxes(page, 0, [0, 0, 1, 0]);
  await setAxes(page, 1, [0, 0, -1, 0]);
  await waitFrames(page, 20);
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('versus-fight.png', ARTIFACTS_DIRECTORY)) });
  const waited = await waitFor(page, async () => (await page.evaluate(() => window.__murmuration.game.seats[1].aliveCount)) === 0, WIPE_FRAMES);
  const seatTwoShips = await page.evaluate(() => window.__murmuration.game.seats[1].aliveCount);
  expect(seatTwoShips === 0, `A: seat 2 was not wiped within ${WIPE_FRAMES} frames`);
  await setAxes(page, 0, [0, 0, 0, 0]);
  await setAxes(page, 1, [0, 0, 0, 0]);
  await waitFor(page, async () => (await phaseOf(page)) === 'gameOver', GAME_OVER_FRAMES, 10);
  expect(await phaseOf(page) === 'gameOver', `A: no game over after the wipe, phase ${await phaseOf(page)}`);
  const banner = await page.evaluate(() => {
    const title = document.querySelector('.hud-gameover-title');
    return { text: title.textContent, color: getComputedStyle(title).color, result: window.__murmuration.game.state.matchResult, shown: !document.querySelector('.hud-gameover').hidden };
  });
  console.log(`versus A: seat 2 wiped after ${waited} frames, game over "${banner.text}" in ${banner.color}`);
  expect(banner.shown && banner.text === 'PLAYER 1 WINS' && banner.result?.winner === 0, `A: the game over reads "${banner.text}" (${JSON.stringify(banner.result)})`);
  expect(banner.color === SEAT_ONE_COLOR, `A: the winner banner color is ${banner.color}`);
  await page.screenshot({ path: fileURLToPath(new URL('versus-winner.png', ARTIFACTS_DIRECTORY)) });

  // A fresh press after the restart guard restarts the match.
  await waitFrames(page, RESTART_GUARD_FRAMES);
  await tap(page, 1, 0);
  const restarted = await page.evaluate(() => ({
    phase: window.__murmuration.game.state.phase, mode: window.__murmuration.game.mode, result: window.__murmuration.game.state.matchResult,
    ships: window.__murmuration.game.seats.map((seat) => seat.aliveCount),
  }));
  expect(restarted.phase === 'playing' && restarted.mode === 'versus' && restarted.result === null && restarted.ships.join(',') === '1,1', `A: restart gave ${JSON.stringify(restarted)}`);

  // Quit to title: co-op again, the item ghosted.
  await press(page, 'Escape');
  expect(await phaseOf(page) === 'paused', 'A: Escape did not pause');
  await page.locator('.menu-pause .menu-item', { hasText: 'Quit to title' }).click();
  await waitFrames(page, HOLD_FRAMES * 2);
  const quit = await page.evaluate(() => ({ phase: window.__murmuration.game.state.phase, mode: window.__murmuration.game.mode, players: window.__murmuration.coop.playerCount }));
  item = await modeItem(page);
  expect(quit.phase === 'ready' && quit.mode === 'coop' && quit.players === 1, `A: quit gave ${JSON.stringify(quit)}`);
  expect(item.chosen === 'coop' && item.disabled && item.text === 'MODE: SOLO', `A: after quit the item reads "${item.text}", disabled ${item.disabled}`);
  console.log('versus A: ok');
  await finish('A', page, context);
}

async function checkTitleLayout(browser, server, viewport) {
  const { context, page } = await openPage(browser, server, { viewport });
  await joinSeatTwo(page);
  const found = await page.evaluate(() => {
    const mode = document.querySelector('.menu-title-screen .menu-mode');
    const box = mode.getBoundingClientRect();
    const hit = (first, second) => first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
    const others = [...document.querySelectorAll('.menu-title-screen button, .menu-title-screen a, .menu-title-screen .menu-title, .join-banner, .pad-status')]
      .filter((element) => element !== mode && !element.hidden);
    const problems = others.filter((element) => hit(box, element.getBoundingClientRect())).map((element) => `${element.className} "${element.textContent.slice(0, 20)}"`);
    if (box.left < 0 || box.top < 0 || box.right > window.innerWidth || box.bottom > window.innerHeight) problems.push('outside the window');
    if (box.width === 0 || box.height === 0) problems.push('not laid out');
    return problems;
  });
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL(`versus-title-${viewport.width}x${viewport.height}.png`, ARTIFACTS_DIRECTORY)) });
  expect(found.length === 0, `B ${viewport.width}x${viewport.height}: the mode item overlaps ${found.join(', ')}`);
  console.log(`versus B ${viewport.width}x${viewport.height}: ok`);
  await finish('B', page, context);
}

async function run() {
  const server = await startServer();
  let browser = null;
  let failure = null;
  try {
    browser = (await launchWebGpuBrowser()).browser;
    await runA(browser, server);
    await checkTitleLayout(browser, server, PHONE_VIEWPORT);
    await checkTitleLayout(browser, server, DESKTOP_VIEWPORT);
  } catch (error) {
    failure = error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.stop();
  }
  if (failure) {
    console.error(failure.message);
    process.exit(1);
  }
  console.log('versus: ok');
}

await run();
