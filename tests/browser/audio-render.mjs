// Offline audio render check. Loads tests/browser/pages/audio-render.html, which renders the real
// music and effects code through an OfflineAudioContext (nothing plays through the speakers), and
// writes WAVs plus a JSON summary (levels in dBFS, sections and per-phrase note counts) under
// artifacts/audio/. The page is reloaded before every render so long renders do not pile up
// memory in one renderer. Fails on console errors, a clipping mix (peak above 0 dBFS) or a quiet
// one (RMS below MINIMUM_MIX_RMS_DECIBELS); one worst-case render (bomb, death and 50 kills at
// intensity 0.9) must peak at or below 0 dBFS.
// Usage: SMOKE_PORT=5186 node tests/browser/audio-render.mjs [--seconds 120] [--label after]
//   [--source /path/to/audio/modules] [--skip-layers]
// (from Git Bash, set MSYS_NO_PATHCONV=1 so a --source path is not rewritten).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';

const INTENSITIES = [0.2, 0.5, 0.9];
const SOLO_SECONDS = 100;
const PLAY_SECONDS = 30;
const WORST_CASE_INTENSITY = 0.9;
const WORST_CASE_SECONDS = 8;
const MINIMUM_MIX_RMS_DECIBELS = -20;
const RENDER_TIMEOUT_MILLISECONDS = 300_000;
const PAGE_READY_TIMEOUT_MILLISECONDS = 30_000;
const EXIT_OK = 0;
const EXIT_FAILURE = 1;

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const levelText = ({ peakDecibels, rmsDecibels, speakerRmsDecibels }) => `peak ${peakDecibels} dBFS, rms ${rmsDecibels} dBFS, speaker rms ${speakerRmsDecibels} dBFS`;

async function run() {
  const seconds = Number(argument('seconds', 120));
  const label = argument('label', 'after');
  const source = argument('source', null);
  const skipLayers = process.argv.includes('--skip-layers');
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const outputDirectory = join(repositoryRoot, 'artifacts', 'audio');
  await mkdir(outputDirectory, { recursive: true });
  let server = null;
  let browser = null;
  const failures = [];
  try {
    server = await startServer();
    const launched = await launchWebGpuBrowser();
    browser = launched.browser;
    const { page } = launched;
    page.setDefaultTimeout(RENDER_TIMEOUT_MILLISECONDS);
    const pageUrl = new URL('tests/browser/pages/audio-render.html', server.url);
    if (source !== null) pageUrl.searchParams.set('source', source);
    // Loads a fresh page, then runs window.__audioRender[method](options) in it.
    const render = async (method, options) => {
      await page.goto(pageUrl.href);
      await page.waitForFunction(() => window.__audioRenderReady === true, null, { timeout: PAGE_READY_TIMEOUT_MILLISECONDS }).catch((error) => {
        throw new Error(`the render page did not load: ${error.message.split('\n')[0]} ${page.consoleErrors.join(' | ')}`);
      });
      return page.evaluate(([name, parameters]) => window.__audioRender[name](parameters), [method, options]);
    };
    const summary = { label, seconds, source, mixes: [], layers: [], effects: [], play: null, worstCase: null };

    for (const intensity of INTENSITIES) {
      const result = await render('renderMusic', { intensity, seconds, withWav: true });
      const path = join(outputDirectory, `${label}-music-${intensity}.wav`);
      await writeFile(path, Buffer.from(result.wav, 'base64'));
      delete result.wav;
      summary.mixes.push({ ...result, path });
      console.log(`audio-render: music ${intensity} (tempo ${result.tempo}): ${levelText(result.levels)} -> ${path}`);
      if (result.levels.peakDecibels > 0) failures.push(`music ${intensity} clips (peak ${result.levels.peakDecibels} dBFS)`);
      if (result.levels.rmsDecibels < MINIMUM_MIX_RMS_DECIBELS) failures.push(`music ${intensity} is quiet (rms ${result.levels.rmsDecibels} dBFS)`);
    }

    const layerNames = summary.mixes[0].layerNames;
    for (const intensity of skipLayers ? [] : INTENSITIES) {
      for (const layer of layerNames) {
        const result = await render('renderMusic', { intensity, seconds: SOLO_SECONDS, solo: [layer] });
        summary.layers.push({ intensity, layer, levels: result.levels });
        console.log(`audio-render: layer ${layer} at ${intensity}: ${levelText(result.levels)}`);
      }
    }

    summary.effects = await render('renderEffects', {});
    for (const { effect, levels } of summary.effects) console.log(`audio-render: effect ${effect}: ${levelText(levels)}`);

    const play = await render('renderPlay', { intensity: 0.5, seconds: PLAY_SECONDS });
    const playPath = join(outputDirectory, `${label}-play-0.5.wav`);
    await writeFile(playPath, Buffer.from(play.wav, 'base64'));
    summary.play = { levels: play.levels, path: playPath };
    console.log(`audio-render: play mix 0.5 (base gun, kills): ${levelText(play.levels)} -> ${playPath}`);
    if (play.levels.peakDecibels > 0) failures.push(`play mix clips (peak ${play.levels.peakDecibels} dBFS)`);

    const worst = await render('renderWorstCase', { intensity: WORST_CASE_INTENSITY, seconds: WORST_CASE_SECONDS });
    summary.worstCase = worst;
    console.log(`audio-render: worst case (bomb, death, 50 kills at intensity ${WORST_CASE_INTENSITY}): ${levelText(worst.levels)}`);
    if (!worst.stacked) failures.push('the worst-case render never stacked its effects');
    if (worst.levels.peakDecibels > 0) failures.push(`worst case clips (peak ${worst.levels.peakDecibels} dBFS)`);

    const summaryPath = join(outputDirectory, `${label}-summary.json`);
    await writeFile(summaryPath, JSON.stringify(summary, null, 1));
    console.log(`audio-render: summary -> ${summaryPath}`);
    if (page.consoleErrors.length > 0) failures.push(`console errors: ${page.consoleErrors.join(' | ')}`);
  } catch (error) {
    failures.push(error.message.split('\n')[0]);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.stop();
  }
  if (failures.length > 0) {
    failures.forEach((failure) => console.error(`audio-render: FAIL ${failure}`));
    return EXIT_FAILURE;
  }
  console.log('audio-render: ok');
  return EXIT_OK;
}

process.exitCode = await run();
