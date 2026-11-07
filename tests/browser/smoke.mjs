// Browser smoke test. Serves the page with the Vite dev server (see server.mjs).
// SMOKE_URL, when set, skips spawning and uses that URL instead.
// Usage: node tests/browser/smoke.mjs [--frames N]
// Reads the composited frame back through window.__murmuration.capture (headless Chromium may never
// composite a WebGPU canvas, so page.screenshot() is not trusted) and writes artifacts/smoke.png and
// artifacts/smoke-zoom.png (4x inspect zoom, trails off), then holds a debug kill at the arena
// center and writes artifacts/smoke-kill.png (trails off, glyphs hidden: particles and grid only).
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
// Equals CAPTURE_SETTLE_FRAMES in main.js: the hold spans the flash capture's settle frames.
const KILL_HOLD_FRAMES = 30;
// Measured rise with glyphs hidden is about 0.27 at the center against about 0.001 in the control box.
const KILL_FLASH_MARGIN = 0.1;
const KILL_FLASH_SETTINGS = { trailDecay: 0, glyphDevicePixels: 0 };
const KILL_BOX_DEVICE_PIXELS = 60;
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

// Kill flash check. Two captures with KILL_FLASH_SETTINGS (overrides settle 30 frames before each
// capture): one calm, one taken while the primary button is held at the canvas center, so the hold
// spans the second capture's settle frames (KILL_HOLD_FRAMES, the CAPTURE_SETTLE_FRAMES of main.js).
// Trails are off so history cannot saturate the boxes. Glyphs are hidden (glyphDevicePixels 0)
// because the kill also removes the dense glyph mass from the center box, which cancels most of the
// particle and grid flash in a full render (measured: net change -0.03 to +0.04), so the check
// measures what the kill adds, particles plus the threat-lit warp grid.
// Both captures sample a 60 by 60 device-pixel box at the arena center and a control box of the
// same size at 25 percent of the arena width and height, far outside the 0.6 world-unit kill
// radius. The center rise must beat the control change by KILL_FLASH_MARGIN. Returns a failure
// message, or null.
async function checkKillFlash(page) {
  const arenaRect = (await page.evaluate(() => window.__murmuration.capture())).arenaRect;
  const boxAt = (fractionX, fractionY) => ({
    x: Math.round(arenaRect.x + arenaRect.width * fractionX - KILL_BOX_DEVICE_PIXELS / 2),
    y: Math.round(arenaRect.y + arenaRect.height * fractionY - KILL_BOX_DEVICE_PIXELS / 2),
    width: KILL_BOX_DEVICE_PIXELS,
    height: KILL_BOX_DEVICE_PIXELS,
  });
  const regions = [boxAt(0.5, 0.5), boxAt(0.25, 0.25)];
  const captureFlashLayers = () => page.evaluate(
    ([boxes, settings]) => window.__murmuration.capture({ settings, regions: boxes }),
    [regions, KILL_FLASH_SETTINGS],
  );
  const bounds = await page.locator('#arena').boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const calm = await captureFlashLayers();
  await page.mouse.down();
  let flash;
  try {
    flash = await captureFlashLayers();
  } finally {
    await page.mouse.up();
  }
  await writeDataUrl('smoke-kill.png', flash.pngDataUrl);
  const [centerBefore, controlBefore] = calm.regionLuminances;
  const [centerAfter, controlAfter] = flash.regionLuminances;
  const centerRise = centerAfter - centerBefore;
  const controlChange = controlAfter - controlBefore;
  console.log(`smoke: kill flash (trails off, glyphs hidden, ${KILL_HOLD_FRAMES} held frames) center box ${centerBefore.toFixed(4)} -> ${centerAfter.toFixed(4)}, control box ${controlBefore.toFixed(4)} -> ${controlAfter.toFixed(4)}`);
  if (!(centerRise - Math.abs(controlChange) > KILL_FLASH_MARGIN)) {
    return `smoke: expected the center box rise (${centerRise.toFixed(4)}) to exceed the control box change (${controlChange.toFixed(4)}) by more than ${KILL_FLASH_MARGIN}`;
  }
  return page.consoleErrors.length > 0 ? `smoke: console errors after the kill: ${page.consoleErrors.join(' | ')}` : null;
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
    const killFailure = await checkKillFlash(page);
    if (killFailure) {
      console.error(killFailure);
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
