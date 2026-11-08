// Browser check for the bloom downsample. Loads tests/browser/pages/bloom.html, which renders a
// one-pixel line at 16 offsets through the downsample at every bloom quality and reports
// window.__bloomCheck. Usage: SMOKE_PORT=<port> node tests/browser/bloom.mjs
// Exit codes: 0 pass, 1 failure (check failed, console errors or timeout).
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';

const CHECK_TIMEOUT_MILLISECONDS = 15_000;
const EXIT_OK = 0;
const EXIT_FAILURE = 1;

async function run() {
  let server = null;
  let browser = null;
  try {
    server = await startServer();
    const launched = await launchWebGpuBrowser();
    browser = launched.browser;
    const { page } = launched;
    await page.goto(new URL('tests/browser/pages/bloom.html', server.url).href);
    let check;
    try {
      await page.waitForFunction(() => window.__bloomCheck !== undefined, null, { timeout: CHECK_TIMEOUT_MILLISECONDS });
      check = await page.evaluate(() => window.__bloomCheck);
    } catch (error) {
      console.error(`bloom: timed out waiting for window.__bloomCheck: ${error.message.split('\n')[0]}`);
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    if (page.consoleErrors.length > 0) {
      console.error('bloom: console errors:');
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    if (check.pass !== true) {
      console.error(`bloom: FAIL ${check.detail}`);
      return EXIT_FAILURE;
    }
    console.log(`bloom: ok ${check.detail}`);
    return EXIT_OK;
  } catch (error) {
    console.error(`bloom: ${error.message}`);
    return EXIT_FAILURE;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.stop();
  }
}

process.exitCode = await run();
