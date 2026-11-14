// Co-op browser check (not part of check:gpu): drives the real page in headless Chromium with
// synthetic gamepads (a mutable list behind navigator.getGamepads) and checks the press-to-join flow
// and a two-seat run. Every run is on a fresh page:
//   A. keyboard plus one pad: pad 0's face button at the title starts a solo run and joins nothing;
//      on a fresh page its shoulder button joins seat 2, Enter starts, D moves seat 1 while the pad's
//      stick moves seat 2, Options pauses and the south button resumes, and unplugging the pad
//      pauses with a toast until it returns under another index and reclaims the seat.
//   B. two pads: pad 1 joins (without starting the run), pad 0 starts, both fire apart for 240
//      frames; both seats fire and the camera zooms out. Screenshots artifacts/coop-two-swarms.png.
//   C. ?swarm=1, seat 1 invulnerable, seat 2 parked: seat 2 goes down, then seat 1 fires and 100 kills
//      revive it beside seat 1, then with contact back on and no input the run ends.
//   D. the HUD with two seat rows at 844 by 390: artifacts/coop-hud-844x390.png.
//   E. the title at 844 by 390: the join banner overlaps no button, the title or the link.
// The pages get no user gesture the audio could unlock on, and the browser is launched muted.
// Usage: SMOKE_PORT=5198 node tests/browser/coop.mjs
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
const MOVE_FRAMES = 60;
const FIRE_FRAMES = 240;
const SEARCH_FRAMES = 60;
const DOWN_FRAMES = 3600;
const REVIVE_FRAMES = 3600;
const WIPE_FRAMES = 7200;
const REVIVE_KILLS = 100;
const REVIVE_DISTANCE = 1.5;
const TOAST_DISCONNECTED = 'Player 2 controller disconnected';
const TOAST_RECONNECTED = 'Player 2 controller reconnected';
const MAXIMUM_ZOOM_WHILE_APART = 0.9;
const MINIMUM_ZOOM = 0.5;
const SHOULDER_BUTTON = 5;
const OPTIONS_BUTTON = 9;

// A mutable pad list: window.__pads is what navigator.getGamepads returns (nulls are holes).
function installSyntheticGamepads() {
  window.__pads = [];
  window.__makePad = (index) => ({
    id: `coop synthetic gamepad ${index}`,
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
const dispatchPadEvent = (page, type, index) => page.evaluate(([eventType, padIndex]) => {
  const event = new Event(eventType);
  const pad = window.__pads.find((candidate) => candidate && candidate.index === padIndex) ?? window.__lastRemovedPad;
  Object.defineProperty(event, 'gamepad', { value: pad });
  window.dispatchEvent(event);
}, [type, index]);
const removePad = (page, index) => page.evaluate((padIndex) => {
  window.__lastRemovedPad = window.__pads.find((candidate) => candidate && candidate.index === padIndex);
  window.__pads = window.__pads.filter((candidate) => candidate && candidate.index !== padIndex);
}, index);

const phaseOf = (page) => page.evaluate(() => window.__murmuration.game.state.phase);
const pointOf = (page, seat) => page.evaluate((index) => ({ ...window.__murmuration.game.seats[index].player.position }), seat);
const toastOf = (page) => page.evaluate(() => document.querySelector('.hud-toast').textContent);

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function screenshot(page, name) {
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL(name, ARTIFACTS_DIRECTORY)) });
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

// Two pads, present with every button up for a few polls, then pad 1 joins and pad 0 starts.
async function joinAndStartWithTwoPads(page) {
  await addPad(page, 0);
  await addPad(page, 1);
  await waitFrames(page, SEARCH_FRAMES);
  await tap(page, 1, 0);
  expect(await page.evaluate(() => window.__murmuration.coop.playerCount) === 2, 'pad 1 button 0 did not join seat 2');
  expect(await phaseOf(page) === 'ready', 'the joining press started the run');
  await tap(page, 0, 0);
  expect(await phaseOf(page) === 'playing', `pad 0 button 0 did not start the run, phase ${await phaseOf(page)}`);
  expect(await page.evaluate(() => window.__murmuration.game.seats.length) === 2, 'the run does not have two seats');
}

async function runA(browser, server) {
  // Pad 0 is the first pad: its face button starts a solo run and joins nothing.
  let { context, page } = await openPage(browser, server);
  await addPad(page, 0);
  await waitFrames(page, SEARCH_FRAMES);
  await tap(page, 0, 0);
  expect(await page.evaluate(() => window.__murmuration.coop.playerCount) === 1, 'A: the first pad joined with a face button');
  expect(await phaseOf(page) === 'playing', 'A: the first pad did not start the solo run');
  expect(await page.evaluate(() => window.__murmuration.game.seats.length) === 1, 'A: the solo run has more than one seat');
  await finish('A solo', page, context);

  ({ context, page } = await openPage(browser, server));
  await addPad(page, 0);
  await waitFrames(page, SEARCH_FRAMES);
  await tap(page, 0, SHOULDER_BUTTON);
  expect(await page.evaluate(() => window.__murmuration.coop.playerCount) === 2, 'A: the shoulder button did not join seat 2');
  const banner = await page.evaluate(() => document.querySelector('.join-banner').textContent);
  expect(banner.startsWith('PLAYER 2 JOINED'), `A: the banner reads "${banner}"`);
  // Seat 2's pad leaving while the title is open unseats seat 2 without a pause or a toast.
  await removePad(page, 0);
  await dispatchPadEvent(page, 'gamepaddisconnected', 0);
  await waitFrames(page, HOLD_FRAMES);
  expect(await page.evaluate(() => window.__murmuration.coop.playerCount) === 1, 'A: a title disconnect left seat 2 joined');
  expect(await phaseOf(page) === 'ready', 'A: a title disconnect paused or started the run');
  expect(await toastOf(page) !== TOAST_DISCONNECTED, 'A: a title disconnect toasted "disconnected"');
  await addPad(page, 0);
  await waitFrames(page, SEARCH_FRAMES);
  await tap(page, 0, SHOULDER_BUTTON);
  expect(await page.evaluate(() => window.__murmuration.coop.playerCount) === 2, 'A: the shoulder button did not rejoin seat 2');
  await page.keyboard.press('Enter');
  await waitFrames(page, HOLD_FRAMES);
  expect(await phaseOf(page) === 'playing', 'A: Enter did not start the run');
  expect(await page.evaluate(() => window.__murmuration.game.seats.length) === 2, 'A: the run does not have two seats');
  // The swarms stay alive and unhit while the points move.
  await page.evaluate(() => window.__murmuration.game.debugInvulnerable(true));
  const seatOneBefore = await pointOf(page, 0);
  const seatTwoBefore = await pointOf(page, 1);
  await page.keyboard.down('KeyD');
  await setAxes(page, 0, [-1, 0, 0, 0]);
  await waitFrames(page, MOVE_FRAMES);
  await page.keyboard.up('KeyD');
  await setAxes(page, 0, [0, 0, 0, 0]);
  const seatOneAfter = await pointOf(page, 0);
  const seatTwoAfter = await pointOf(page, 1);
  expect(seatOneAfter.x > seatOneBefore.x + 0.5, `A: D did not move seat 1 right (${seatOneBefore.x} to ${seatOneAfter.x})`);
  expect(seatTwoAfter.x < seatTwoBefore.x - 0.5, `A: the left stick did not move seat 2 left (${seatTwoBefore.x} to ${seatTwoAfter.x})`);

  await tap(page, 0, OPTIONS_BUTTON);
  expect(await phaseOf(page) === 'paused', 'A: Options did not pause');
  await tap(page, 0, 0);
  expect(await phaseOf(page) === 'playing', 'A: the south button did not resume');

  await removePad(page, 0);
  await dispatchPadEvent(page, 'gamepaddisconnected', 0);
  await waitFrames(page, HOLD_FRAMES);
  expect(await phaseOf(page) === 'paused', 'A: unplugging seat 2\'s pad did not pause');
  expect(await toastOf(page) === TOAST_DISCONNECTED, `A: the toast reads "${await toastOf(page)}"`);
  await addPad(page, 2);
  await dispatchPadEvent(page, 'gamepadconnected', 2);
  await waitFrames(page, HOLD_FRAMES);
  expect(await page.evaluate(() => window.__murmuration.input.seatTwoPad) === 2, 'A: the returning pad did not reclaim seat 2');
  expect(await toastOf(page) === TOAST_RECONNECTED, `A: the toast reads "${await toastOf(page)}"`);
  await tap(page, 2, 0);
  expect(await phaseOf(page) === 'playing', `A: Resume did not continue the run, phase ${await phaseOf(page)}`);
  expect(await page.evaluate(() => window.__murmuration.game.seats.length) === 2, 'A: the resumed run lost a seat');
  console.log('coop A: ok');
  await finish('A', page, context);
}

async function runB(browser, server) {
  const { context, page } = await openPage(browser, server);
  await joinAndStartWithTwoPads(page);
  await page.evaluate(() => {
    const { game } = window.__murmuration;
    game.debugInvulnerable(true);
    window.__firedShots = 0;
    for (const seat of game.seats) {
      const distribute = seat.swarmFire.distribute.bind(seat.swarmFire);
      seat.swarmFire.distribute = (...parameters) => {
        const result = distribute(...parameters);
        window.__firedShots += seat.swarmFire.report.fired;
        return result;
      };
    }
  });
  await setAxes(page, 0, [-1, 0, -1, 0]);
  await setAxes(page, 1, [1, 0, 1, 0]);
  await waitFrames(page, FIRE_FRAMES);
  const result = await page.evaluate(() => ({
    fired: window.__firedShots,
    zoom: window.__murmuration.game.camera.zoom,
    seatOne: window.__murmuration.game.seats[0].player.position.x,
    seatTwo: window.__murmuration.game.seats[1].player.position.x,
  }));
  console.log(`coop B: fired ${result.fired}, zoom ${result.zoom.toFixed(3)}, seat x ${result.seatOne.toFixed(2)} and ${result.seatTwo.toFixed(2)}`);
  expect(result.fired > 0, 'B: no ship fired');
  expect(result.zoom < MAXIMUM_ZOOM_WHILE_APART && result.zoom >= MINIMUM_ZOOM, `B: the camera zoom is ${result.zoom}`);
  await screenshot(page, 'coop-two-swarms.png');
  await finish('B', page, context);
}

async function runC(browser, server) {
  const { context, page } = await openPage(browser, server, { search: { swarm: '1' } });
  await joinAndStartWithTwoPads(page);
  await page.evaluate(() => window.__murmuration.game.debugInvulnerable(true, 0));
  const seatTwoDown = () => page.evaluate(() => window.__murmuration.game.state.seats[1].down);
  const kills = () => page.evaluate(() => window.__murmuration.game.latestStats?.killsTotal ?? 0);
  let waited = 0;
  while (!(await seatTwoDown()) && waited < DOWN_FRAMES) {
    await waitFrames(page, 60);
    waited += 60;
  }
  expect(await seatTwoDown(), `C: seat 2 was not down within ${DOWN_FRAMES} frames`);
  // Seat 1 holds fire until seat 2 is down: a firing seat clears the arena so fast that every kill
  // grows seat 2 faster than the neutral swarm can wipe it (measured: 100+ ships by 2500 frames).
  await setAxes(page, 0, [0, 0, 1, 0]);
  const killsAtDown = await kills();
  console.log(`coop C: seat 2 down after ${waited} frames`);
  waited = 0;
  while ((await seatTwoDown()) && waited < REVIVE_FRAMES) {
    await waitFrames(page, 60);
    waited += 60;
  }
  expect(!(await seatTwoDown()), `C: seat 2 was not revived within ${REVIVE_FRAMES} frames`);
  const scored = (await kills()) - killsAtDown;
  const seatOne = await pointOf(page, 0);
  const seatTwo = await pointOf(page, 1);
  const distance = Math.hypot(seatOne.x - seatTwo.x, seatOne.y - seatTwo.y);
  console.log(`coop C: revived after ${waited} frames, ${scored} kills, ${distance.toFixed(2)} apart`);
  expect(scored >= REVIVE_KILLS, `C: only ${scored} kills between down and revive`);
  expect(distance <= REVIVE_DISTANCE, `C: the revived seat is ${distance} from seat 1`);
  await page.evaluate(() => window.__murmuration.game.debugInvulnerable(false));
  await setAxes(page, 0, [0, 0, 0, 0]);
  waited = 0;
  while ((await phaseOf(page)) !== 'gameOver' && waited < WIPE_FRAMES) {
    await waitFrames(page, 60);
    waited += 60;
  }
  console.log(`coop C: phase ${await phaseOf(page)} after ${waited} frames`);
  expect(await phaseOf(page) === 'gameOver', `C: the run did not end within ${WIPE_FRAMES} frames`);
  await finish('C', page, context);
}

async function runD(browser, server) {
  const { context, page } = await openPage(browser, server, { viewport: PHONE_VIEWPORT });
  await joinAndStartWithTwoPads(page);
  await page.evaluate(() => window.__murmuration.game.debugInvulnerable(true));
  await setAxes(page, 0, [-1, 0, -1, 0]);
  await setAxes(page, 1, [1, 0, 1, 0]);
  await waitFrames(page, FIRE_FRAMES);
  await screenshot(page, 'coop-hud-844x390.png');
  await finish('D', page, context);
}

async function runE(browser, server) {
  // The title at phone size, with seat 2's pad present: the join banner, invite then joined text,
  // overlaps no menu button, the title or the source link.
  const { context, page } = await openPage(browser, server, { viewport: PHONE_VIEWPORT });
  await addPad(page, 0);
  await addPad(page, 1);
  await waitFrames(page, SEARCH_FRAMES);
  const overlaps = () => page.evaluate(() => {
    const banner = document.querySelector('.join-banner');
    const bannerBox = banner.getBoundingClientRect();
    if (banner.hidden || bannerBox.height === 0) return ['the banner is not showing'];
    const others = document.querySelectorAll('.menu-title-screen button, .menu-title-screen a, .menu-title-screen .menu-title');
    return [...others].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.left < bannerBox.right && box.right > bannerBox.left && box.top < bannerBox.bottom && box.bottom > bannerBox.top;
    }).map((element) => element.textContent);
  });
  expect((await overlaps()).length === 0, `E: the invite banner overlaps ${await overlaps()}`);
  await tap(page, 1, 0);
  expect(await page.evaluate(() => window.__murmuration.coop.playerCount) === 2, 'E: pad 1 did not join');
  expect((await overlaps()).length === 0, `E: the joined banner overlaps ${await overlaps()}`);
  console.log('coop E: ok');
  await finish('E', page, context);
}

async function run() {
  const server = await startServer();
  let browser = null;
  let failure = null;
  try {
    browser = (await launchWebGpuBrowser()).browser;
    await runA(browser, server);
    await runB(browser, server);
    await runC(browser, server);
    await runD(browser, server);
    await runE(browser, server);
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
  console.log('coop: ok');
}

await run();
