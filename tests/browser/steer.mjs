// Browser check for the coarse field and steering. Loads tests/browser/pages/steer.html, which
// runs four GPU scenarios (seek, dense cell, Lattice spacing, pressure versus collapse) and
// reports window.__steerCheck.
// Usage: node tests/browser/steer.mjs
// Exit codes: 0 pass, 1 failure (check failed, console errors or timeout).
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';

const CHECK_TIMEOUT_MILLISECONDS = 60_000;
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
    await page.goto(new URL('tests/browser/pages/steer.html', server.url).href);
    let check;
    try {
      await page.waitForFunction(() => window.__steerCheck !== undefined, null, { timeout: CHECK_TIMEOUT_MILLISECONDS });
      check = await page.evaluate(() => window.__steerCheck);
    } catch (error) {
      console.error(`steer: timed out waiting for window.__steerCheck: ${error.message.split('\n')[0]}`);
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    if (page.consoleErrors.length > 0) {
      console.error('steer: console errors:');
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    if (check.pass !== true) {
      console.error(`steer: FAIL ${check.detail}`);
      return EXIT_FAILURE;
    }
    console.log(`steer: ok ${check.detail}`);
    return EXIT_OK;
  } catch (error) {
    console.error(`steer: ${error.message}`);
    return EXIT_FAILURE;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.child.kill();
  }
}

process.exitCode = await run();
