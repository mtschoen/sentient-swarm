// Browser check for the GPU spatial grid. Loads tests/browser/pages/grid.html, which seeds
// agents, runs SpatialGrid.encode and verifies the readback, then reports window.__gridCheck.
// Usage: node tests/browser/grid.mjs
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
    await page.goto(new URL('tests/browser/pages/grid.html', server.url).href);
    let check;
    try {
      await page.waitForFunction(() => window.__gridCheck !== undefined, null, { timeout: CHECK_TIMEOUT_MILLISECONDS });
      check = await page.evaluate(() => window.__gridCheck);
    } catch (error) {
      console.error(`grid: timed out waiting for window.__gridCheck: ${error.message.split('\n')[0]}`);
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    if (page.consoleErrors.length > 0) {
      console.error('grid: console errors:');
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    if (check.pass !== true) {
      console.error(`grid: FAIL ${check.detail}`);
      return EXIT_FAILURE;
    }
    console.log(`grid: ok ${check.detail}`);
    return EXIT_OK;
  } catch (error) {
    console.error(`grid: ${error.message}`);
    return EXIT_FAILURE;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.stop();
  }
}

process.exitCode = await run();
