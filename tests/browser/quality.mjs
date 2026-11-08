// Browser check for live quality presets. Loads the game with the probe on (no ?capacity, no
// ?probe=off, fresh storage), so it starts at the desktop preset; clicks to start the run, then
// feeds the real QualityController slow frame times (onFrame, injected time) until the probe's
// first 'down' halves the particle budget and lowers bloom, and its second 'down' steps the
// preset to phoneHigh mid-run. Checks: the alive agents carried across the swap within 5 percent,
// the preset persisted, no console errors or device loss, and the next 10 frames all render
// (the renderer drew each one and the frame counter advanced). Reports the longest frame and the
// longest time the simulation did not step across the swap. Then applies phoneLow (half
// simulation rate, interpolated glyphs) and checks 10 more frames render.
// Writes artifacts/quality-desktop.png and artifacts/quality-phoneLow.png.
// Usage: node tests/browser/quality.mjs (SMOKE_PORT picks the server port)
// Exit codes: 0 pass, 1 failure.
import { mkdir, writeFile } from 'node:fs/promises';
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';

const CHECK_TIMEOUT_MILLISECONDS = 60_000;
const START_CLICK_HOLD_FRAMES = 5;
const PLAY_FRAMES_BEFORE_STEP = 120;
const FRAMES_AFTER_STEP = 10;
const ALIVE_TOLERANCE = 0.05;
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const ARTIFACTS_DIRECTORY = new URL('../../artifacts/', import.meta.url);

async function writeDataUrl(name, dataUrl) {
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  await writeFile(new URL(name, ARTIFACTS_DIRECTORY), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
}

// Page side: a per-frame recorder (time, frame counter, simulation step, capacity, latest stats,
// whether the renderer drew) installed on requestAnimationFrame.
function installRecorder() {
  const { game } = window.__murmuration;
  const records = [];
  let drew = false;
  const render = game.renderer.render.bind(game.renderer);
  game.renderer.render = (...parameters) => {
    const result = render(...parameters);
    drew = result;
    return result;
  };
  window.__qualityLost = null;
  game.gpu.device.lost.then((info) => { window.__qualityLost = info.message || info.reason || 'lost'; });
  const record = () => {
    records.push({
      time: performance.now(),
      frame: window.__murmuration.frame,
      sequence: game.simulation.frameSequence,
      capacity: game.simulation.capacity,
      statsSequence: game.latestStats?.frameSequence ?? 0,
      alive: game.latestStats?.aliveTotal ?? 0,
      drew,
      applying: window.__murmuration.quality.applying,
    });
    drew = false;
    requestAnimationFrame(record);
  };
  requestAnimationFrame(record);
  window.__qualityRecords = records;
}

// Page side: feeds slow frames until predicate() holds; returns how many it took.
function feedSlowFrames({ startSeconds, until }) {
  const quality = window.__murmuration.quality;
  const { game } = window.__murmuration;
  const predicates = {
    reduced: () => quality.reduced,
    applying: () => quality.applying,
  };
  for (let frame = 0; frame < 1000; frame += 1) {
    quality.onFrame(40, startSeconds + frame / 60);
    if (predicates[until]()) return { frames: frame + 1, particleCapacity: game.simulation.particlePool.capacity, bloom: game.renderer.bloomQuality };
  }
  return { frames: -1 };
}

function analyzeSwap(records, oldCapacity, newCapacity) {
  const installIndex = records.findIndex((entry) => entry.capacity === newCapacity);
  const applyIndex = records.findIndex((entry) => entry.applying);
  if (installIndex < 0 || applyIndex < 0) return { failure: `no install (${installIndex}) or apply (${applyIndex}) in ${records.length} records` };
  const before = records[installIndex - 1];
  const commitSequence = records[installIndex].sequence;
  const after = records.slice(installIndex).find((entry) => entry.statsSequence >= commitSequence && entry.capacity === newCapacity);
  const windowEnd = Math.min(records.length, installIndex + FRAMES_AFTER_STEP + 1);
  let longestFrame = 0;
  for (let index = applyIndex + 1; index < windowEnd; index += 1) longestFrame = Math.max(longestFrame, records[index].time - records[index - 1].time);
  // The longest stretch between two frames that saw the simulation step.
  let frozen = 0;
  let lastStepTime = records[applyIndex].time;
  for (let index = applyIndex + 1; index < windowEnd; index += 1) {
    if (records[index].sequence !== records[index - 1].sequence) {
      frozen = Math.max(frozen, records[index].time - lastStepTime);
      lastStepTime = records[index].time;
    }
  }
  const following = records.slice(installIndex, installIndex + FRAMES_AFTER_STEP);
  return {
    before,
    after,
    prepareMilliseconds: records[installIndex].time - records[applyIndex].time,
    longestFrame,
    frozen,
    following,
    oldCapacity,
  };
}

function framesRender(following) {
  if (following.length < FRAMES_AFTER_STEP) return false;
  return following.every((entry, index) => entry.drew && (index === 0 || entry.frame > following[index - 1].frame));
}

async function waitFrames(page, count) {
  const target = await page.evaluate((frames) => window.__murmuration.frame + frames, count);
  await page.waitForFunction((frame) => window.__murmuration.frame >= frame, target, { timeout: CHECK_TIMEOUT_MILLISECONDS });
}

async function run() {
  let server = null;
  let browser = null;
  try {
    server = await startServer();
    const launched = await launchWebGpuBrowser();
    browser = launched.browser;
    const { page } = launched;
    await page.goto(server.url);
    await page.waitForFunction(() => window.__murmuration?.ready === true, null, { timeout: CHECK_TIMEOUT_MILLISECONDS });
    const lines = [];
    const failures = [];
    const expect = (ok, text) => { lines.push(`${ok ? 'PASS' : 'FAIL'} ${text}`); if (!ok) failures.push(text); };

    const start = await page.evaluate(() => ({
      preset: window.__murmuration.quality.current,
      capacity: window.__murmuration.game.simulation.capacity,
      timestamps: window.__murmuration.game.frameTimer?.constructor.name,
    }));
    expect(start.preset === 'desktop' && start.capacity === 524288, `starts at ${start.preset} with capacity ${start.capacity} (need desktop, 524288), frame timer ${start.timestamps}`);
    await page.evaluate(installRecorder);
    const viewport = page.viewportSize();
    // Held for a few frames, as a person's click is: input samples the button once per step.
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.down();
    try {
      await waitFrames(page, START_CLICK_HOLD_FRAMES);
    } finally {
      await page.mouse.up();
    }
    await waitFrames(page, PLAY_FRAMES_BEFORE_STEP);
    const phase = await page.evaluate(() => window.__murmuration.stats?.phase);
    expect(phase === 'playing', `phase ${phase} before the step (need playing)`);
    await writeDataUrl('quality-desktop.png', (await page.evaluate(() => window.__murmuration.capture())).pngDataUrl);

    // Injected time far ahead of the page clock, so real frames cannot reach a decision meanwhile.
    const startSeconds = await page.evaluate(() => performance.now() / 1000 + 1000);
    const first = await page.evaluate(feedSlowFrames, { startSeconds, until: 'reduced' });
    expect(first.frames > 0 && first.particleCapacity === 65536 && first.bloom === 'medium', `first down after ${first.frames} slow frames: particles ${first.particleCapacity} (need 65536), bloom ${first.bloom} (need medium), preset still desktop`);
    const second = await page.evaluate(feedSlowFrames, { startSeconds: startSeconds + 10, until: 'applying' });
    expect(second.frames > 0, `second down after ${second.frames} slow frames starts applying phoneHigh`);
    await page.evaluate(() => window.__murmuration.quality.settled);
    await waitFrames(page, FRAMES_AFTER_STEP + 2);
    const applied = await page.evaluate(() => ({
      preset: window.__murmuration.quality.current,
      capacity: window.__murmuration.game.simulation.capacity,
      particles: window.__murmuration.game.simulation.particlePool.capacity,
      bloom: window.__murmuration.game.renderer.bloomQuality,
      stored: JSON.parse(localStorage.getItem('murmuration.settings.v1') ?? 'null'),
    }));
    expect(applied.preset === 'phoneHigh' && applied.capacity === 131072 && applied.particles === 65536 && applied.bloom === 'medium',
      `applied ${applied.preset}: capacity ${applied.capacity}, particles ${applied.particles}, bloom ${applied.bloom} (need phoneHigh 131072 65536 medium)`);
    expect(applied.stored?.preset === 'phoneHigh' && typeof applied.stored?.adapterKey === 'string', `persisted preset ${applied.stored?.preset} with adapter key "${applied.stored?.adapterKey}"`);

    const records = await page.evaluate(() => window.__qualityRecords);
    const swap = analyzeSwap(records, 524288, 131072);
    if (swap.failure) {
      expect(false, swap.failure);
    } else {
      const reference = Math.min(swap.before.alive, 131072);
      const carried = swap.after ? swap.after.alive / reference : 0;
      expect(swap.after !== undefined && Math.abs(carried - 1) <= ALIVE_TOLERANCE, `alive ${swap.before.alive} before the swap, ${swap.after?.alive ?? 'none'} after (ratio ${carried.toFixed(3)} of ${reference}, need within ${ALIVE_TOLERANCE * 100}%)`);
      expect(framesRender(swap.following), `the ${FRAMES_AFTER_STEP} frames after the install all rendered: frames ${swap.following.map((entry) => entry.frame).join(',')}, drew ${swap.following.map((entry) => (entry.drew ? 1 : 0)).join('')}`);
      lines.push(`MEASURED prepare (apply start to install) ${swap.prepareMilliseconds.toFixed(1)} ms with play running, longest frame from apply start to ${FRAMES_AFTER_STEP} frames after install ${swap.longestFrame.toFixed(1)} ms, longest time without a simulation step ${swap.frozen.toFixed(1)} ms`);
    }

    // phoneLow: half simulation rate with interpolated glyphs.
    const recordCount = await page.evaluate(() => window.__qualityRecords.length);
    await page.evaluate(() => window.__murmuration.quality.apply('phoneLow'));
    await waitFrames(page, FRAMES_AFTER_STEP + 2);
    const low = await page.evaluate((from) => ({
      rate: window.__murmuration.game.simulationRate,
      capacity: window.__murmuration.game.simulation.capacity,
      records: window.__qualityRecords.slice(from),
    }), recordCount);
    const lowInstall = low.records.findIndex((entry) => entry.capacity === 65536);
    const lowFollowing = lowInstall < 0 ? [] : low.records.slice(lowInstall, lowInstall + FRAMES_AFTER_STEP);
    const steps = lowFollowing.length > 1 ? lowFollowing.at(-1).sequence - lowFollowing[0].sequence : 0;
    expect(low.rate === 'half' && low.capacity === 65536 && framesRender(lowFollowing), `phoneLow: rate ${low.rate}, capacity ${low.capacity}, next ${FRAMES_AFTER_STEP} frames rendered ${framesRender(lowFollowing)}, ${steps} simulation steps over ${lowFollowing.length - 1} frames`);
    await writeDataUrl('quality-phoneLow.png', (await page.evaluate(() => window.__murmuration.capture())).pngDataUrl);

    const lost = await page.evaluate(() => window.__qualityLost);
    expect(lost === null, `device lost: ${lost ?? 'no'}`);
    expect(page.consoleErrors.length === 0, `console errors: ${page.consoleErrors.length}${page.consoleErrors.length ? ' ' + page.consoleErrors.join(' | ') : ''}`);
    lines.forEach((line) => console.log(`quality: ${line}`));
    if (failures.length > 0) {
      console.error(`quality: FAIL (${failures.length})`);
      return EXIT_FAILURE;
    }
    console.log('quality: ok');
    return EXIT_OK;
  } catch (error) {
    console.error(`quality: ${error.message}`);
    return EXIT_FAILURE;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.child.kill();
  }
}

process.exitCode = await run();
