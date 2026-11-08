// Browser check for live quality presets. Loads the game with the probe on (no ?capacity, no
// ?probe=off, fresh storage), so it starts at the desktop preset; clicks to start the run, then
// feeds the real QualityController slow frame times (onFrame, injected time) until the probe's
// first 'down' halves the particle budget and lowers bloom, and its second 'down' steps the
// preset to phoneHigh mid-run. Checks: the carried count is exact (below), alive 10 frames after
// the install stays under 1.05 times the alive target, the preset persisted, no console errors or device loss, and the next 10 frames all render
// (the renderer drew each one and the frame counter advanced). Reports the longest frame and the
// longest time the simulation did not step across the swap. Then applies phoneLow (half
// simulation rate, interpolated glyphs) and checks 10 more frames render.
// First, with ?timer=cpu (the CPU fallback forced on this timestamp-capable device), records the
// milliseconds the CPU frame timer reports over CPU_TIMER_FRAMES frames of idle play (no input
// after the start click, not forwarded to the controller) and checks their 90th percentile is
// below the probe's down threshold (FrameTimeProbe defaults: 10 ms x 1.35), so a healthy device
// is not stepped down by a timer that tracks the vsync interval; it also reports the 'up'
// threshold (10 ms x 0.6) and the median requestAnimationFrame interval.
// The carry is counted exactly: the page wraps the swap's commit and install and copies agent
// buffers to MAP_READ buffers in queue order, counting alive flags: O, the old simulation's alive
// agents just before the commit; N, the new simulation's right after the install, before its first
// step; A, the first stats frame after the install. The gate is N within 0.5 percent of
// min(O, 131072). The former gate (the first stats frame after the commit against min(alive of the
// last record before the install, 131072), within 5 percent) compared two counts the compaction
// never saw: the reference was 1 to 3 steps stale, so spawns requested in flight joined the
// numerator. Task D8 (2026-11-07, desktop RTX, other lanes loading the GPU, prepare 13 to 37 ms,
// longest frame 18 to 23 ms): 5 as-is runs O 1187 1138 1342 1138 1138, N equal to O in all,
// old ratio 1.073 1.169 1.047 1.169 1.072, the rise A minus the old reference (83 169 60 169 78)
// exactly the spawns requested after the reference's stats; 5 held runs (--hold-spawns) O 1044
// 1044 1044 1044 1138, N and A equal to O, old ratio 1.000, 61 to 62 requests totalling 0.
// --hold-spawns holds SpawnPressure at target 0 from HOLD_STEPS steps before the commit to
// HOLD_STEPS after and asserts no request spawned and A is at most 1 percent over N (agents that
// appear with spawning stopped are a carry bug); without it the target bound is checked instead.
// Writes artifacts/quality-desktop.png and artifacts/quality-phoneLow.png.
// Usage: node tests/browser/quality.mjs [--hold-spawns] (SMOKE_PORT picks the server port)
// Exit codes: 0 pass, 1 failure.
import { mkdir, writeFile } from 'node:fs/promises';
import { launchWebGpuBrowser } from './launch.mjs';
import { startServer } from './server.mjs';
import { FrameTimeProbe } from '../../src/settings/probe.js';
import { AGENT_FLAG_ALIVE, AGENT_OFFSETS, AGENT_STRIDE_BYTES } from '../../src/sim/layout.js';

const CHECK_TIMEOUT_MILLISECONDS = 60_000;
const START_CLICK_HOLD_FRAMES = 5;
const PLAY_FRAMES_BEFORE_STEP = 120;
const FRAMES_AFTER_STEP = 10;
// N, the alive agents in the new simulation at install, against min(O, new capacity).
const CARRY_TOLERANCE = 0.005;
// Alive FRAMES_AFTER_STEP frames after the install stays under this multiple of the alive target.
const TARGET_BOUND = 1.05;
// With --hold-spawns, the first stats frame after the install counts at most this much over N.
const HELD_APPEAR_TOLERANCE = 0.01;
const CPU_TIMER_FRAMES = 400;
const PROBE = new FrameTimeProbe();
const DOWN_THRESHOLD_MILLISECONDS = PROBE.targetMilliseconds * PROBE.downRatio;
const UP_THRESHOLD_MILLISECONDS = PROBE.targetMilliseconds * PROBE.upRatio;
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const HOLD_SPAWNS = process.argv.includes('--hold-spawns');
const HOLD_STEPS = 30;
const SWAP_PROBE_LAYOUT = { strideWords: AGENT_STRIDE_BYTES / 4, flagsWord: AGENT_OFFSETS.flags / 4, aliveFlag: AGENT_FLAG_ALIVE };
const ARTIFACTS_DIRECTORY = new URL('../../artifacts/', import.meta.url);

async function writeDataUrl(name, dataUrl) {
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  await writeFile(new URL(name, ARTIFACTS_DIRECTORY), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
}

// Page side: a per-frame recorder (time, frame counter, simulation step, capacity, latest stats,
// whether the renderer drew) installed on requestAnimationFrame.
function installRecorder() {
  const { game } = window.__murmuration;
  const records = [];
  let drew = false;
  const render = game.renderer.render.bind(game.renderer);
  game.renderer.render = (...parameters) => {
    const result = render(...parameters);
    drew = result;
    return result;
  };
  window.__qualityLost = null;
  game.gpu.device.lost.then((info) => { window.__qualityLost = info.message || info.reason || 'lost'; });
  const record = () => {
    records.push({
      time: performance.now(),
      frame: window.__murmuration.frame,
      sequence: game.simulation.frameSequence,
      capacity: game.simulation.capacity,
      statsSequence: game.latestStats?.frameSequence ?? 0,
      alive: game.latestStats?.aliveTotal ?? 0,
      target: game.activeSpawnPressure.targetAlive,
      drew,
      applying: window.__murmuration.quality.applying,
    });
    drew = false;
    requestAnimationFrame(record);
  };
  requestAnimationFrame(record);
  window.__qualityRecords = records;
}

// Page side: wraps the capacity swap's commit and install to count alive agents exactly, by
// copying agent buffers to MAP_READ buffers in queue order: O, the old simulation's agents as
// queued just before the commit (what the compaction reads); N, the new simulation's agents right
// after the install, before its first step (what the compaction carried); A, the alive total of
// the first stats frame after the install. Only the first swap is measured. Also records every
// SpawnPressure request (sequence of the step it is for, total) so a hold can be confirmed.
function installSwapProbe({ strideWords, flagsWord, aliveFlag }) {
  const { game } = window.__murmuration;
  const device = game.gpu.device;
  const probe = { O: null, N: null, A: null, ASequence: null, commitSequence: null, requests: [], pending: [] };
  window.__swapProbe = probe;
  const queueCount = (buffer, name) => {
    const staging = device.createBuffer({ label: 'swap-probe-' + name, size: buffer.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder({ label: 'swap-probe-' + name });
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size);
    device.queue.submit([encoder.finish()]);
    probe.pending.push(staging.mapAsync(GPUMapMode.READ).then(() => {
      const words = new Uint32Array(staging.getMappedRange());
      let alive = 0;
      for (let index = flagsWord; index < words.length; index += strideWords) alive += words[index] & aliveFlag;
      probe[name] = alive;
      staging.unmap();
      staging.destroy();
    }));
  };
  const swap = game.capacitySwap;
  const commit = swap.commit;
  const install = swap.install;
  swap.commit = (prepared) => {
    if (probe.commitSequence === null) {
      probe.commitSequence = game.simulation.frameSequence;
      queueCount(game.simulation.agentsBuffer, 'O');
    }
    return commit(prepared);
  };
  swap.install = (next) => {
    install(next);
    if (probe.pending.length !== 1) return;
    queueCount(next.agentsBuffer, 'N');
    const readAllStats = next.readAllStats.bind(next);
    next.readAllStats = () => {
      const frames = readAllStats();
      const first = frames.find((stats) => stats.frameSequence > probe.commitSequence);
      if (probe.A === null && first) {
        probe.A = first.aliveTotal;
        probe.ASequence = first.frameSequence;
      }
      return frames;
    };
  };
  const pressure = game.spawnPressure;
  const update = pressure.update.bind(pressure);
  pressure.update = (...parameters) => {
    const counts = update(...parameters);
    probe.requests.push({ sequence: parameters[3], total: counts.reduce((sum, count) => sum + count, 0) });
    return counts;
  };
}

// Page side: holds spawning (alive target 0, no refill); releaseSpawns restores the ramp. Both
// return the simulation's frame sequence at the call.
function holdSpawns() {
  const pressure = window.__murmuration.game.spawnPressure;
  window.__heldRamp = { ...pressure.ramp };
  pressure.setRamp({ floorFraction: 0, ceilingFraction: 0, refillFractionPerSecond: 0 });
  return window.__murmuration.game.simulation.frameSequence;
}

function releaseSpawns() {
  window.__murmuration.game.spawnPressure.setRamp(window.__heldRamp);
  return window.__murmuration.game.simulation.frameSequence;
}

// Page side: feeds slow frames until predicate() holds; returns how many it took.
function feedSlowFrames({ startSeconds, until }) {
  const quality = window.__murmuration.quality;
  const { game } = window.__murmuration;
  const predicates = {
    reduced: () => quality.reduced,
    applying: () => quality.applying,
  };
  for (let frame = 0; frame < 1000; frame += 1) {
    quality.onFrame(40, startSeconds + frame / 60);
    if (predicates[until]()) return { frames: frame + 1, particleCapacity: game.simulation.particlePool.capacity, bloom: game.renderer.bloomQuality };
  }
  return { frames: -1 };
}

// Page side: replaces the frame timer's report with a recorder (the controller sees nothing) and
// records requestAnimationFrame times alongside.
function installTimerRecorder() {
  const timer = window.__murmuration.game.frameTimer;
  window.__timerMilliseconds = [];
  window.__animationFrameTimes = [];
  timer.onFrame = (milliseconds) => window.__timerMilliseconds.push(milliseconds);
  const record = (time) => {
    window.__animationFrameTimes.push(time);
    requestAnimationFrame(record);
  };
  requestAnimationFrame(record);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function clickToStart(page) {
  const viewport = page.viewportSize();
  // Held for a few frames, as a person's click is: input samples the button once per step.
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.mouse.down();
  try {
    await waitFrames(page, START_CLICK_HOLD_FRAMES);
  } finally {
    await page.mouse.up();
  }
}

// The CPU frame timer in idle play, against the probe thresholds.
async function measureCpuTimer(page, url, expect, lines) {
  await page.goto(url + '?timer=cpu');
  await page.waitForFunction(() => window.__murmuration?.ready === true, null, { timeout: CHECK_TIMEOUT_MILLISECONDS });
  const timerName = await page.evaluate(() => window.__murmuration.game.frameTimer?.constructor.name);
  expect(timerName === 'CpuFrameTimer', `?timer=cpu frame timer ${timerName} (need CpuFrameTimer)`);
  await clickToStart(page);
  await page.evaluate(installTimerRecorder);
  await page.waitForFunction((count) => window.__timerMilliseconds.length >= count, CPU_TIMER_FRAMES, { timeout: CHECK_TIMEOUT_MILLISECONDS });
  const recorded = await page.evaluate(() => ({ milliseconds: window.__timerMilliseconds, frames: window.__animationFrameTimes, phase: window.__murmuration.stats?.phase }));
  const values = recorded.milliseconds.slice(0, CPU_TIMER_FRAMES);
  const intervals = recorded.frames.slice(1).map((time, index) => time - recorded.frames[index]);
  const p90 = percentile(values, 0.9);
  expect(p90 < DOWN_THRESHOLD_MILLISECONDS, `CPU timer p90 ${p90.toFixed(2)} ms over ${values.length} frames of idle play (need below the down threshold ${DOWN_THRESHOLD_MILLISECONDS.toFixed(1)} ms)`);
  lines.push(`MEASURED CPU timer: p50 ${percentile(values, 0.5).toFixed(2)} ms, p90 ${p90.toFixed(2)} ms, maximum ${Math.max(...values).toFixed(2)} ms; up threshold ${UP_THRESHOLD_MILLISECONDS.toFixed(1)} ms ${p90 < UP_THRESHOLD_MILLISECONDS ? 'met (up steps expected)' : 'not met (no up steps)'}; median frame interval ${percentile(intervals, 0.5).toFixed(2)} ms; phase ${recorded.phase}`);
  // Nothing was applied, so storage holds no preset; clear it anyway for the probe run below.
  await page.evaluate(() => localStorage.clear());
}

function analyzeSwap(records, oldCapacity, newCapacity) {
  const installIndex = records.findIndex((entry) => entry.capacity === newCapacity);
  const applyIndex = records.findIndex((entry) => entry.applying);
  if (installIndex < 0 || applyIndex < 0) return { failure: `no install (${installIndex}) or apply (${applyIndex}) in ${records.length} records` };
  const windowEnd = Math.min(records.length, installIndex + FRAMES_AFTER_STEP + 1);
  let longestFrame = 0;
  for (let index = applyIndex + 1; index < windowEnd; index += 1) longestFrame = Math.max(longestFrame, records[index].time - records[index - 1].time);
  // The longest stretch between two frames that saw the simulation step.
  let frozen = 0;
  let lastStepTime = records[applyIndex].time;
  for (let index = applyIndex + 1; index < windowEnd; index += 1) {
    if (records[index].sequence !== records[index - 1].sequence) {
      frozen = Math.max(frozen, records[index].time - lastStepTime);
      lastStepTime = records[index].time;
    }
  }
  const following = records.slice(installIndex, installIndex + FRAMES_AFTER_STEP);
  return {
    later: records[installIndex + FRAMES_AFTER_STEP],
    prepareMilliseconds: records[installIndex].time - records[applyIndex].time,
    longestFrame,
    frozen,
    following,
    oldCapacity,
  };
}

function framesRender(following) {
  if (following.length < FRAMES_AFTER_STEP) return false;
  return following.every((entry, index) => entry.drew && (index === 0 || entry.frame > following[index - 1].frame));
}

async function waitSequence(page, sequence) {
  await page.waitForFunction((target) => window.__murmuration.game.simulation.frameSequence >= target, sequence, { timeout: CHECK_TIMEOUT_MILLISECONDS });
}

async function waitFrames(page, count) {
  const target = await page.evaluate((frames) => window.__murmuration.frame + frames, count);
  await page.waitForFunction((frame) => window.__murmuration.frame >= frame, target, { timeout: CHECK_TIMEOUT_MILLISECONDS });
}

async function run() {
  let server = null;
  let browser = null;
  try {
    server = await startServer();
    const launched = await launchWebGpuBrowser();
    browser = launched.browser;
    const { page } = launched;
    const lines = [];
    const failures = [];
    const expect = (ok, text) => { lines.push(`${ok ? 'PASS' : 'FAIL'} ${text}`); if (!ok) failures.push(text); };
    await measureCpuTimer(page, server.url, expect, lines);
    await page.goto(server.url);
    await page.waitForFunction(() => window.__murmuration?.ready === true, null, { timeout: CHECK_TIMEOUT_MILLISECONDS });

    const start = await page.evaluate(() => ({
      preset: window.__murmuration.quality.current,
      capacity: window.__murmuration.game.simulation.capacity,
      timestamps: window.__murmuration.game.frameTimer?.constructor.name,
    }));
    expect(start.preset === 'desktop' && start.capacity === 524288, `starts at ${start.preset} with capacity ${start.capacity} (need desktop, 524288), frame timer ${start.timestamps}`);
    await page.evaluate(installRecorder);
    await page.evaluate(installSwapProbe, SWAP_PROBE_LAYOUT);
    await clickToStart(page);
    await waitFrames(page, PLAY_FRAMES_BEFORE_STEP);
    const phase = await page.evaluate(() => window.__murmuration.stats?.phase);
    expect(phase === 'playing', `phase ${phase} before the step (need playing)`);
    await writeDataUrl('quality-desktop.png', (await page.evaluate(() => window.__murmuration.capture())).pngDataUrl);

    // Injected time far ahead of the page clock, so real frames cannot reach a decision meanwhile.
    const startSeconds = await page.evaluate(() => performance.now() / 1000 + 1000);
    const first = await page.evaluate(feedSlowFrames, { startSeconds, until: 'reduced' });
    expect(first.frames > 0 && first.particleCapacity === 65536 && first.bloom === 'medium', `first down after ${first.frames} slow frames: particles ${first.particleCapacity} (need 65536), bloom ${first.bloom} (need medium), preset still desktop`);
    let holdStart = null;
    if (HOLD_SPAWNS) {
      holdStart = await page.evaluate(holdSpawns);
      await waitSequence(page, holdStart + HOLD_STEPS);
    }
    const second = await page.evaluate(feedSlowFrames, { startSeconds: startSeconds + 10, until: 'applying' });
    expect(second.frames > 0, `second down after ${second.frames} slow frames starts applying phoneHigh`);
    await page.evaluate(() => window.__murmuration.quality.settled);
    await waitFrames(page, FRAMES_AFTER_STEP + 2);
    await page.waitForFunction(() => window.__swapProbe.A !== null && window.__swapProbe.pending.length >= 2, null, { timeout: CHECK_TIMEOUT_MILLISECONDS });
    let holdEnd = null;
    if (HOLD_SPAWNS) {
      await waitSequence(page, (await page.evaluate(() => window.__swapProbe.commitSequence)) + HOLD_STEPS);
      holdEnd = await page.evaluate(releaseSpawns);
    }
    const probe = await page.evaluate(async () => {
      const swapProbe = window.__swapProbe;
      await Promise.all(swapProbe.pending);
      return { O: swapProbe.O, N: swapProbe.N, A: swapProbe.A, ASequence: swapProbe.ASequence, commitSequence: swapProbe.commitSequence, requests: swapProbe.requests };
    });
    const applied = await page.evaluate(() => ({
      preset: window.__murmuration.quality.current,
      capacity: window.__murmuration.game.simulation.capacity,
      particles: window.__murmuration.game.simulation.particlePool.capacity,
      bloom: window.__murmuration.game.renderer.bloomQuality,
      stored: JSON.parse(localStorage.getItem('murmuration.settings.v1') ?? 'null'),
    }));
    expect(applied.preset === 'phoneHigh' && applied.capacity === 131072 && applied.particles === 65536 && applied.bloom === 'medium',
      `applied ${applied.preset}: capacity ${applied.capacity}, particles ${applied.particles}, bloom ${applied.bloom} (need phoneHigh 131072 65536 medium)`);
    expect(applied.stored?.preset === 'phoneHigh' && typeof applied.stored?.adapterKey === 'string', `persisted preset ${applied.stored?.preset} with adapter key "${applied.stored?.adapterKey}"`);

    const records = await page.evaluate(() => window.__qualityRecords);
    const swap = analyzeSwap(records, 524288, 131072);
    if (swap.failure) {
      expect(false, swap.failure);
    } else {
      const carriedReference = Math.min(probe.O, 131072);
      const carryError = probe.N / carriedReference - 1;
      expect(Math.abs(carryError) <= CARRY_TOLERANCE, `carried ${probe.N} alive agents into the new simulation at install from ${probe.O} queued before the commit (${(carryError * 100).toFixed(3)}% off min(O, 131072) = ${carriedReference}, need within ${CARRY_TOLERANCE * 100}%)`);
      const appeared = probe.A / probe.N - 1;
      if (HOLD_SPAWNS) {
        const heldRequests = probe.requests.filter((entry) => entry.sequence > holdStart && entry.sequence <= holdEnd);
        const heldTotal = heldRequests.reduce((sum, entry) => sum + entry.total, 0);
        expect(heldRequests.length >= 2 * HOLD_STEPS && heldTotal === 0, `spawning held from sequence ${holdStart} to ${holdEnd} around the commit at ${probe.commitSequence}: ${heldRequests.length} requests totalling ${heldTotal} (need at least ${2 * HOLD_STEPS}, totalling 0)`);
        expect(appeared <= HELD_APPEAR_TOLERANCE, `with spawning held, the first stats frame after the install (sequence ${probe.ASequence}) counts ${probe.A} alive against ${probe.N} carried (${(appeared * 100).toFixed(3)}%, need at most ${HELD_APPEAR_TOLERANCE * 100}% more)`);
      } else {
        expect(swap.later !== undefined && swap.later.alive < TARGET_BOUND * swap.later.target, `alive ${swap.later?.alive} ${FRAMES_AFTER_STEP} frames after the install against the alive target ${swap.later?.target?.toFixed(0)} (need under ${TARGET_BOUND} times)`);
      }
      lines.push(`MEASURED carry: O ${probe.O}, N ${probe.N}, A ${probe.A} (A/N - 1 = ${(appeared * 100).toFixed(3)}%, commit sequence ${probe.commitSequence}, first stats ${probe.ASequence})`);
      expect(framesRender(swap.following), `the ${FRAMES_AFTER_STEP} frames after the install all rendered: frames ${swap.following.map((entry) => entry.frame).join(',')}, drew ${swap.following.map((entry) => (entry.drew ? 1 : 0)).join('')}`);
      lines.push(`MEASURED prepare (apply start to install) ${swap.prepareMilliseconds.toFixed(1)} ms with play running, longest frame from apply start to ${FRAMES_AFTER_STEP} frames after install ${swap.longestFrame.toFixed(1)} ms, longest time without a simulation step ${swap.frozen.toFixed(1)} ms`);
    }

    // phoneLow: half simulation rate with interpolated glyphs.
    const recordCount = await page.evaluate(() => window.__qualityRecords.length);
    await page.evaluate(() => window.__murmuration.quality.apply('phoneLow'));
    await waitFrames(page, FRAMES_AFTER_STEP + 2);
    const low = await page.evaluate((from) => ({
      rate: window.__murmuration.game.simulationRate,
      capacity: window.__murmuration.game.simulation.capacity,
      records: window.__qualityRecords.slice(from),
    }), recordCount);
    const lowInstall = low.records.findIndex((entry) => entry.capacity === 65536);
    const lowFollowing = lowInstall < 0 ? [] : low.records.slice(lowInstall, lowInstall + FRAMES_AFTER_STEP);
    const steps = lowFollowing.length > 1 ? lowFollowing.at(-1).sequence - lowFollowing[0].sequence : 0;
    expect(low.rate === 'half' && low.capacity === 65536 && framesRender(lowFollowing), `phoneLow: rate ${low.rate}, capacity ${low.capacity}, next ${FRAMES_AFTER_STEP} frames rendered ${framesRender(lowFollowing)}, ${steps} simulation steps over ${lowFollowing.length - 1} frames`);
    await writeDataUrl('quality-phoneLow.png', (await page.evaluate(() => window.__murmuration.capture())).pngDataUrl);

    const lost = await page.evaluate(() => window.__qualityLost);
    expect(lost === null, `device lost: ${lost ?? 'no'}`);
    expect(page.consoleErrors.length === 0, `console errors: ${page.consoleErrors.length}${page.consoleErrors.length ? ' ' + page.consoleErrors.join(' | ') : ''}`);
    lines.forEach((line) => console.log(`quality: ${line}`));
    if (failures.length > 0) {
      console.error(`quality: FAIL (${failures.length})`);
      return EXIT_FAILURE;
    }
    console.log('quality: ok');
    return EXIT_OK;
  } catch (error) {
    console.error(`quality: ${error.message}`);
    return EXIT_FAILURE;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.stop();
  }
}

process.exitCode = await run();
