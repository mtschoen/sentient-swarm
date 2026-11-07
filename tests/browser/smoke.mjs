// Browser smoke test. Serves the page with the Vite dev server (see server.mjs).
// SMOKE_URL, when set, skips spawning and uses that URL instead.
// Usage: node tests/browser/smoke.mjs [--frames N]
// Exit codes: 0 ok, 1 failure (errors or timeout), 2 WebGPU adapter unavailable.
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';

const READY_TIMEOUT_MILLISECONDS = 10_000;
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_NO_ADAPTER = 2;

function parseFrameCount(argumentList) {
  const index = argumentList.indexOf('--frames');
  if (index === -1) return 120;
  const frames = Number.parseInt(argumentList[index + 1], 10);
  if (!Number.isInteger(frames) || frames < 0) throw new Error('--frames needs a non-negative integer');
  return frames;
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
    } catch (error) {
      console.error(`smoke: timed out waiting for ready and ${frames} frames: ${error.message.split('\n')[0]}`);
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }

    if (page.consoleErrors.length > 0) {
      console.error('smoke: console errors:');
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    console.log('smoke: ok');
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
