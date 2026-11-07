// Browser check for spawning and the Simulation facade. Loads tests/browser/pages/simulation.html,
// which steps a 65536-slot Simulation with SpawnPressure for 300 frames, then grows it to 131072
// slots, and reports window.__simulationCheck.
// Usage: node tests/browser/simulation.mjs
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
    await page.goto(new URL('tests/browser/pages/simulation.html', server.url).href);
    let check;
    try {
      await page.waitForFunction(() => window.__simulationCheck !== undefined, null, { timeout: CHECK_TIMEOUT_MILLISECONDS });
      check = await page.evaluate(() => window.__simulationCheck);
    } catch (error) {
      console.error(`simulation: timed out waiting for window.__simulationCheck: ${error.message.split('\n')[0]}`);
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    if (page.consoleErrors.length > 0) {
      console.error('simulation: console errors:');
      page.consoleErrors.forEach((line) => console.error(line));
      return EXIT_FAILURE;
    }
    if (check.pass !== true) {
      console.error(`simulation: FAIL ${check.detail}`);
      return EXIT_FAILURE;
    }
    console.log(`simulation: ok ${check.detail}`);
    return EXIT_OK;
  } catch (error) {
    console.error(`simulation: ${error.message}`);
    return EXIT_FAILURE;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.child.kill();
  }
}

process.exitCode = await run();
