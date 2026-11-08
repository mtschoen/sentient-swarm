// Visual capture for the time warp pickup (owner ruling R31): a 1280x720 page at 1x collects a
// time warp pickup placed on the ship, fires the base gun into the slowed swarm and, mid-warp
// (the composite's cold tint at full strength, the HUD's WARP bar partly drained), writes a page
// screenshot (canvas plus the DOM HUD) to artifacts/r31-timewarp.png. Not part of the checks.
// Usage: SMOKE_PORT=5196 node tests/browser/capture-timewarp.mjs
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';

const ARTIFACTS_DIRECTORY = new URL('../../artifacts/', import.meta.url);
const VIEWPORT = { width: 1280, height: 720 };
// Long enough for the swarm to fill in before the pickup, then about 2 s into the 6 s warp.
const FILL_FRAMES = 240;
const WARP_FRAMES = 120;
const TIMEOUT_MILLISECONDS = 60_000;

function installSyntheticGamepad() {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
  const gamepad = { id: 'capture synthetic gamepad', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons };
  window.__smokeGamepad = gamepad;
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => [gamepad] });
}

const setSticks = (page, axes) => page.evaluate((values) => { window.__smokeGamepad.axes = values; }, axes);
const waitFrames = async (page, count) => {
  const target = (await page.evaluate(() => window.__murmuration.frame)) + count;
  await page.waitForFunction((goal) => window.__murmuration.frame >= goal, target, { timeout: TIMEOUT_MILLISECONDS });
};

async function run() {
  const server = await startServer();
  let browser = null;
  try {
    const launched = await launchWebGpuBrowser({ contextOptions: { viewport: VIEWPORT, deviceScaleFactor: 1 } });
    browser = launched.browser;
    const { page } = launched;
    await page.addInitScript(installSyntheticGamepad);
    const url = new URL(server.url);
    url.searchParams.set('probe', 'off');
    url.searchParams.set('capacity', '262144');
    await page.goto(url.href);
    await page.waitForFunction(() => window.__murmuration?.ready === true && window.__murmuration.stats != null, null, { timeout: TIMEOUT_MILLISECONDS });
    await page.evaluate(() => {
      const { game } = window.__murmuration;
      game.start();
      game.debugInvulnerable(true);
    });
    await waitFrames(page, FILL_FRAMES);
    await page.evaluate(() => {
      const { game } = window.__murmuration;
      const { x, y } = game.player.position;
      game.pickups.pickups.push({ x, y, type: 'timewarp', age: 0, fade: 1 });
    });
    await setSticks(page, [0, 0, 1, 0]);
    await waitFrames(page, WARP_FRAMES);
    const state = await page.evaluate(() => {
      const { game } = window.__murmuration;
      return { timeWarp: game.state.timeWarp, strength: game.timeWarp.strength, scale: game.timeWarp.scale };
    });
    if (!(state.timeWarp > 0 && state.timeWarp < 1)) throw new Error(`expected a draining warp, got ${JSON.stringify(state)}`);
    await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
    const file = fileURLToPath(new URL('r31-timewarp.png', ARTIFACTS_DIRECTORY));
    await page.screenshot({ path: file });
    console.log(`capture-timewarp: wrote ${file} (warp left ${state.timeWarp.toFixed(2)}, strength ${state.strength.toFixed(2)}, scale ${state.scale.toFixed(2)})`);
    if (page.consoleErrors.length > 0) console.error(page.consoleErrors.join('\n'));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.stop();
  }
}

await run();
