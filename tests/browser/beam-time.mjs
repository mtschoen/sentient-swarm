// Beam shards and beam time browser check (not part of check:gpu): drives the real page in headless
// Chromium with fire held throughout. Every run is on a fresh page:
//   A. solo at 1280 by 720: a shard spawns by itself off screen and inside the world, its pointer
//      throbs (and stops under reduced motion), six shards are collected, the sixth arms the beam and
//      surges the spawning, and 8 s later the old weapon, the count and the surge are back.
//   B. solo at 844 by 390: the pips row and the BEAM bar overlap neither the pause button, the
//      weapon text nor Settings, and no HUD element that shows at 1280 is missing (nothing pops).
//      In A and B a shard straight above the view gets a visible pointer that intersects neither
//      the pause button nor the weapon text (other HUD elements are only in the screenshot).
//   C. co-op with two synthetic pads at 1280 by 720: seat 2 collects six, both seats get the beam.
//   D. co-op at 844 by 390: the pips row and the bar overlap no seat row, the pause button, the
//      weapon text or the Settings button.
// Three measured numbers are printed for balance: the alive count just before beam time starts, its
// peak during beam time and the count 2 s (120 frames) after it ends. Screenshots go to artifacts/.
// The pages get no user gesture the audio could unlock on, and the browser is launched muted.
// Usage: SMOKE_PORT=5199 node tests/browser/beam-time.mjs
// Exit codes: 0 ok, 1 failure, 2 no WebGPU adapter.
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';

const ARTIFACTS_DIRECTORY = new URL('../../artifacts/', import.meta.url);
const DESKTOP_VIEWPORT = { width: 1280, height: 720 };
const PHONE_VIEWPORT = { width: 844, height: 390 };
const TIMEOUT_MILLISECONDS = 120_000;
const EXIT_NO_ADAPTER = 2;
const SPAWN_FRAMES = 120;
const SPAWN_FRAME_LIMIT = 600;
const COLLECT_STEP_FRAMES = 6;
const COLLECT_FRAME_LIMIT = 6000;
const SURGE_FRAMES = 60;
const SAMPLE_FRAMES = 15;
const BEAM_FRAME_LIMIT = 3000;
const AFTER_FRAMES = 120;
const SURGE_RATIO = 1.5;
const POINTER_WIDTH = 28;
const SHOULDER_BUTTON = 5;
const HOLD_FRAMES = 4;
const SEARCH_FRAMES = 60;
const FIRE_AIM = [1, 0, 1, 0];

function installSyntheticGamepads() {
  window.__pads = [];
  window.__makePad = (index) => ({
    id: `beam synthetic gamepad ${index}`,
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
const gameState = (page) => page.evaluate(() => {
  const { game } = window.__murmuration;
  return { ...game.state, alive: game.latestStats?.aliveTotal ?? 0, surge: game.spawnPressure.surge, surgeTarget: game.beamTimeSurge, waiting: game.pickups.waitingShards };
});
const addPad = (page, index) => page.evaluate((padIndex) => { window.__pads = [...window.__pads, window.__makePad(padIndex)]; }, index);
const setButton = (page, index, button, pressed) => page.evaluate(([padIndex, buttonIndex, value]) => {
  window.__pads.find((pad) => pad.index === padIndex).buttons[buttonIndex] = { pressed: value, value: value ? 1 : 0 };
}, [index, button, pressed]);
const setAxes = (page, index, axes) => page.evaluate(([padIndex, values]) => {
  window.__pads.find((pad) => pad.index === padIndex).axes = values;
}, [index, axes]);
async function tap(page, index, button) {
  await setButton(page, index, button, true);
  await waitFrames(page, HOLD_FRAMES);
  await setButton(page, index, button, false);
  await waitFrames(page, HOLD_FRAMES);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function screenshot(page, name) {
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL(name, ARTIFACTS_DIRECTORY)) });
}

async function openPage(browser, server, viewport) {
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

// Shards every wave, so the run reaches six quickly; the swarms cannot be hit during the walk.
const speedUpShards = (page) => page.evaluate(() => {
  const { game } = window.__murmuration;
  game.beamShards.setWaveInterval(1);
  game.debugInvulnerable(true);
});

async function startSolo(page) {
  await page.keyboard.press('Enter');
  await waitFrames(page, HOLD_FRAMES);
  expect((await gameState(page)).phase === 'playing', 'the Enter press did not start the run');
  await speedUpShards(page);
  // Fire held through the whole run: the left mouse button, aimed at the arena's right side.
  const { width, height } = page.viewportSize();
  await page.mouse.move(Math.round(width * 0.8), Math.round(height * 0.4));
  await page.mouse.down();
}

async function startCoop(page) {
  await addPad(page, 0);
  await addPad(page, 1);
  await waitFrames(page, SEARCH_FRAMES);
  await tap(page, 1, 0);
  expect(await page.evaluate(() => window.__murmuration.coop.playerCount) === 2, 'pad 1 did not join seat 2');
  await tap(page, 0, 0);
  expect((await gameState(page)).phase === 'playing', 'pad 0 did not start the run');
  expect(await page.evaluate(() => window.__murmuration.game.seats.length) === 2, 'the run does not have two seats');
  await speedUpShards(page);
  await setAxes(page, 0, FIRE_AIM);
  await setAxes(page, 1, [-1, 0, -1, 0]);
}

// Waits for the first natural shard; returns the frames waited.
async function waitForShard(page) {
  let waited = 0;
  while ((await gameState(page)).waiting < 1 && waited < SPAWN_FRAME_LIMIT) {
    await waitFrames(page, SPAWN_FRAMES / 4);
    waited += SPAWN_FRAMES / 4;
  }
  expect((await gameState(page)).waiting >= 1, `no shard waited within ${SPAWN_FRAME_LIMIT} frames`);
  return waited;
}

async function shardGeometry(page) {
  return page.evaluate(() => {
    const { game } = window.__murmuration;
    const { view, worldBounds } = game;
    return game.pickups.pickups.filter((pickup) => pickup.type === 'beamshard').map((shard) => ({
      x: shard.x,
      y: shard.y,
      outsideView: Math.abs(shard.x - view.centerX) > view.width / 2 || Math.abs(shard.y - view.centerY) > view.height / 2,
      insideWorld: shard.x >= worldBounds.minX && shard.x <= worldBounds.maxX && shard.y >= worldBounds.minY && shard.y <= worldBounds.maxY,
    }));
  });
}

const pointerRectangles = (page) => page.evaluate(() => [...document.querySelectorAll('.beam-shard-pointer')]
  .filter((element) => Number(getComputedStyle(element).opacity) > 0)
  .map((element) => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }; }));

async function checkPointer(page, label) {
  await waitFrames(page, 30);
  const shards = await shardGeometry(page);
  expect(shards.length >= 1 && shards.every((shard) => shard.outsideView && shard.insideWorld), `${label}: a shard is inside the view or outside the world: ${JSON.stringify(shards)}`);
  const style = await page.evaluate(() => {
    const chevron = document.querySelector('.beam-shard-pointer-chevron');
    const computed = getComputedStyle(chevron);
    return { animationName: computed.animationName, opacity: Number(computed.opacity), slotOpacity: Number(getComputedStyle(chevron.parentElement).opacity), width: chevron.offsetWidth };
  });
  expect(style.animationName === 'beam-shard-throb', `${label}: the pointer animation is "${style.animationName}"`);
  expect(style.opacity > 0 && style.slotOpacity > 0, `${label}: the pointer is not visible (${JSON.stringify(style)})`);
  const reduced = await page.evaluate(() => {
    document.documentElement.setAttribute('data-reduced-motion', '');
    const chevron = document.querySelector('.beam-shard-pointer-chevron');
    const result = { animationName: getComputedStyle(chevron).animationName, width: chevron.offsetWidth };
    document.documentElement.removeAttribute('data-reduced-motion');
    return result;
  });
  expect(reduced.animationName === 'none', `${label}: reduced motion leaves the animation "${reduced.animationName}"`);
  expect(reduced.width === POINTER_WIDTH && style.width === POINTER_WIDTH, `${label}: the pointer widths are ${style.width} and ${reduced.width}`);
}

// A temporary shard straight above the view: its pointer must be visible and clear of the pause
// button and the weapon text (asserted), and the screenshot shows the rest of the top row.
async function pointerAboveView(page, name) {
  await page.evaluate(() => {
    const { game } = window.__murmuration;
    const { view } = game;
    game.pickups.spawnShard(view.centerX, view.centerY - view.height / 2 - 1);
    window.__temporaryShard = game.pickups.pickups.at(-1);
  });
  await waitFrames(page, 30);
  await screenshot(page, name);
  const { hidden: report, visibleCount } = await page.evaluate(() => {
    const hudBoxes = [...document.querySelectorAll('#hud .hud-pause, #hud .hud-weapon')]
      .filter((element) => getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden')
      .map((element) => ({ name: element.className, box: element.getBoundingClientRect() }));
    const shown = [...document.querySelectorAll('.beam-shard-pointer')].filter((element) => Number(getComputedStyle(element).opacity) > 0);
    const hidden = shown.flatMap((element) => {
      const pointer = element.getBoundingClientRect();
      return hudBoxes.filter(({ box }) => box.width > 0 && box.height > 0 && box.left < pointer.right && box.right > pointer.left && box.top < pointer.bottom && box.bottom > pointer.top).map(({ name }) => name);
    });
    const { game } = window.__murmuration;
    game.pickups.pickups = game.pickups.pickups.filter((pickup) => pickup !== window.__temporaryShard);
    return { hidden, visibleCount: shown.length };
  });
  expect(visibleCount > 0, `${name}: no pointer was visible for a shard straight above the view`);
  expect(report.length === 0, `${name}: the pointer overlaps ${report.join(', ')}`);
  console.log(`${name}: the pointer for a shard straight above the view clears the pause button and the weapon text`);
}

// Collects shards with the given seat until the shared count reaches the needed number.
// Returns the alive count and weapon just before the last shard.
async function collectAll(page, seat, { onCount = null } = {}) {
  let before = null;
  let frames = 0;
  const seen = new Set();
  while (frames < COLLECT_FRAME_LIMIT) {
    const state = await gameState(page);
    if (onCount && !seen.has(state.beamShards)) { seen.add(state.beamShards); await onCount(state.beamShards); }
    if (state.beamTime > 0 || state.beamShards >= state.beamShardsNeeded) return before;
    const moved = await page.evaluate((index) => {
      const { game } = window.__murmuration;
      const shard = game.pickups.pickups.find((pickup) => pickup.type === 'beamshard');
      if (!shard) return false;
      const { player } = game.seats[index];
      player.positionX = shard.x;
      player.positionY = shard.y;
      return true;
    }, seat);
    if (moved && state.beamShards === state.beamShardsNeeded - 1) before = { alive: state.alive, armed: state.armed };
    await waitFrames(page, moved ? COLLECT_STEP_FRAMES : SPAWN_FRAMES / 4);
    frames += moved ? COLLECT_STEP_FRAMES : SPAWN_FRAMES / 4;
  }
  throw new Error(`the count did not reach the needed shards within ${COLLECT_FRAME_LIMIT} frames`);
}

// From the sixth shard to the end of beam time: the arming, the surge, the return. Returns the numbers.
async function runBeamTime(page, before, { screenshots, seats = 1 }) {
  const started = await gameState(page);
  expect(started.beamTime > 0, `beam time did not start (beamTime ${started.beamTime})`);
  expect(started.armed === 'beam', `the armed weapon is ${started.armed} in beam time`);
  expect(started.surge === started.surgeTarget && started.surge > 1, `the surge is ${started.surge}, not ${started.surgeTarget}`);
  if (seats === 2) {
    expect(started.seats.every((seat) => seat.armed === 'beam'), `not every seat has the beam: ${JSON.stringify(started.seats.map((seat) => seat.armed))}`);
  }
  let peak = started.alive;
  let afterSurge = null;
  let frames = 0;
  while ((await gameState(page)).beamTime > 0 && frames < BEAM_FRAME_LIMIT) {
    await waitFrames(page, SAMPLE_FRAMES);
    frames += SAMPLE_FRAMES;
    const state = await gameState(page);
    peak = Math.max(peak, state.alive);
    if (afterSurge === null && frames >= SURGE_FRAMES) {
      afterSurge = state.alive;
      await screenshot(page, screenshots.during);
      if (screenshots.check) await screenshots.check(page);
    }
  }
  const ended = await gameState(page);
  expect(ended.beamTime === 0, `beam time did not end within ${BEAM_FRAME_LIMIT} frames`);
  expect(afterSurge !== null, 'beam time ended before the surge could be measured');
  expect(afterSurge >= before.alive * SURGE_RATIO, `alive ${before.alive} before beam time and ${afterSurge} after ${SURGE_FRAMES} frames: under ${SURGE_RATIO} times`);
  expect(ended.armed === before.armed, `the weapon after beam time is ${ended.armed}, was ${before.armed}`);
  expect(ended.beamShards === 0 && ended.surge === 1, `after beam time: ${ended.beamShards} shards, surge ${ended.surge}`);
  await waitFrames(page, 10);
  if (screenshots.after) await screenshot(page, screenshots.after);
  await waitFrames(page, AFTER_FRAMES);
  const later = (await gameState(page)).alive;
  return { before: before.alive, peak, afterSurge, later };
}

function printNumbers(label, numbers) {
  console.log(`${label}: alive just before beam time ${numbers.before}, peak during beam time ${numbers.peak}, ${numbers.later} two seconds after it ends (${numbers.afterSurge} after ${SURGE_FRAMES} frames of beam time)`);
}

// HUD elements that currently show (not display none), by their first class (state classes vary), under #hud.
const shownHudElements = (page) => page.evaluate(() => [...document.querySelectorAll('#hud *')]
  .filter((element) => element.classList.length > 0 && getComputedStyle(element).display !== 'none').map((element) => element.classList[0]));

async function overlapsAmong(page, selectors, againstSelectors) {
  return page.evaluate(([own, others]) => {
    const boxOf = (selector) => [...document.querySelectorAll(selector)]
      .filter((element) => getComputedStyle(element).display !== 'none')
      .map((element) => ({ selector, box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0);
    const hits = [];
    for (const first of own.flatMap(boxOf)) {
      for (const second of others.flatMap(boxOf)) {
        const a = first.box;
        const b = second.box;
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) hits.push(`${first.selector} x ${second.selector}`);
      }
    }
    return hits;
  }, [selectors, againstSelectors]);
}

async function runA(browser, server) {
  const { context, page } = await openPage(browser, server, DESKTOP_VIEWPORT);
  await startSolo(page);
  const waited = await waitForShard(page);
  console.log(`beam A: first shard after ${waited} frames`);
  await checkPointer(page, 'A');
  await screenshot(page, 'beam-pointer-1280x720.png');
  await pointerAboveView(page, 'beam-pointer-top-1280x720.png');
  const before = await collectAll(page, 0, {
    onCount: async (count) => { if (count === 3) { await waitFrames(page, 10); await screenshot(page, 'beam-pips-1280x720.png'); } },
  });
  const numbers = await runBeamTime(page, before, { screenshots: { during: 'beam-time-1280x720.png', after: 'beam-after-1280x720.png' } });
  printNumbers('beam A', numbers);
  globalThis.desktopHud = await shownHudElements(page);
  await finish('A', page, context);
}

async function runB(browser, server) {
  const { context, page } = await openPage(browser, server, PHONE_VIEWPORT);
  await startSolo(page);
  await waitForShard(page);
  await checkPointer(page, 'B');
  await screenshot(page, 'beam-pointer-844x390.png');
  await pointerAboveView(page, 'beam-pointer-top-844x390.png');
  const before = await collectAll(page, 0);
  const crowded = ['.hud-beam-pips', '.hud-beam'];
  const neighbours = ['.hud-pause', '.hud-weapon', '.settings-open'];
  const numbers = await runBeamTime(page, before, {
    screenshots: {
      during: 'beam-hud-844x390.png',
      check: async (current) => {
        const hits = await overlapsAmong(current, crowded, neighbours);
        expect(hits.length === 0, `B: the pips row or the bar overlaps: ${hits.join(', ')}`);
        const phoneHud = await shownHudElements(current);
        const missing = [...new Set(globalThis.desktopHud)].filter((name) => !phoneHud.includes(name));
        expect(missing.length === 0, `B: HUD elements shown at 1280 but display none at 844: ${missing.join(', ')}`);
      },
    },
  });
  printNumbers('beam B', numbers);
  await finish('B', page, context);
}

async function runCoop(browser, server, viewport, label, screenshotName, check) {
  const { context, page } = await openPage(browser, server, viewport);
  await startCoop(page);
  await waitForShard(page);
  const before = await collectAll(page, 1);
  const numbers = await runBeamTime(page, before, { seats: 2, screenshots: { during: screenshotName, check } });
  printNumbers(label, numbers);
  await finish(label, page, context);
}

async function run() {
  const server = await startServer();
  let browser = null;
  let failure = null;
  let noAdapter = false;
  try {
    browser = (await launchWebGpuBrowser()).browser;
    // navigator.gpu exists on a served page, not on about:blank.
    const probe = await browser.newPage();
    await probe.goto(server.url);
    noAdapter = !(await probe.evaluate(async () => Boolean(navigator.gpu && (await navigator.gpu.requestAdapter()))));
    await probe.close();
    if (!noAdapter) {
      await runA(browser, server);
      await runB(browser, server);
      await runCoop(browser, server, DESKTOP_VIEWPORT, 'beam C', 'beam-coop-1280x720.png', null);
      await runCoop(browser, server, PHONE_VIEWPORT, 'beam D', 'beam-coop-hud-844x390.png', async (current) => {
        const hits = await overlapsAmong(current, ['.hud-beam-pips', '.hud-beam'], ['.hud-pause', '.hud-weapon', '.settings-open', '.hud-seat']);
        expect(hits.length === 0, `D: the pips row or the bar overlaps: ${hits.join(', ')}`);
      });
    }
  } catch (error) {
    failure = error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.stop();
  }
  if (noAdapter) {
    console.error('beam-time: no WebGPU adapter, the evidence run did not happen');
    process.exit(EXIT_NO_ADAPTER);
  }
  if (failure) {
    console.error(failure.message);
    process.exit(1);
  }
  console.log('beam-time: ok');
}

await run();
