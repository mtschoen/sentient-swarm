// Online browser check (not part of check:gpu): two pages in two contexts of one headless Chromium
// (local addresses not hidden behind mDNS, so the two peers reach each other over the loopback)
// play one online hives match over a real WebRTC connection, each step asserted on both pages:
//   1. the host chooses ONLINE and gets an invite link; the guest opens it, the Join panel shows and
//      the guest copies its reply and its panel reads that it waits for the host; after
//      --paste-delay seconds (0 by default) the host types the reply into the box and presses Enter. Both
//      titles show the connected line (the host's with the round trip in MS) and the guest's Play
//      reads WAITING FOR THE HOST TO START.
//   2. the host's mode item reads MODE: HIVES (the online default) and the host's Play starts the
//      match: both pages reach playing in hives within 1 s of each other.
//   3. both seats invulnerable and the neutral swarm cleared before every update on both pages, the
//      host's ships are held on the center hive (as hives.mjs does) until both pages show it owned by
//      seat 1 (artifacts/online-captured-host.png and online-captured-guest.png).
//   4. every hive handed to seat 1 on the host and its hold wound to the last 2 s: both game over
//      titles read PLAYER 1 WINS in seat 1's color (artifacts/online-winner-host.png, -guest.png).
//   5. the guest's Play again restarts both in hives with neutral hives.
//   6. the guest's Escape shows the host's pause menu with PLAYER 2 PAUSED; the host's Resume shows
//      the countdown 3 on both, then both play again.
//   7. closing the guest page pauses the host with CONNECTION LOST (once its connection reports the
//      silent peer disconnected, about 5 s here) and CONNECTION_LOST_SECONDS later returns it to a
//      co-op title with the connection lost toast.
// No console errors on either page. The pages are muted and get no audio gesture that matters.
// Usage: SMOKE_PORT=5198 node tests/browser/online.mjs [--paste-delay 15]
// Exit codes: 0 ok, 1 failure, 2 no WebGPU adapter.
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchWebGpuBrowser, watchPage } from './launch.mjs';
import { startServer } from './server.mjs';
import { CONNECTION_LOST_SECONDS } from '../../src/net/protocol.js';

const ARTIFACTS_DIRECTORY = new URL('../../artifacts/', import.meta.url);
const VIEWPORT = { width: 1280, height: 720 };
const TIMEOUT_MILLISECONDS = 120_000;
const EXIT_NO_ADAPTER = 2;
const CONNECT_MILLISECONDS = 20_000;
const START_SKEW_MILLISECONDS = 1000;
const CAPTURE_MILLISECONDS = 30_000;
const GAME_OVER_MILLISECONDS = 15_000;
// Chrome's ICE consent checks report a silent peer disconnected after about 5 s.
const DISCONNECT_DETECTION_SECONDS = 8;
const LOST_MARGIN_SECONDS = 1;
const SEAT_ONE_COLOR = 'rgb(255, 255, 255)';
const CENTER_HIVE = 2;
const WEBRTC_ARGUMENTS = ['--disable-features=WebRtcHideLocalIpsWithMdns'];
// A slow human host: the guest must still be waiting, with no network message, when the reply is pasted.
const PASTE_DELAY_INDEX = process.argv.indexOf('--paste-delay');
const PASTE_DELAY_SECONDS = PASTE_DELAY_INDEX < 0 ? 0 : Number(process.argv[PASTE_DELAY_INDEX + 1]);
const GUEST_WAITING = 'Waiting for your friend to paste your reply.';

// Runs in every page: logs each change of the run phase, the countdown numeral, the pause note and
// the title's visibility with the page's absolute time and frame, so both pages can be compared.
function installRecorder() {
  window.__changes = [];
  const last = {};
  const read = () => {
    const countdown = document.querySelector('.resume-countdown');
    const note = document.querySelector('.menu-pause .menu-note');
    const title = document.querySelector('.menu-title-screen');
    return {
      phase: window.__murmuration?.game?.state.phase ?? null,
      countdown: countdown && !countdown.classList.contains('resume-countdown-hidden') ? countdown.textContent : null,
      note: note && !note.classList.contains('menu-note-hidden') && !note.closest('.menu-pause').hidden ? note.textContent : null,
      title: title ? !title.hidden && getComputedStyle(title).display !== 'none' : null,
    };
  };
  const tick = () => {
    requestAnimationFrame(tick);
    let now;
    try {
      now = read();
    } catch (error) {
      now = { error: error.message };
    }
    for (const [key, value] of Object.entries(now)) {
      if (last[key] !== value) {
        last[key] = value;
        window.__changes.push({ key, value, at: performance.timeOrigin + performance.now(), frame: window.__murmuration?.frame ?? 0 });
      }
    }
  };
  requestAnimationFrame(tick);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function openPage(context, url) {
  const page = await context.newPage();
  await watchPage(page);
  await page.addInitScript(installRecorder);
  await page.goto(url);
  await page.waitForFunction(() => window.__murmuration?.ready === true && window.__murmuration.stats != null, null, { timeout: TIMEOUT_MILLISECONDS });
  return page;
}

const newContext = (browser) => browser.newContext({ viewport: VIEWPORT, permissions: ['clipboard-read', 'clipboard-write'] });
const phaseOf = (page) => page.evaluate(() => window.__murmuration.game.state.phase);
const changesOf = (page, key) => page.evaluate((name) => window.__changes.filter((change) => change.key === name), key);
const waitUntil = (page, predicate, argument, timeout) => page.waitForFunction(predicate, argument, { timeout, polling: 50 });
const titleItem = (page, text) => page.locator('.menu-title-screen .menu-item', { hasText: text });
const playItem = (page) => page.locator('.menu-title-screen .menu-primary');
const onlineStatus = (page) => page.evaluate(() => {
  const status = document.querySelector('.online-status');
  return { text: status.textContent, visible: getComputedStyle(status).visibility === 'visible' };
});
const screenshot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(name, ARTIFACTS_DIRECTORY)) });

// The first change of key to value at or after the given absolute time, on one page.
async function firstChange(page, key, value, after = 0) {
  return (await changesOf(page, key)).find((change) => change.value === value && change.at >= after) ?? null;
}

// Step 1: invite, reply, connected titles.
async function connect(host, guestContext) {
  await titleItem(host, /^ONLINE$/).click();
  await waitUntil(host, () => window.__murmuration.online.inviteUrl !== null, null, CONNECT_MILLISECONDS);
  const inviteUrl = await host.evaluate(() => window.__murmuration.online.inviteUrl);
  expect(inviteUrl.includes('#join='), `1: the invite is ${inviteUrl}`);
  expect(await host.locator('.online-panel').isVisible(), '1: the host panel is not showing');

  const guest = await openPage(guestContext, inviteUrl);
  await waitUntil(guest, () => window.__murmuration.online.replyText !== null, null, CONNECT_MILLISECONDS);
  expect(await guest.locator('.online-panel').isVisible(), '1: the Join panel is not showing');
  const panelStatus = await guest.locator('.online-panel-status').textContent();
  expect(panelStatus === 'Send your reply back to your friend.', `1: the Join panel reads "${panelStatus}"`);
  expect(await guest.evaluate(() => location.hash) === '', '1: the guest address bar still holds the invite');
  await guest.locator('.online-panel-button', { hasText: 'Copy reply' }).click();
  const replyText = await guest.evaluate(() => window.__murmuration.online.replyText);
  await waitUntil(guest, (text) => document.querySelector('.online-panel-status').textContent === text, GUEST_WAITING, CONNECT_MILLISECONDS);
  if (PASTE_DELAY_SECONDS > 0) {
    await new Promise((resolve) => setTimeout(resolve, PASTE_DELAY_SECONDS * 1000));
    const waiting = await guest.evaluate(() => ({ status: document.querySelector('.online-panel-status').textContent, message: document.querySelector('.online-panel-message').textContent }));
    expect(waiting.status === GUEST_WAITING && waiting.message === '', `1: after ${PASTE_DELAY_SECONDS} s the guest panel reads ${JSON.stringify(waiting)}`);
    console.log(`online 1: the guest still waits with no message after a ${PASTE_DELAY_SECONDS} s paste delay`);
  }

  const box = host.locator('.online-panel-box');
  await box.fill(replyText);
  await box.press('Enter');
  await waitUntil(host, () => /^PLAYER 2 CONNECTED ONLINE \(\d+ MS\)$/.test(document.querySelector('.online-status').textContent), null, CONNECT_MILLISECONDS);
  await waitUntil(guest, () => /^CONNECTED TO PLAYER 1 ONLINE/.test(document.querySelector('.online-status').textContent), null, CONNECT_MILLISECONDS);
  await waitUntil(guest, () => document.querySelector('.menu-title-screen .menu-primary').textContent === 'WAITING FOR THE HOST TO START', null, CONNECT_MILLISECONDS);
  const hostStatus = await onlineStatus(host);
  const guestStatus = await onlineStatus(guest);
  expect(hostStatus.visible && guestStatus.visible, `1: status lines ${JSON.stringify({ hostStatus, guestStatus })}`);
  expect(!(await host.locator('.online-panel').isVisible()) && !(await guest.locator('.online-panel').isVisible()), '1: a panel is still showing');
  expect(await titleItem(host, /^DISCONNECT$/).count() === 1 && await titleItem(guest, /^DISCONNECT$/).count() === 1, '1: the ONLINE item does not read DISCONNECT');
  console.log(`online 1: connected; host "${hostStatus.text}", guest "${guestStatus.text}"`);
  return guest;
}

// Both seats invulnerable and the neutral swarm cleared every update; on the host, seat 1's ships
// are held on window.__parkHive while it is set (as hives.mjs).
async function quietMatch(page) {
  await page.evaluate(() => {
    const { game } = window.__murmuration;
    game.debugInvulnerable(true);
    window.__parkHive = null;
    const update = game.update.bind(game);
    game.update = (deltaSeconds) => {
      if (game.run.phase === 'playing') game.simulation.requestKillAll();
      const hive = window.__parkHive === null ? null : game.versusMatch?.hives?.hives[window.__parkHive];
      if (hive) game.seats[game.localSeatIndex].swarm.slots.forEach((slot) => { if (slot.alive) { slot.x = hive.x; slot.y = hive.y; } });
      update(deltaSeconds);
    };
  });
}

const runOf = (page) => page.evaluate(() => {
  const { game } = window.__murmuration;
  return { phase: game.state.phase, mode: game.mode, result: game.state.matchResult, owners: game.state.hives?.hives.map((hive) => hive.owner) ?? null };
});

// Step 2: the host starts hives; both pages play within 1 s of each other.
async function start(host, guest) {
  const item = await host.locator('.menu-title-screen .menu-mode').textContent();
  expect(item === 'MODE: HIVES', `2: the host mode item reads "${item}"`);
  const before = await host.evaluate(() => performance.timeOrigin + performance.now());
  await playItem(host).click();
  for (const page of [host, guest]) await waitUntil(page, () => window.__murmuration.game.state.phase === 'playing', null, CONNECT_MILLISECONDS);
  const hostPlaying = await firstChange(host, 'phase', 'playing', before);
  const guestPlaying = await firstChange(guest, 'phase', 'playing', before);
  const skew = Math.abs(hostPlaying.at - guestPlaying.at);
  console.log(`online 2: playing on the host at frame ${hostPlaying.frame}, on the guest at frame ${guestPlaying.frame}, ${skew.toFixed(0)} ms apart`);
  expect(skew <= START_SKEW_MILLISECONDS, `2: the pages started ${skew.toFixed(0)} ms apart`);
  for (const page of [host, guest]) {
    const run = await runOf(page);
    expect(run.mode === 'hives' && run.owners?.every((owner) => owner === null), `2: run ${JSON.stringify(run)}`);
    expect(!(await page.locator('.menu-title-screen').isVisible()), '2: the title still shows');
  }
  for (const page of [host, guest]) await quietMatch(page);
}

// Step 3: the host's ships on the center hive until both pages show it owned by seat 1.
async function capture(host, guest) {
  await host.evaluate((index) => { window.__parkHive = index; }, CENTER_HIVE);
  for (const page of [host, guest]) await waitUntil(page, (index) => window.__murmuration.game.state.hives?.hives[index].owner === 0, CENTER_HIVE, CAPTURE_MILLISECONDS);
  await host.evaluate(() => { window.__parkHive = null; });
  for (const page of [host, guest]) {
    const owners = (await runOf(page)).owners;
    expect(owners[0] === null && owners[1] === null, `3: the other hives changed: ${JSON.stringify(owners)}`);
  }
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  await screenshot(host, 'online-captured-host.png');
  await screenshot(guest, 'online-captured-guest.png');
  console.log('online 3: the center hive is seat 1\'s on both pages');
}

// Step 4: every hive to seat 1 on the host, the hold wound to its last 2 s: PLAYER 1 WINS on both.
async function holdWin(host, guest) {
  await host.evaluate(() => window.__murmuration.game.versusMatch.hives.hives.forEach((hive) => { hive.owner = 0; }));
  await waitUntil(host, () => window.__murmuration.game.versusMatch.hives.hold.holder === 0, null, GAME_OVER_MILLISECONDS);
  await host.evaluate(() => {
    const { hold } = window.__murmuration.game.versusMatch.hives;
    hold.seconds = hold.holdSecondsToWin - 2;
  });
  for (const page of [host, guest]) await waitUntil(page, () => window.__murmuration.game.state.phase === 'gameOver', null, GAME_OVER_MILLISECONDS);
  for (const [name, page] of [['host', host], ['guest', guest]]) {
    await waitUntil(page, () => document.querySelector('.hud-gameover-title')?.textContent === 'PLAYER 1 WINS', null, GAME_OVER_MILLISECONDS);
    const banner = await page.evaluate(() => {
      const title = document.querySelector('.hud-gameover-title');
      return { text: title.textContent, color: getComputedStyle(title).color, result: window.__murmuration.game.state.matchResult };
    });
    expect(banner.text === 'PLAYER 1 WINS' && banner.color === SEAT_ONE_COLOR && banner.result?.winner === 0, `4 ${name}: game over ${JSON.stringify(banner)}`);
    await screenshot(page, `online-winner-${name}.png`);
  }
  console.log('online 4: PLAYER 1 WINS on both pages');
}

// Step 5: the guest's Play again restarts both in hives from neutral.
async function restart(host, guest) {
  await guest.locator('.hud-play-again').click();
  for (const page of [host, guest]) {
    await waitUntil(page, () => {
      const { state, mode } = window.__murmuration.game;
      return state.phase === 'playing' && mode === 'hives' && state.matchResult === null && state.hives?.hives.every((hive) => hive.owner === null);
    }, null, CONNECT_MILLISECONDS);
  }
  console.log('online 5: the guest\'s Play again restarted both in hives from neutral');
}

// Step 6: the guest pauses both; the host's Resume counts 3 on both, then both play.
async function pauseAndResume(host, guest) {
  await guest.keyboard.press('Escape');
  await waitUntil(host, () => document.querySelector('.menu-pause .menu-note')?.textContent === 'PLAYER 2 PAUSED'
    && !document.querySelector('.menu-pause .menu-note').classList.contains('menu-note-hidden'), null, CONNECT_MILLISECONDS);
  expect(await host.locator('.menu-pause').isVisible(), '6: the host pause menu is not showing');
  for (const page of [host, guest]) await waitUntil(page, () => window.__murmuration.game.state.phase === 'paused', null, CONNECT_MILLISECONDS);
  const resumedAt = await host.evaluate(() => performance.timeOrigin + performance.now());
  await host.locator('.menu-pause .menu-item', { hasText: 'Resume' }).click();
  for (const page of [host, guest]) await waitUntil(page, (after) => window.__changes.some((change) => change.key === 'phase' && change.value === 'playing' && change.at >= after), resumedAt, CONNECT_MILLISECONDS);
  for (const [name, page] of [['host', host], ['guest', guest]]) {
    const three = await firstChange(page, 'countdown', '3', resumedAt);
    const playing = await firstChange(page, 'phase', 'playing', resumedAt);
    expect(three !== null && three.at <= playing.at, `6 ${name}: no 3 before play resumed (${JSON.stringify({ three, playing })})`);
  }
  console.log('online 6: PLAYER 2 PAUSED on the host, 3 on both, both playing again');
}

// Step 7: the guest page closes. A closed headless Chromium tab does not close its data channels
// on the other side: the host's connection reports disconnected after Chrome's consent checks give
// up (about 5 s), so the host pauses with CONNECTION LOST, waits CONNECTION_LOST_SECONDS for it to
// recover (spec: Connection lost) and then returns to a co-op title with the message toast.
async function loseGuest(host, guest) {
  const closedAt = await host.evaluate(() => performance.timeOrigin + performance.now());
  await guest.close();
  await waitUntil(host, () => window.__changes.some((change) => change.key === 'note' && change.value === 'CONNECTION LOST'), null, DISCONNECT_DETECTION_SECONDS * 1000);
  await waitUntil(host, () => window.__murmuration.game.state.phase === 'ready' && window.__murmuration.game.mode === 'coop'
    && window.__murmuration.online.session === null, null, (CONNECTION_LOST_SECONDS + LOST_MARGIN_SECONDS) * 1000);
  const lost = await firstChange(host, 'note', 'CONNECTION LOST', closedAt);
  const title = await firstChange(host, 'title', true, lost.at);
  const lostSeconds = (lost.at - closedAt) / 1000;
  const titleSeconds = title === null ? null : (title.at - lost.at) / 1000;
  console.log(`online 7: CONNECTION LOST ${lostSeconds.toFixed(1)} s after the guest closed, the co-op title ${titleSeconds?.toFixed(1)} s later (${((title?.at - closedAt) / 1000).toFixed(1)} s in all)`);
  expect(title !== null && titleSeconds <= CONNECTION_LOST_SECONDS + LOST_MARGIN_SECONDS, `7: the host reached the title ${titleSeconds} s after CONNECTION LOST`);
  expect(await host.locator('.menu-title-screen').isVisible(), '7: the host title is not showing');
  const seats = await host.evaluate(() => window.__murmuration.game.seats.length);
  expect(seats === 1, `7: the host title has ${seats} seats`);
  const toast = await host.locator('.hud-toast').textContent();
  expect(toast === 'Connection lost. The match has ended.', `7: the host toast reads "${toast}"`);
}

async function run() {
  const server = await startServer();
  let browser = null;
  let failure = null;
  let noAdapter = false;
  const pages = [];
  try {
    const launched = await launchWebGpuBrowser({ extraArguments: WEBRTC_ARGUMENTS });
    browser = launched.browser;
    // navigator.gpu exists on a served page, not on about:blank.
    await launched.page.goto(server.url);
    noAdapter = !(await launched.page.evaluate(async () => Boolean(navigator.gpu && (await navigator.gpu.requestAdapter()))));
    await launched.page.close();
    if (!noAdapter) {
      const url = new URL(server.url);
      url.searchParams.set('probe', 'off');
      url.searchParams.set('capacity', '262144');
      const host = await openPage(await newContext(browser), url.href);
      pages.push(['host', host]);
      const guest = await connect(host, await newContext(browser));
      pages.push(['guest', guest]);
      await start(host, guest);
      await capture(host, guest);
      await holdWin(host, guest);
      await restart(host, guest);
      await pauseAndResume(host, guest);
      await loseGuest(host, guest);
      for (const [name, page] of pages) expect(page.consoleErrors.length === 0, `${name} console errors: ${page.consoleErrors.join(' | ')}`);
    }
  } catch (error) {
    failure = error;
    for (const [name, page] of pages) if (!page.isClosed()) console.error(`${name} state: ${JSON.stringify(await page.evaluate(() => ({ online: { phase: window.__murmuration.online.phase, session: window.__murmuration.online.session !== null }, changes: window.__changes.slice(-12) })))}`);
    for (const [name, page] of pages) if (page.consoleErrors.length > 0) console.error(`${name} console errors: ${page.consoleErrors.join(' | ')}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.stop();
  }
  if (noAdapter) {
    console.error('online: no WebGPU adapter, the check did not run');
    process.exit(EXIT_NO_ADAPTER);
  }
  if (failure) {
    console.error(failure.message);
    process.exit(1);
  }
  console.log('online: ok');
}

await run();
