// Browser check for GPU projectiles and grid-walking collision. Loads
// tests/browser/pages/projectiles.html, which seeds 10000 motionless agents in 2 by 2 blocks and
// fires rail, bullet, beam and pulse projectiles through them, and reports window.__projectilesCheck.
// Usage: SMOKE_PORT=5184 node tests/browser/projectiles.mjs (SMOKE_PORT picks the Vite port).
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
    await page.goto(new URL('tests/browser/pages/projectiles.html', server.url).href);
    let check;
    try {
      await page.waitForFunction(() => window.__projectilesCheck !== undefined, null, { timeout: CHECK_TIMEOUT_MILLISECONDS });
      check = await page.evaluate(() => window.__projectilesCheck);
    } catch (error) {
      console.error(`projectiles: timed out waiting for window.__projectilesCheck: ${error.message.split('\n')[0]}`);
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    if (page.consoleErrors.length > 0) {
      console.error('projectiles: console errors:');
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    if (check.pass !== true) {
      console.error(`projectiles: FAIL ${check.detail}`);
      return EXIT_FAILURE;
    }
    console.log(`projectiles: ok ${check.detail}`);
    return EXIT_OK;
  } catch (error) {
    console.error(`projectiles: ${error.message}`);
    return EXIT_FAILURE;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.child.kill();
  }
}

process.exitCode = await run();
