// Browser smoke test. Serves the page with the Vite dev server (see server.mjs).
// SMOKE_URL, when set, skips spawning and uses that URL instead.
// Usage: node tests/browser/smoke.mjs [--frames N]
// Reads the composited frame back through window.__murmuration.capture (headless Chromium may never
// composite a WebGPU canvas, so page.screenshot() is not trusted) and writes artifacts/smoke.png and
// artifacts/smoke-zoom.png (4x inspect zoom, trails off).
// Exit codes: 0 ok, 1 failure (errors or timeout), 2 WebGPU adapter unavailable.
import { mkdir, writeFile } from 'node:fs/promises';
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';

const READY_TIMEOUT_MILLISECONDS = 10_000;
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_NO_ADAPTER = 2;
const MINIMUM_ALIVE_TOTAL = 1000;
// Something is drawn, and it is not a white smear.
const MINIMUM_LUMINANCE = 0.02;
const MAXIMUM_LUMINANCE = 0.6;
const RESIZE_WINDOW_FRAMES = 60;
const RESIZE_TOLERANCE = 0.05;
const PORTRAIT_VIEWPORT = { width: 800, height: 1200 };
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const MAXIMUM_BAND_LUMINANCE = 0.01;
const ARTIFACTS_DIRECTORY = new URL('../../artifacts/', import.meta.url);

async function writeDataUrl(name, dataUrl) {
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  await writeFile(new URL(name, ARTIFACTS_DIRECTORY), Buffer.from(base64, 'base64'));
}

function parseFrameCount(argumentList) {
  const index = argumentList.indexOf('--frames');
  if (index === -1) return 120;
  const frames = Number.parseInt(argumentList[index + 1], 10);
  if (!Number.isInteger(frames) || frames < 0) throw new Error('--frames needs a non-negative integer');
  return frames;
}

function waitForFrame(page, target) {
  return page.waitForFunction((frame) => window.__murmuration.frame >= frame, target, { timeout: READY_TIMEOUT_MILLISECONDS });
}

// Resizes to a portrait viewport and back, checking the agent count survives, the arena letterboxes
// and the bands stay black. Returns a failure message, or null. The spawner ramps the alive target
// for 90 seconds (about 4 percent of the count per 60 frames at this point), so a flat 5 percent
// comparison would fail on the ramp alone. Instead the growth over the 60 frames after the resize
// must match the growth over the 60 frames before it, within 5 percent of the count.
async function checkResize(page) {
  const readFrame = () => page.evaluate(() => window.__murmuration.frame);
  const readAlive = async () => (await page.evaluate(() => window.__murmuration.stats)).aliveTotal;
  const start = await readFrame();
  const earlier = await readAlive();
  await waitForFrame(page, start + RESIZE_WINDOW_FRAMES);
  const before = await readAlive();
  await page.setViewportSize(PORTRAIT_VIEWPORT);
  const resized = await readFrame();
  await waitForFrame(page, resized + RESIZE_WINDOW_FRAMES);
  const after = await readAlive();
  const portrait = await page.evaluate(() => window.__murmuration.capture());
  const { arenaRect } = portrait;
  const expected = { x: 0, y: 375, width: 800, height: 450 };
  if (portrait.width !== PORTRAIT_VIEWPORT.width || JSON.stringify(arenaRect) !== JSON.stringify(expected)) {
    return `smoke: expected ${PORTRAIT_VIEWPORT.width}px canvas with arenaRect ${JSON.stringify(expected)}, got ${portrait.width}x${portrait.height} ${JSON.stringify(arenaRect)}`;
  }
  const band = portrait.bandLuminance;
  if (!(band < MAXIMUM_BAND_LUMINANCE)) return `smoke: expected top band luminance < ${MAXIMUM_BAND_LUMINANCE}, got ${band}`;
  const growthBefore = before - earlier;
  const growthAfter = after - before;
  if (Math.abs(growthAfter - growthBefore) > RESIZE_TOLERANCE * before) {
    return `smoke: aliveTotal ${earlier} -> ${before} before the resize and ${before} -> ${after} after it differ by more than ${RESIZE_TOLERANCE * 100} percent`;
  }
  console.log(`smoke: resize aliveTotal ${earlier} -> ${before} -> ${after}, arenaRect ${JSON.stringify(arenaRect)}, top band luminance ${band.toFixed(4)}`);
  await page.setViewportSize(DEFAULT_VIEWPORT);
  const restored = await readFrame();
  await waitForFrame(page, restored + 5);
  return page.consoleErrors.length > 0 ? `smoke: console errors after resize: ${page.consoleErrors.join(' | ')}` : null;
}

async function run() {
  const frames = parseFrameCount(process.argv.slice(2));
  let server = null;
  let browser = null;
  try {
    let url = process.env.SMOKE_URL;
    if (!url) {
      server = await startServer();
      url = server.url;
    }
    const launched = await launchWebGpuBrowser();
    browser = launched.browser;
    const { page } = launched;

    await page.goto(url);
    const adapterAvailable = await page.evaluate(async () => {
      if (!navigator.gpu) return false;
      return (await navigator.gpu.requestAdapter()) !== null;
    });
    if (!adapterAvailable) {
      console.error('smoke: WebGPU adapter unavailable in headless Chromium (navigator.gpu missing or requestAdapter() returned null)');
      return EXIT_NO_ADAPTER;
    }

    try {
      await page.waitForFunction(() => window.__murmuration?.ready === true, null, { timeout: READY_TIMEOUT_MILLISECONDS });
      await page.waitForFunction(
        (target) => window.__murmuration.frame >= target,
        frames,
        { timeout: READY_TIMEOUT_MILLISECONDS },
      );
      await page.waitForFunction(() => window.__murmuration?.stats != null, null, { timeout: READY_TIMEOUT_MILLISECONDS });
    } catch (error) {
      console.error(`smoke: timed out waiting for ready, ${frames} frames and stats:${error.message.split('\n')[0]}`);
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }

    if (page.consoleErrors.length > 0) {
      console.error('smoke: console errors:');
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    const stats = await page.evaluate(() => window.__murmuration.stats);
    if (!stats || !(stats.aliveTotal > MINIMUM_ALIVE_TOTAL)) {
      console.error(`smoke: expected stats.aliveTotal > ${MINIMUM_ALIVE_TOTAL}, got ${JSON.stringify(stats)}`);
      return EXIT_FAILURE;
    }
    const resizeFailure = await checkResize(page);
    if (resizeFailure) {
      console.error(resizeFailure);
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    const capture = await page.evaluate(() => window.__murmuration.capture());
    await writeDataUrl('smoke.png', capture.pngDataUrl);
    // Trails off so the 4x frame shows glyph shapes rather than motion smears.
    const zoomCapture = await page.evaluate(() => window.__murmuration.capture({ inspectZoom: 4, settings: { trailDecay: 0 } }));
    await writeDataUrl('smoke-zoom.png', zoomCapture.pngDataUrl);
    const luminance = capture.meanLuminance;
    if (!(luminance > MINIMUM_LUMINANCE && luminance < MAXIMUM_LUMINANCE)) {
      console.error(`smoke: expected ${MINIMUM_LUMINANCE} < arena mean luminance < ${MAXIMUM_LUMINANCE}, got ${luminance.toFixed(4)} (${capture.width}x${capture.height})`);
      return EXIT_FAILURE;
    }
    if (page.consoleErrors.length > 0) {
      console.error('smoke: console errors after capture:');
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    const capturedStats = await page.evaluate(() => window.__murmuration.stats);
    console.log(`smoke: ok (aliveTotal ${stats.aliveTotal}, aliveTotal at capture ${capturedStats.aliveTotal}, arena mean luminance ${luminance.toFixed(4)})`);
    return EXIT_OK;
  } catch (error) {
    console.error(`smoke: ${error.message}`);
    return EXIT_FAILURE;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.child.kill();
  }
}

process.exitCode = await run();
