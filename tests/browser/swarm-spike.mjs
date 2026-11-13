// Player swarm spike check (not part of check:gpu): drives the real game in headless Chromium with
// a synthetic gamepad and prints evidence for the swarm. Three runs, each on a fresh page:
//   1. ?swarm=12 (the default size): fire right for PLAY_FRAMES frames while the swarm sits in the
//      arena; reports the swarm size over time (losses on contact, growth from kills), the kills and
//      a screenshot artifacts/swarm-12-v3.png.
//   2. ?swarm=1: no fire, the point parked; the run must reach game over when the one ship dies.
//   3. ?swarm=256, contact off (debugInvulnerable) so the swarm stays full: fire for MEASURE_FRAMES
//      frames (the base gun, then scatter III); reports the mean and 95th percentile frame
//      interval, the mean CPU time of Game.update, the mean GPU completion latency of a render
//      (onSubmittedWorkDone), the most projectile spawns in any 3 s window (the longest projectile
//      lifetime) against the 8192-slot pool, and a screenshot artifacts/swarm-256-v3.png.
//   4. ?swarm=12 idle, then firing right: contact off, the point held still; IDLE_SHOTS close-ups of
//      the arena centre at 2x, IDLE_SHOT_FRAMES apart, as artifacts/swarm-v3-idle-N.png and
//      artifacts/swarm-v3-fire-N.png (the motion and the per-ship fire as stills).
// The page never gets a user gesture, so audio stays locked (nothing plays). Exit 1 on a failed
// expectation or console errors.
// Usage: SMOKE_PORT=5197 node tests/browser/swarm-spike.mjs
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';

const ARTIFACTS_DIRECTORY = new URL('../../artifacts/', import.meta.url);
const VIEWPORT = { width: 1280, height: 720 };
const TIMEOUT_MILLISECONDS = 120_000;
const PLAY_FRAMES = 1500;
const SAMPLE_EVERY_FRAMES = 100;
const GAME_OVER_FRAMES = 3600;
const MEASURE_FRAMES = 900;
const PROJECTILE_POOL_SLOTS = 8191;
const LONGEST_LIFETIME_SECONDS = 3;
const IDLE_SHOTS = 6;
const IDLE_SHOT_FRAMES = 30;
const IDLE_SETTLE_FRAMES = 180;
// CSS pixels around the arena centre (the point's start).
const IDLE_CLIP = { x: 640 - 240, y: 360 - 150, width: 480, height: 300 };

function installSyntheticGamepad() {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
  const gamepad = { id: 'swarm spike synthetic gamepad', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons };
  window.__smokeGamepad = gamepad;
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => [gamepad] });
}

const setSticks = (page, axes) => page.evaluate((values) => { window.__smokeGamepad.axes = values; }, axes);
const currentFrame = (page) => page.evaluate(() => window.__murmuration.frame);
const waitFrames = async (page, count) => {
  const target = (await currentFrame(page)) + count;
  await page.waitForFunction((goal) => window.__murmuration.frame >= goal, target, { timeout: TIMEOUT_MILLISECONDS });
};

async function openGame(browser, server, swarmShips, deviceScaleFactor = 1) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor });
  const page = await context.newPage();
  page.consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') page.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => page.consoleErrors.push(error.message));
  await page.addInitScript(installSyntheticGamepad);
  const url = new URL(server.url);
  url.searchParams.set('probe', 'off');
  url.searchParams.set('capacity', '262144');
  url.searchParams.set('swarm', String(swarmShips));
  await page.goto(url.href);
  await page.waitForFunction(() => window.__murmuration?.ready === true && window.__murmuration.stats != null, null, { timeout: TIMEOUT_MILLISECONDS });
  // Counts every projectile spawn with the game time it was queued at (the spawn-window measure).
  await page.evaluate(() => {
    const { game } = window.__murmuration;
    window.__spawnTimes = [];
    const queueSpawn = game.projectiles.queueSpawn.bind(game.projectiles);
    game.projectiles.queueSpawn = (spawn) => {
      window.__spawnTimes.push(game.sceneSeconds);
      return queueSpawn(spawn);
    };
  });
  return { context, page };
}

const readState = (page) => page.evaluate(() => {
  const { game } = window.__murmuration;
  return { phase: game.state.phase, ships: game.swarm.aliveCount, score: game.state.score, kills: game.score.kills ?? null, killsTotal: game.latestStats?.killsTotal ?? 0, aliveTotal: game.state.aliveTotal };
});

// Starts the run and confirms it is Playing a few frames later, starting again if something (the
// page's title menu settling) returned it to Ready first; one oneShipGameOver run once read Ready.
async function startRun(page) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.evaluate(() => window.__murmuration.game.start());
    await waitFrames(page, 10);
    const phase = await page.evaluate(() => window.__murmuration.game.state.phase);
    if (phase !== 'ready') return;
    console.log(`swarm-spike: the run read ${phase} after start, starting again`);
  }
  throw new Error('the run never left Ready');
}

async function screenshot(page, name) {
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  const file = fileURLToPath(new URL(name, ARTIFACTS_DIRECTORY));
  await page.screenshot({ path: file });
  return file;
}

async function defaultSwarm(browser, server, failures) {
  const { context, page } = await openGame(browser, server, 12);
  await startRun(page);
  await setSticks(page, [0, 0, 1, 0]);
  const samples = [];
  let shot = null;
  for (let frame = 0; frame < PLAY_FRAMES; frame += SAMPLE_EVERY_FRAMES) {
    await waitFrames(page, SAMPLE_EVERY_FRAMES);
    const state = await readState(page);
    samples.push(state);
    if (shot === null && frame >= 300) shot = await screenshot(page, 'swarm-12-v3.png');
    if (state.phase !== 'playing') break;
  }
  console.log('swarm-12 samples (phase ships score killsTotal aliveEnemies):');
  for (const sample of samples) console.log(`  ${sample.phase} ${sample.ships} ${sample.score} ${sample.killsTotal} ${sample.aliveTotal}`);
  const counts = samples.map((sample) => sample.ships);
  const lost = counts.some((count, index) => index > 0 && count < counts[index - 1]);
  const grew = counts.some((count, index) => index > 0 && count > counts[index - 1]) || Math.max(...counts) > 12;
  console.log(`swarm-12: losses seen ${lost}, growth seen ${grew}, screenshot ${shot}`);
  if (!lost) failures.push('swarm-12: no swarm ship was lost on contact');
  if (!grew) failures.push('swarm-12: the swarm never grew');
  if (page.consoleErrors.length > 0) failures.push(`swarm-12 console errors: ${page.consoleErrors.join(' | ')}`);
  await context.close();
}

async function oneShipGameOver(browser, server, failures) {
  const { context, page } = await openGame(browser, server, 1);
  await startRun(page);
  const startFrame = await currentFrame(page);
  let state = await readState(page);
  for (let waited = 0; waited < GAME_OVER_FRAMES && state.phase !== 'gameOver'; waited += 60) {
    await waitFrames(page, 60);
    state = await readState(page);
  }
  const frames = (await currentFrame(page)) - startFrame;
  console.log(`swarm-1: phase ${state.phase} after ${frames} frames, ships ${state.ships}`);
  if (state.phase !== 'gameOver') failures.push(`swarm-1: expected game over when the last ship died, got ${state.phase}`);
  else await screenshot(page, 'swarm-gameover.png');
  if (page.consoleErrors.length > 0) failures.push(`swarm-1 console errors: ${page.consoleErrors.join(' | ')}`);
  await context.close();
}

async function fullSwarm(browser, server, failures) {
  const { context, page } = await openGame(browser, server, 256);
  await page.evaluate(() => {
    const { game } = window.__murmuration;
    game.start();
    // Contact off for the measurement, so all 256 ships live, move and fire throughout (an armed
    // run loses most of them within the window; the contact pass itself is one bounded grid walk
    // per slot).
    game.debugInvulnerable(true);
    // Measured: rAF intervals, Game.update CPU time and render GPU completion latency.
    const measure = { intervals: [], updateMilliseconds: [], gpuMilliseconds: [], last: null };
    window.__measure = measure;
    const tick = (time) => {
      if (measure.last !== null) measure.intervals.push(time - measure.last);
      measure.last = time;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const update = game.update.bind(game);
    game.update = (deltaSeconds) => {
      const begin = performance.now();
      update(deltaSeconds);
      measure.updateMilliseconds.push(performance.now() - begin);
    };
    const render = game.render.bind(game);
    game.render = (alpha, deltaSeconds) => {
      const begin = performance.now();
      render(alpha, deltaSeconds);
      game.gpu.device.queue.onSubmittedWorkDone().then(() => measure.gpuMilliseconds.push(performance.now() - begin));
    };
  });
  await setSticks(page, [0, 0, 1, 0]);
  await waitFrames(page, 120);
  // Scatter III is the heaviest volley (17 balls every 0.2 s); arm it for the second half.
  await waitFrames(page, MEASURE_FRAMES / 2);
  await page.evaluate(() => window.__murmuration.game.debugArm('scatter', 3));
  await waitFrames(page, MEASURE_FRAMES / 2);
  const shot = await screenshot(page, 'swarm-256-v3.png');
  const result = await page.evaluate(({ window: windowSeconds }) => {
    const { intervals, updateMilliseconds, gpuMilliseconds } = window.__measure;
    const sorted = [...intervals].sort((first, second) => first - second);
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    const times = window.__spawnTimes;
    let most = 0;
    let start = 0;
    for (let end = 0; end < times.length; end += 1) {
      while (times[end] - times[start] > windowSeconds) start += 1;
      most = Math.max(most, end - start + 1);
    }
    const { game } = window.__murmuration;
    return {
      frames: intervals.length,
      meanInterval: mean(intervals),
      percentile95Interval: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      meanUpdate: mean(updateMilliseconds),
      meanGpu: mean(gpuMilliseconds),
      spawns: times.length,
      mostSpawnsInWindow: most,
      ships: game.swarm.aliveCount,
      phase: game.state.phase,
      armed: game.state.armed,
    };
  }, { window: LONGEST_LIFETIME_SECONDS });
  console.log(`swarm-256: ${JSON.stringify(result)}`);
  console.log(`swarm-256: screenshot ${shot}`);
  if (result.mostSpawnsInWindow > PROJECTILE_POOL_SLOTS) failures.push(`swarm-256: ${result.mostSpawnsInWindow} spawns in ${LONGEST_LIFETIME_SECONDS} s could overwrite live projectiles`);
  if (page.consoleErrors.length > 0) failures.push(`swarm-256 console errors: ${page.consoleErrors.join(' | ')}`);
  await context.close();
}

async function stills(browser, server, failures, { name, firing }) {
  const { context, page } = await openGame(browser, server, 12, 2);
  await page.evaluate(() => {
    const { game } = window.__murmuration;
    game.start();
    game.debugInvulnerable(true);
  });
  if (firing) await setSticks(page, [0, 0, 1, 0]);
  await waitFrames(page, IDLE_SETTLE_FRAMES);
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  const files = [];
  for (let shot = 1; shot <= IDLE_SHOTS; shot += 1) {
    const file = fileURLToPath(new URL(`swarm-v3-${name}-${shot}.png`, ARTIFACTS_DIRECTORY));
    await page.screenshot({ path: file, clip: IDLE_CLIP });
    files.push(file);
    await waitFrames(page, IDLE_SHOT_FRAMES);
  }
  console.log(`swarm-${name}: ${files.join(' ')}`);
  if (page.consoleErrors.length > 0) failures.push(`swarm-${name} console errors: ${page.consoleErrors.join(' | ')}`);
  await context.close();
}

async function run() {
  const server = await startServer();
  let browser = null;
  const failures = [];
  try {
    browser = (await launchWebGpuBrowser()).browser;
    await defaultSwarm(browser, server, failures);
    await oneShipGameOver(browser, server, failures);
    await fullSwarm(browser, server, failures);
    await stills(browser, server, failures, { name: 'idle', firing: false });
    await stills(browser, server, failures, { name: 'fire', firing: true });
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.stop();
  }
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('swarm-spike: ok');
}

await run();
