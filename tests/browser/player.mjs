// Browser check for player swarm contact, the persistent swarm hit mask, the kill-all pass and the
// pickup blast. Loads tests/browser/pages/player.html, which places motionless agents on chosen
// swarm ship positions, checks the hit bits, one kill per ship, persistence, dead and fresh slots
// clearing their bits, disarmed contact, kill-all and the capacity rebuild, and reports
// window.__playerCheck.
// Usage: SMOKE_PORT=5184 node tests/browser/player.mjs (SMOKE_PORT picks the Vite port).
// Exit codes: 0 pass, 1 failure (check failed, console errors or timeout).
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';

const CHECK_TIMEOUT_MILLISECONDS = 120_000;
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
    await page.goto(new URL('tests/browser/pages/player.html', server.url).href);
    let check;
    try {
      await page.waitForFunction(() => window.__playerCheck !== undefined, null, { timeout: CHECK_TIMEOUT_MILLISECONDS });
      check = await page.evaluate(() => window.__playerCheck);
    } catch (error) {
      console.error(`player: timed out waiting for window.__playerCheck: ${error.message.split('\n')[0]}`);
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    if (page.consoleErrors.length > 0) {
      console.error('player: console errors:');
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    if (check.pass !== true) {
      console.error(`player: FAIL ${check.detail}`);
      return EXIT_FAILURE;
    }
    console.log(`player: ok ${check.detail}`);
    return EXIT_OK;
  } catch (error) {
    console.error(`player: ${error.message}`);
    return EXIT_FAILURE;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.stop();
  }
}

process.exitCode = await run();
