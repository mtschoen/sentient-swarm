// Visual capture for the weapon taste pass (task C0c): writes 1x PNGs of the ship, the rail shot,
// the sidewinders and the pulse ring under artifacts/. Not part of the checks. The turrets subject
// (task R29, not in the default set) writes artifacts/r29-turrets.png: TURRET_COUNT rail turrets
// (debugArm('rail', count)) firing beside the base gun, the turret ticks on the ship's ring.
// Usage: SMOKE_PORT=5189 node tests/browser/capture-weapons.mjs <before|after> [ship rail sidewinders pulse turrets]
import { mkdir, writeFile } from 'node:fs/promises';
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';

const ARTIFACTS_DIRECTORY = new URL('../../artifacts/', import.meta.url);
const ALL_SUBJECTS = ['ship', 'rail', 'sidewinders', 'pulse'];
const MOVE_FRAMES = 20;
const FIRE_FRAMES = Number(process.env.FIRE_FRAMES ?? 22);
const SIDEWINDER_FRAMES = 22;
const RING_FRAMES = 6;
const TURRET_COUNT = Number(process.env.TURRET_COUNT ?? 4);
const TIMEOUT_MILLISECONDS = 30_000;

async function save(name, captured) {
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  const base64 = captured.pngDataUrl.slice(captured.pngDataUrl.indexOf(',') + 1);
  const file = new URL(name, ARTIFACTS_DIRECTORY);
  await writeFile(file, Buffer.from(base64, 'base64'));
  console.log(`capture-weapons: wrote ${decodeURIComponent(file.pathname.slice(1))}`);
}

function installSyntheticGamepad() {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
  const gamepad = { id: 'capture synthetic gamepad', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons };
  window.__smokeGamepad = gamepad;
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => [gamepad] });
}

const setSticks = (page, axes) => page.evaluate((values) => { window.__smokeGamepad.axes = values; }, axes);
const frameNow = (page) => page.evaluate(() => window.__murmuration.frame);
const waitFrames = async (page, count) => {
  const target = (await frameNow(page)) + count;
  await page.waitForFunction((goal) => window.__murmuration.frame >= goal, target, { timeout: TIMEOUT_MILLISECONDS });
};
const arm = (page, type, tier) => page.evaluate(([name, level]) => window.__murmuration.game.debugArm(name, level), [type, tier]);
const capture = (page) => page.evaluate(() => window.__murmuration.capture());
// Waits count rendered frames inside the page, then captures the next one: a fast shot such as the
// rail lives only a few frames, shorter than a round trip from this script.
const captureAfterFrames = (page, count) => page.evaluate((frames) => new Promise((resolve) => {
  const target = window.__murmuration.frame + frames;
  const watch = () => (window.__murmuration.frame >= target ? resolve(window.__murmuration.capture()) : requestAnimationFrame(watch));
  requestAnimationFrame(watch);
}), count);

// The title menu owns the start (a stick only moves its cursor), so start the run as the smoke does.
async function startRun(page) {
  await page.evaluate(() => { const { game } = window.__murmuration; if (game.run.phase === 'ready') game.start(); });
  await setSticks(page, [-1, 0, 0, 0]);
  await waitFrames(page, MOVE_FRAMES);
  await setSticks(page, [0, 0, 0, 0]);
}

async function captureSubject(page, subject, suffix) {
  await startRun(page);
  if (subject === 'ship') {
    await arm(page, 'base', 1);
    await setSticks(page, [0, -1, 0, -1]);
    await waitFrames(page, MOVE_FRAMES);
    await setSticks(page, [0, -1, 0, -1]);
    await save(`c0c-ship-thrust-${suffix}.png`, await capture(page));
    await setSticks(page, [0, 0, 0, 0]);
    await waitFrames(page, MOVE_FRAMES * 2);
    await save(`c0c-ship-${suffix}.png`, await capture(page));
    return;
  }
  if (subject === 'turrets') {
    await arm(page, 'rail', TURRET_COUNT);
    await setSticks(page, [0, 0, 1, 0]);
    await save('r29-turrets.png', await captureAfterFrames(page, FIRE_FRAMES));
    await setSticks(page, [0, 0, 0, 0]);
    return;
  }
  await arm(page, subject, 3);
  await setSticks(page, [0, 0, 1, 0]);
  if (subject === 'pulse') {
    const captured = await page.evaluate((frames) => new Promise((resolve) => {
      let after = -1;
      const watch = () => {
        if (after < 0 && (window.__murmuration.stats?.ringsThisFrame ?? 0) > 0) after = 0;
        if (after >= 0) after += 1;
        if (after > frames) resolve(window.__murmuration.capture());
        else requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    }), RING_FRAMES);
    await save(`c0c-pulse-${suffix}.png`, captured);
  } else {
    await save(`c0c-${subject}-${suffix}.png`, await captureAfterFrames(page, subject === 'rail' ? FIRE_FRAMES : SIDEWINDER_FRAMES));
  }
  await setSticks(page, [0, 0, 0, 0]);
}

async function run() {
  const suffix = process.argv[2];
  if (suffix !== 'before' && suffix !== 'after') throw new Error('first argument must be before or after');
  const requested = process.argv.slice(3);
  const subjects = requested.length > 0 ? requested : ALL_SUBJECTS;
  const server = await startServer();
  let browser = null;
  try {
    for (const subject of subjects) {
      // A fresh page per subject so each starts from the same Ready state.
      const launched = await launchWebGpuBrowser();
      browser = launched.browser;
      const { page } = launched;
      await page.addInitScript(installSyntheticGamepad);
      const url = new URL(server.url);
      url.searchParams.set('probe', 'off');
      url.searchParams.set('capacity', '262144');
      await page.goto(url.href);
      await page.waitForFunction(() => window.__murmuration?.ready === true && window.__murmuration.stats != null, null, { timeout: TIMEOUT_MILLISECONDS });
      await captureSubject(page, subject, suffix);
      if (page.consoleErrors.length > 0) console.error(page.consoleErrors.join('\n'));
      await browser.close();
      browser = null;
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.child.kill();
  }
}

await run();
