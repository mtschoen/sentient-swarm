import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { STEP, createGame } from '../game/game-harness.js';
import { createOnlineWiring } from '../../src/ui/online-wiring.js';
import { createModeControl } from '../../src/ui/mode-choice.js';

// With no online session, no networking code runs: only the online wiring and the panel import
// src/net/, the game reaches it only through game.online in four fixed files, and a whole run in
// every mode leaves game.online null, every seat local and the wiring without a connection.

const SOURCE_DIRECTORY = new URL('../../src/', import.meta.url);

function sourceFiles(directory = SOURCE_DIRECTORY, prefix = 'src/') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`);
    return entry.name.endsWith('.js') ? [{ path: `${prefix}${entry.name}`, url: new URL(entry.name, directory) }] : [];
  });
}

const filesWith = (needle) => sourceFiles().filter(({ url }) => readFileSync(url, 'utf8').includes(needle)).map(({ path }) => path).sort();

test('only the online wiring and the panels import the networking directory', () => {
  const importers = [...new Set([...filesWith("from '../net/"), ...filesWith("from './net/")])].filter((path) => !path.startsWith('src/net/')).sort();
  assert.deepEqual(importers, ['src/ui/online-panel.js', 'src/ui/online-wiring.js']);
});

test('the game reaches the networking only through game.online', () => {
  assert.deepEqual(filesWith('.online').filter((path) => path.startsWith('src/game/')),
    ['src/game/bomb-step.js', 'src/game/game.js', 'src/game/seats.js', 'src/game/versus-seats.js']);
});

// The smallest document the panel, the connected title line and the countdown build into.
function createFakeDocument() {
  const make = (tagName) => {
    const classes = new Set();
    return {
      tagName: tagName.toUpperCase(), textContent: '', value: '', className: '', children: [], hidden: false, attributes: {}, style: {},
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...nodes) { this.children.push(...nodes); },
      addEventListener() {},
    };
  };
  return { createElement: make, body: make('body') };
}

function createCountingWiring(game) {
  const counts = { connections: 0, sessions: 0, timers: 0 };
  const documentObject = createFakeDocument();
  const menu = { element: documentObject.createElement('div'), setItem() {}, show() {}, hide() {} };
  const modeControl = createModeControl();
  modeControl.attach(menu);
  const exposed = {};
  const wiring = createOnlineWiring({
    game,
    menu,
    pauseMenu: { show() {}, hide() {}, setNote() {} },
    hud: { showToast() {} },
    modeControl,
    coopJoin: { reset() {} },
    input: { seatOnePadIndex: () => 0 },
    audio: { setPaused() {}, restartRun() {}, unlock() {} },
    documentObject,
    clipboard: { async writeText() {}, async readText() { return ''; } },
    locationObject: { href: 'https://example.test/', pathname: '/', search: '', hash: '' },
    historyObject: { replaceState() {} },
    exposeTo: exposed,
    now: () => 0,
    setTimer: () => { counts.timers += 1; return counts.timers; },
    clearTimer() {},
    createConnection: () => { counts.connections += 1; throw new Error('no connection may be made without a session'); },
    createSession: () => { counts.sessions += 1; throw new Error('no session may be made'); },
  });
  return { wiring, counts, exposed };
}

for (const mode of ['solo', 'coop', 'versus', 'hives']) {
  test(`${mode} runs 600 updates with no session and no connection`, async () => {
    const { game, simulation, projectiles } = await createGame();
    simulation.setVersusProjectiles = () => {};
    projectiles.buffer = { label: 'projectiles' };
    const { wiring, counts, exposed } = createCountingWiring(game);
    if (mode !== 'solo') game.setPlayerCount(2);
    if (mode === 'versus' || mode === 'hives') game.setMode(mode);
    wiring.update({ titleOpen: true, warmUpDone: true });
    assert.equal(wiring.handleStart(), false, 'Play starts the couch run');
    game.start();
    for (let index = 0; index < 600; index += 1) {
      game.update(STEP);
      wiring.update({ titleOpen: false, warmUpDone: true });
      assert.equal(game.online, null);
      assert.ok(game.seats.every((seat) => seat.remote === false), 'every seat is local');
      assert.equal(wiring.remoteSeats().size, 0);
    }
    assert.equal(game.state.phase, 'playing');
    assert.equal(game.mode, mode === 'solo' ? 'coop' : mode);
    assert.equal(game.seats.length, mode === 'solo' ? 1 : 2);
    assert.equal(wiring.handlePause(), false);
    assert.equal(wiring.handleResume(), false);
    assert.equal(wiring.handleRestart(), false);
    assert.equal(wiring.handleQuit(), false);
    assert.equal(wiring.handlePadDisconnected(0), false);
    assert.equal(wiring.active, false);
    assert.equal(exposed.online.session, null);
    assert.equal(exposed.online.phase, null);
    assert.deepEqual(counts, { connections: 0, sessions: 0, timers: 0 });
  });
}
