// Deterministic render capture. Loads tests/browser/pages/render-capture.html, which seeds a
// never-stepped 65536-slot Simulation with a fixed agent pattern and draws one fixed scene (ship,
// one projectile of each kind, one pickup) at render time 1.0 with trails off, once per bloom
// quality. Writes <out>/render-<quality>.png (to look at), <out>/render-<quality>.rgba (raw RGBA
// bytes, row-major from the top) and <out>/render-capture.json (size and qualities).
// --compare <directory> then compares each quality's RGBA with that directory's and fails when the
// mean absolute per-channel difference exceeds MAXIMUM_MEAN_DIFFERENCE or any channel differs by
// more than MAXIMUM_CHANNEL_DIFFERENCE (both in 0..255 units).
// Usage: SMOKE_PORT=5186 node tests/browser/render-capture.mjs --out <directory> [--compare <directory>]
// Exit codes: 0 pass, 1 failure (page failure, console errors, timeout or a difference over the limits).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAXIMUM_MEAN_DIFFERENCE = 0.5;
export const MAXIMUM_CHANNEL_DIFFERENCE = 4;
const CHECK_TIMEOUT_MILLISECONDS = 60_000;
const MANIFEST_NAME = 'render-capture.json';
const EXIT_OK = 0;
const EXIT_FAILURE = 1;

// Mean and largest absolute per-channel difference of two equal-length byte arrays.
export function compareFrames(first, second) {
  if (first.length !== second.length) throw new Error(`frame sizes differ: ${first.length} and ${second.length} bytes`);
  let total = 0;
  let maximum = 0;
  for (let index = 0; index < first.length; index += 1) {
    const difference = Math.abs(first[index] - second[index]);
    total += difference;
    if (difference > maximum) maximum = difference;
  }
  return { mean: first.length === 0 ? 0 : total / first.length, maximum };
}

export function withinLimits({ mean, maximum }) {
  return mean <= MAXIMUM_MEAN_DIFFERENCE && maximum <= MAXIMUM_CHANNEL_DIFFERENCE;
}

// --out is required; --compare is optional.
export function parseArguments(argumentList) {
  const options = { out: null, compare: null };
  for (let index = 0; index < argumentList.length; index += 1) {
    const name = argumentList[index];
    if (name !== '--out' && name !== '--compare') throw new Error(`unknown argument ${name}`);
    const value = argumentList[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a directory`);
    options[name.slice(2)] = value;
    index += 1;
  }
  if (options.out === null) throw new Error('--out <directory> is required');
  return options;
}

async function capture() {
  const { launchWebGpuBrowser } = await import('./launch.mjs');
  const { startServer } = await import('./server.mjs');
  let server = null;
  let browser = null;
  try {
    server = await startServer();
    const launched = await launchWebGpuBrowser();
    browser = launched.browser;
    const { page } = launched;
    await page.goto(new URL('tests/browser/pages/render-capture.html', server.url).href);
    await page.waitForFunction(() => window.__renderCapture !== undefined, null, { timeout: CHECK_TIMEOUT_MILLISECONDS });
    const result = await page.evaluate(() => window.__renderCapture);
    if (page.consoleErrors.length > 0) throw new Error(`console errors:\n${page.consoleErrors.join('\n')}`);
    if (result.pass !== true) throw new Error(`page failed: ${result.detail}`);
    return result;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.child.kill();
  }
}

async function writeCapture(directory, result) {
  await mkdir(directory, { recursive: true });
  for (const { quality, pixelsBase64, pngDataUrl } of result.qualities) {
    await writeFile(join(directory, `render-${quality}.rgba`), Buffer.from(pixelsBase64, 'base64'));
    await writeFile(join(directory, `render-${quality}.png`), Buffer.from(pngDataUrl.split(',')[1], 'base64'));
  }
  const manifest = { width: result.width, height: result.height, format: 'rgba8unorm', qualities: result.qualities.map(({ quality }) => quality) };
  await writeFile(join(directory, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// Returns true when every quality is within the limits; prints one line per quality.
async function compareDirectories(directory, reference) {
  const current = JSON.parse(await readFile(join(directory, MANIFEST_NAME), 'utf8'));
  const expected = JSON.parse(await readFile(join(reference, MANIFEST_NAME), 'utf8'));
  if (current.width !== expected.width || current.height !== expected.height) {
    console.error(`render-capture: size ${current.width}x${current.height} differs from the reference ${expected.width}x${expected.height}`);
    return false;
  }
  let pass = true;
  for (const quality of expected.qualities) {
    if (!current.qualities.includes(quality)) {
      console.error(`render-capture: ${quality}: missing from ${directory}`);
      pass = false;
      continue;
    }
    const [first, second] = await Promise.all([directory, reference].map((root) => readFile(join(root, `render-${quality}.rgba`))));
    const difference = compareFrames(first, second);
    const ok = withinLimits(difference);
    pass &&= ok;
    const line = `render-capture: ${quality}: mean ${difference.mean.toFixed(4)}/255, maximum ${difference.maximum}/255 (limits ${MAXIMUM_MEAN_DIFFERENCE}, ${MAXIMUM_CHANNEL_DIFFERENCE}) ${ok ? 'ok' : 'FAIL'}`;
    (ok ? console.log : console.error)(line);
  }
  return pass;
}

async function run(argumentList) {
  let options;
  try {
    options = parseArguments(argumentList);
  } catch (error) {
    console.error(`render-capture: ${error.message}`);
    return EXIT_FAILURE;
  }
  try {
    const result = await capture();
    const directory = resolve(options.out);
    const manifest = await writeCapture(directory, result);
    console.log(`render-capture: wrote ${manifest.qualities.length} qualities at ${manifest.width}x${manifest.height} to ${directory}`);
    if (options.compare === null) return EXIT_OK;
    return (await compareDirectories(directory, resolve(options.compare))) ? EXIT_OK : EXIT_FAILURE;
  } catch (error) {
    console.error(`render-capture: ${error.message}`);
    return EXIT_FAILURE;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
