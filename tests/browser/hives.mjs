// Hives browser check (not part of check:gpu): drives the real page in headless Chromium with
// synthetic gamepads (as versus.mjs) through one hives match:
//   A. two pads at 1280 by 720: pad 1 joins, the d-pad and two south presses step the mode item to
//      MODE: HIVES, and Play starts a hives run (both seats invulnerable, the neutral swarm cleared
//      before every update so nothing else happens). The HUD lays out three neutral hive pips, the
//      step's gate table holds the three hive rows, seat 1's ships are held on the center hive until
//      it is seat 1's: its pip turns seat 1's color and its row aims its spawns at seat 2 (target 1).
//      Every hive then handed to seat 1 shows the countdown in seat 1's color, and the hold (wound
//      forward to its last 2 s) ends the match: PLAYER 1 WINS. A fresh pad press after the restart
//      guard restarts hives from neutral; Escape and Quit to title return to a co-op title with the
//      item ghosted. Screenshots artifacts/hives-captured.png and hives-winner.png.
//   B. a hives run at 844 by 390 and at 1280 by 720 with the countdown showing: the hive readout lies
//      inside the window and overlaps no other HUD readout or button (artifacts/hives-hud-*.png).
// The pages get no user gesture the audio could unlock on, and the browser is launched muted.
// Usage: SMOKE_PORT=5197 node tests/browser/hives.mjs
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
const CAPTURE_FRAMES = 1200;
const GAME_OVER_FRAMES = 600;
const RESTART_GUARD_FRAMES = 60;
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const SOUTH = 0;
const SEAT_ONE_COLOR = 'rgb(255, 255, 255)';
const CENTER_HIVE = 2;

function installSyntheticGamepads() {
  window.__pads = [];
  window.__makePad = (index) => ({
    id: `hives synthetic gamepad ${index}`,
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

async function waitFor(page, predicate, frames, step = 30) {
  let waited = 0;
  while (!(await predicate()) && waited < frames) {
    await waitFrames(page, step);
    waited += step;
  }
  return waited;
}

async function openPage(browser, server, { viewport = DESKTOP_VIEWPORT } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') page.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => page.consoleErrors.push(error.message));
  await page.addInitScript(installSyntheticGamepads);
  const url = new URL(server.url);
  url.searchParams.set('probe', 'off');
  url.searchParams.set('capacity', '262144');
  await page.goto(url.href);
  await page.waitForFunction(() => window.__murmuration?.ready === true && window.__murmuration.stats != null, null, { timeout: TIMEOUT_MILLISECONDS });
  return { context, page };
}

async function finish(name, page, context) {
  expect(page.consoleErrors.length === 0, `${name}: console errors: ${page.consoleErrors.join(' | ')}`);
  await context.close();
}

// Joins pad 1, steps the mode item to hives by pad and starts the run from Play.
async function startHives(page) {
  await addPad(page, 0);
  await addPad(page, 1);
  await waitFrames(page, SEARCH_FRAMES);
  await tap(page, 1, SOUTH);
  expect(await page.evaluate(() => window.__murmuration.coop.playerCount) === 2, 'pad 1 did not join seat 2');
  await tap(page, 0, DPAD_DOWN);
  await tap(page, 0, SOUTH);
  await tap(page, 0, SOUTH);
  const item = await modeItem(page);
  expect(item.chosen === 'hives' && item.text === 'MODE: HIVES', `the pad did not pick hives ("${item.text}", ${item.chosen})`);
  expect(await phaseOf(page) === 'ready', 'picking the mode started the run');
  await tap(page, 0, DPAD_UP);
  await tap(page, 0, SOUTH);
  expect(await phaseOf(page) === 'playing', `Play did not start the run, phase ${await phaseOf(page)}`);
  const mode = await page.evaluate(() => window.__murmuration.game.mode);
  expect(mode === 'hives', `the run is ${mode}`);
  // Nothing but the hives happens: both seats invulnerable, the neutral swarm cleared every update,
  // and seat 1's ships held on window.__parkHive while it is set.
  await page.evaluate(() => {
    const { game } = window.__murmuration;
    game.debugInvulnerable(true);
    window.__parkHive = null;
    const update = game.update.bind(game);
    game.update = (deltaSeconds) => {
      if (game.run.phase === 'playing') game.simulation.requestKillAll();
      const hive = window.__parkHive === null ? null : game.versusMatch?.hives?.hives[window.__parkHive];
      if (hive) game.seats[0].swarm.slots.forEach((slot) => { if (slot.alive) { slot.x = hive.x; slot.y = hive.y; } });
      update(deltaSeconds);
    };
  });
}

const hudHives = (page) => page.evaluate(() => {
  const readout = document.querySelector('.hud-hives');
  const pips = [...readout.querySelectorAll('.hud-hive-pip')];
  const countdown = readout.querySelector('.hud-hive-countdown');
  return {
    shown: !readout.hidden && readout.getBoundingClientRect().height > 0,
    pips: pips.map((pip) => getComputedStyle(pip).backgroundColor),
    countdown: { text: countdown.textContent, visible: getComputedStyle(countdown).visibility === 'visible', color: getComputedStyle(countdown).color },
  };
});

async function runA(browser, server) {
  const { context, page } = await openPage(browser, server);
  await startHives(page);
  await waitFrames(page, 10);
  let hud = await hudHives(page);
  expect(hud.shown && hud.pips.length === 3, `A: hive readout ${JSON.stringify(hud)}`);
  expect(!hud.countdown.visible, 'A: the countdown shows with no holder');
  const rows = await page.evaluate(() => (window.__murmuration.game.simulation.spawnGates?.gates ?? []).map((row) => ({ site: row.site, owner: row.owner, target: row.target, hive: row.hive !== undefined })));
  expect(rows.length === 3 && rows.every((row) => row.hive && row.owner === null && row.target === null), `A: gate rows ${JSON.stringify(rows)}`);

  // Seat 1 parks on the center hive until it owns it.
  await page.evaluate((index) => { window.__parkHive = index; }, CENTER_HIVE);
  const owner = () => page.evaluate((index) => window.__murmuration.game.versusMatch.hives.hives[index].owner, CENTER_HIVE);
  const waited = await waitFor(page, async () => (await owner()) === 0, CAPTURE_FRAMES);
  expect(await owner() === 0, `A: seat 1 did not capture the center hive within ${CAPTURE_FRAMES} frames`);
  await page.evaluate(() => { window.__parkHive = null; });
  await waitFrames(page, 4);
  hud = await hudHives(page);
  const row = await page.evaluate((index) => window.__murmuration.game.simulation.spawnGates.gates.find((entry) => entry.site === index), CENTER_HIVE);
  console.log(`hives A: seat 1 captured the center hive after about ${waited} frames; pips ${hud.pips.join(' | ')}`);
  expect(hud.pips[CENTER_HIVE] === SEAT_ONE_COLOR, `A: the center pip is ${hud.pips[CENTER_HIVE]}`);
  expect(hud.pips[0] !== SEAT_ONE_COLOR && hud.pips[1] !== SEAT_ONE_COLOR, `A: the other pips changed: ${hud.pips.join(' | ')}`);
  expect(row.owner === 0 && row.target === 1 && row.hive.owner === 0, `A: the center row ${JSON.stringify(row)}`);
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('hives-captured.png', ARTIFACTS_DIRECTORY)) });

  // Every hive to seat 1: the countdown shows in seat 1's color; the hold wound to its last 2 s wins.
  await page.evaluate(() => window.__murmuration.game.versusMatch.hives.hives.forEach((hive) => { hive.owner = 0; }));
  await waitFrames(page, 10);
  hud = await hudHives(page);
  expect(hud.countdown.visible && /^P1 WINS IN \d+$/.test(hud.countdown.text) && hud.countdown.color === SEAT_ONE_COLOR, `A: countdown ${JSON.stringify(hud.countdown)}`);
  await page.evaluate(() => {
    const { hold } = window.__murmuration.game.versusMatch.hives;
    hold.seconds = hold.holdSecondsToWin - 2;
  });
  await waitFor(page, async () => (await phaseOf(page)) === 'gameOver', GAME_OVER_FRAMES, 10);
  expect(await phaseOf(page) === 'gameOver', `A: no game over after the hold, phase ${await phaseOf(page)}`);
  const banner = await page.evaluate(() => {
    const title = document.querySelector('.hud-gameover-title');
    return { text: title.textContent, color: getComputedStyle(title).color, result: window.__murmuration.game.state.matchResult };
  });
  expect(banner.text === 'PLAYER 1 WINS' && banner.color === SEAT_ONE_COLOR && banner.result?.hives === true, `A: game over ${JSON.stringify(banner)}`);
  console.log(`hives A: the hold won: "${banner.text}"`);
  await page.screenshot({ path: fileURLToPath(new URL('hives-winner.png', ARTIFACTS_DIRECTORY)) });

  await waitFrames(page, RESTART_GUARD_FRAMES);
  await tap(page, 1, SOUTH);
  const restarted = await page.evaluate(() => ({
    phase: window.__murmuration.game.state.phase, mode: window.__murmuration.game.mode, result: window.__murmuration.game.state.matchResult,
    owners: window.__murmuration.game.versusMatch.hives.owners,
  }));
  expect(restarted.phase === 'playing' && restarted.mode === 'hives' && restarted.result === null && restarted.owners.every((entry) => entry === null), `A: restart gave ${JSON.stringify(restarted)}`);

  await press(page, 'Escape');
  expect(await phaseOf(page) === 'paused', 'A: Escape did not pause');
  await page.locator('.menu-pause .menu-item', { hasText: 'Quit to title' }).click();
  await waitFrames(page, HOLD_FRAMES * 2);
  const quit = await page.evaluate(() => ({ phase: window.__murmuration.game.state.phase, mode: window.__murmuration.game.mode, players: window.__murmuration.coop.playerCount, hivesShown: !document.querySelector('.hud-hives').hidden }));
  const item = await modeItem(page);
  expect(quit.phase === 'ready' && quit.mode === 'coop' && quit.players === 1 && !quit.hivesShown, `A: quit gave ${JSON.stringify(quit)}`);
  expect(item.chosen === 'coop' && item.disabled && item.text === 'MODE: SOLO', `A: after quit the item reads "${item.text}", disabled ${item.disabled}`);
  console.log('hives A: ok');
  await finish('A', page, context);
}

async function checkHudLayout(browser, server, viewport) {
  const { context, page } = await openPage(browser, server, { viewport });
  await startHives(page);
  await page.evaluate(() => window.__murmuration.game.versusMatch.hives.hives.forEach((hive) => { hive.owner = 1; }));
  await waitFrames(page, 10);
  const found = await page.evaluate(() => {
    const readout = document.querySelector('.hud-hives');
    const countdown = readout.querySelector('.hud-hive-countdown');
    const hit = (first, second) => first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
    const problems = [];
    if (getComputedStyle(countdown).visibility !== 'visible') problems.push('the countdown is not showing');
    const boxes = [readout, ...readout.children].map((element) => element.getBoundingClientRect());
    const others = [...document.querySelectorAll('.hud-panel > *, .hud-seat, .hud-pause, .settings-open, #audio-hint')]
      .filter((element) => element !== readout && !readout.contains(element) && !element.contains(readout) && !element.hidden
        && getComputedStyle(element).visibility !== 'hidden' && element.getBoundingClientRect().width > 0);
    for (const box of boxes) {
      if (box.left < 0 || box.top < 0 || box.right > window.innerWidth || box.bottom > window.innerHeight) problems.push('outside the window');
      if (box.width === 0 || box.height === 0) problems.push('not laid out');
      for (const element of others) if (hit(box, element.getBoundingClientRect())) problems.push(`${element.className || element.id} "${element.textContent.slice(0, 20)}"`);
    }
    return [...new Set(problems)];
  });
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL(`hives-hud-${viewport.width}x${viewport.height}.png`, ARTIFACTS_DIRECTORY)) });
  expect(found.length === 0, `B ${viewport.width}x${viewport.height}: the hive readout overlaps ${found.join(', ')}`);
  console.log(`hives B ${viewport.width}x${viewport.height}: ok`);
  await finish('B', page, context);
}

async function run() {
  const server = await startServer();
  let browser = null;
  let failure = null;
  try {
    browser = (await launchWebGpuBrowser()).browser;
    await runA(browser, server);
    await checkHudLayout(browser, server, PHONE_VIEWPORT);
    await checkHudLayout(browser, server, DESKTOP_VIEWPORT);
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
  console.log('hives: ok');
}

await run();
