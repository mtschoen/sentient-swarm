import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnlineWiring } from '../../src/ui/online-wiring.js';
import { createModeControl } from '../../src/ui/mode-choice.js';
import { encodeSignal } from '../../src/net/signal-codec.js';
import { SAMPLE_SDP } from '../net/net-fixtures.js';

const STEP = 1 / 60;

function createFakeDocument() {
  const make = (tagName) => {
    const classes = new Set();
    const listeners = {};
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
      addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
      fire(type, event = {}) {
        return Promise.all((listeners[type] ?? []).map((listener) => listener({ stopPropagation() {}, preventDefault() {}, ...event })));
      },
    };
  };
  return { createElement: make, body: make('body') };
}

function allNodes(node) {
  return [node].concat((node.children ?? []).flatMap(allNodes));
}

// Waits until condition holds: the signal codec's CompressionStream runs on Node's thread pool, so
// a fixed number of turns is not enough under load. The cap only keeps a broken test from hanging.
const MAXIMUM_SETTLE_TURNS = 5000;
async function settleUntil(condition, label) {
  for (let turn = 0; turn < MAXIMUM_SETTLE_TURNS && !condition(); turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, turn < 20 ? 0 : 1));
  }
  assert.ok(condition(), `settled: ${label}`);
}

const panelStatus = (online) => allNodes(online.panel.element).find((node) => node.className === 'online-panel-status').textContent;

function createTimers() {
  let seconds = 0;
  let nextHandle = 1;
  const pending = new Map();
  return {
    now: () => seconds,
    setTimer(callback, delaySeconds) {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, { due: seconds + delaySeconds, callback });
      return handle;
    },
    clearTimer(handle) { pending.delete(handle); },
    advanceTo(target) {
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.due <= target).sort((first, second) => first[1].due - second[1].due)[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        seconds = due[1].due;
        due[1].callback();
      }
      seconds = target;
    },
  };
}

function countingConnectionFactory() {
  const factory = {
    count: 0,
    connections: [],
    create() {
      factory.count += 1;
      const connection = {
        closed: false,
        answers: [],
        transport: { state: 'connecting', send() {}, onMessage() {}, onStateChange() {}, close() {} },
        createOffer: async () => SAMPLE_SDP,
        acceptOffer: async () => SAMPLE_SDP,
        acceptAnswer: async (sdp) => { connection.answers.push(sdp); },
        close() { connection.closed = true; },
      };
      factory.connections.push(connection);
      return connection;
    },
  };
  return factory;
}

function createFakeSession(options) {
  const session = {
    options,
    role: options.role,
    calls: { pause: 0, resume: 0, restart: 0, quit: 0, start: [], markReady: 0, titleModes: [] },
    waitingFor: null,
    roundTripMilliseconds: 24,
    pause() { session.calls.pause += 1; return true; },
    resume() { session.calls.resume += 1; },
    restart() { session.calls.restart += 1; },
    quit() { session.calls.quit += 1; },
    start(mode) { session.calls.start.push(mode); return true; },
    markReady() { session.calls.markReady += 1; },
    setTitleMode(mode) { session.calls.titleModes.push(mode); },
    dispose() {},
    act(action) { options.onAction(action); },
  };
  return session;
}

function createFakes({ runPhase = 'ready', padIndex = 0 } = {}) {
  const documentObject = createFakeDocument();
  const timers = createTimers();
  const toasts = [];
  const items = new Map();
  const menu = {
    element: documentObject.createElement('div'),
    visible: true,
    setItem(id, view) { items.set(id, view); },
    show() { this.visible = true; },
    hide() { this.visible = false; },
  };
  const pauseMenu = {
    visible: false,
    note: '',
    show() { this.visible = true; },
    hide() { this.visible = false; },
    setNote(text) { this.note = text; },
  };
  const modeControl = createModeControl();
  modeControl.attach(menu);
  const sessions = [];
  const historyObject = { calls: [], replaceState(...parameters) { this.calls.push(parameters); } };
  const clipboard = { written: [], async writeText(text) { this.written.push(text); }, async readText() { return ''; } };
  const game = { run: { phase: runPhase }, immuneCalls: [], setNeutralImmuneSeats(seats) { this.immuneCalls.push(seats); } };
  const fakes = {
    game,
    menu,
    pauseMenu,
    hud: { showToast: (text) => toasts.push(text) },
    modeControl,
    coopJoin: { resets: 0, reset() { this.resets += 1; } },
    input: { seatOnePadIndex: () => padIndex },
    audio: { paused: [], restarts: 0, setPaused(on) { this.paused.push(on); }, restartRun() { this.restarts += 1; } },
    documentObject,
    clipboard,
    locationObject: { href: 'https://example.test/game/', pathname: '/game/', search: '', hash: '' },
    historyObject,
    createSession: (options) => {
      const session = createFakeSession(options);
      sessions.push(session);
      return session;
    },
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  };
  return { fakes, timers, toasts, items, sessions, historyObject, clipboard };
}

// The host's connection opened (its session reports the open transport).
function connectHost(online, sessions) {
  online.toggleOnline();
  sessions.at(-1).act({ type: 'connection', state: 'open' });
  return sessions.at(-1);
}

test('creating the wiring and showing the title builds no connection', () => {
  const factory = countingConnectionFactory();
  const { fakes } = createFakes();
  const online = createOnlineWiring({ ...fakes, createConnection: factory.create });
  for (let frame = 0; frame < 60; frame += 1) online.update({ titleOpen: true, warmUpDone: true, deltaSeconds: STEP });
  assert.equal(factory.count, 0);
  assert.equal(online.active, false);
  online.toggleOnline();
  assert.equal(factory.count, 1);
  assert.equal(online.panel.visible, true);
});

test('a join link that arrives mid-run waits for the title and leaves the address bar', async () => {
  const factory = countingConnectionFactory();
  const { fakes, historyObject } = createFakes({ runPhase: 'playing' });
  const online = createOnlineWiring({ ...fakes, createConnection: factory.create });
  online.openFromHash('#join=QQ');
  assert.equal(historyObject.calls.length, 1);
  assert.equal(historyObject.calls[0][2], '/game/');
  assert.equal(online.panel.visible, false);
  online.update({ titleOpen: false, warmUpDone: true, deltaSeconds: STEP });
  assert.equal(online.panel.visible, false);
  assert.equal(factory.count, 0);
  online.update({ titleOpen: true, warmUpDone: true, deltaSeconds: STEP });
  assert.equal(online.panel.visible, true);
  assert.equal(online.role, 'guest');
  assert.equal(factory.count, 1);
  await settleUntil(() => online.panel.messageText !== '', 'the broken invite message');
  assert.equal(online.panel.messageText, 'That invite link is broken. Ask your friend for a new one.');
});

test('a second join link during a session is ignored with a toast', () => {
  const factory = countingConnectionFactory();
  const { fakes, toasts, sessions } = createFakes();
  const online = createOnlineWiring({ ...fakes, createConnection: factory.create });
  connectHost(online, sessions);
  assert.equal(online.panel.visible, false);
  online.openFromHash('#join=RR');
  online.update({ titleOpen: true, warmUpDone: true, deltaSeconds: STEP });
  assert.equal(factory.count, 1);
  assert.equal(toasts.length, 1);
  assert.equal(online.panel.visible, false);
});

test('a pause while connected is taken by the session', () => {
  const factory = countingConnectionFactory();
  const { fakes, sessions } = createFakes({ runPhase: 'playing' });
  const online = createOnlineWiring({ ...fakes, createConnection: factory.create });
  assert.equal(online.handlePause(), false);
  const session = connectHost(online, sessions);
  assert.equal(online.handlePause(), true);
  assert.equal(session.calls.pause, 1);
  assert.deepEqual([...online.remoteSeats()], [1]);
});

test('the local pad dropping out pauses an online match, and a couch partner pad rule is untouched', () => {
  const factory = countingConnectionFactory();
  const { fakes, sessions } = createFakes({ runPhase: 'playing', padIndex: 2 });
  const online = createOnlineWiring({ ...fakes, createConnection: factory.create });
  online.update({ titleOpen: false, warmUpDone: true, deltaSeconds: STEP });
  assert.equal(online.handlePadDisconnected(2), false, 'without a session nothing happens');
  const session = connectHost(online, sessions);
  online.update({ titleOpen: false, warmUpDone: true, deltaSeconds: STEP });
  assert.equal(online.handlePadDisconnected(3), false, 'another pad is the couch rule\'s');
  assert.equal(session.calls.pause, 0);
  assert.equal(online.handlePadDisconnected(2), true);
  assert.equal(session.calls.pause, 1);
});

test('the guest connect timeout counts from Copy reply', async () => {
  const factory = countingConnectionFactory();
  const { fakes, timers } = createFakes();
  const online = createOnlineWiring({ ...fakes, createConnection: factory.create });
  const offer = await encodeSignal({ kind: 'offer', sdp: SAMPLE_SDP });
  online.openFromHash(`#join=${offer}`);
  online.update({ titleOpen: true, warmUpDone: true, deltaSeconds: STEP });
  await settleUntil(() => online.replyText !== null, 'the reply is ready to copy');
  assert.ok(online.replyText !== null, 'the reply is ready to copy');
  timers.advanceTo(30);
  assert.equal(online.panel.messageText, '', 'no timeout before Copy reply');
  const copyReply = allNodes(online.panel.element).find((node) => node.tagName === 'BUTTON' && node.textContent === 'Copy reply');
  await copyReply.fire('click');
  await settleUntil(() => fakes.clipboard.written.length === 1, 'the reply copied');
  timers.advanceTo(30 + 9.99);
  assert.equal(online.panel.messageText, '');
  timers.advanceTo(30 + 10);
  assert.equal(online.panel.messageText, 'Your two networks cannot connect directly.');
});

test('after a guest connect timeout the panel keeps the start until it is cancelled, and stays gone after', async () => {
  const factory = countingConnectionFactory();
  const { fakes, timers, items } = createFakes();
  const online = createOnlineWiring({ ...fakes, createConnection: factory.create });
  const offer = await encodeSignal({ kind: 'offer', sdp: SAMPLE_SDP });
  online.openFromHash(`#join=${offer}`);
  online.update({ titleOpen: true, warmUpDone: true, deltaSeconds: STEP });
  await settleUntil(() => online.replyText !== null, 'the reply is ready to copy');
  const copyReply = allNodes(online.panel.element).find((node) => node.tagName === 'BUTTON' && node.textContent === 'Copy reply');
  await copyReply.fire('click');
  await settleUntil(() => fakes.clipboard.written.length === 1, 'the reply copied');
  timers.advanceTo(10);
  assert.equal(online.panel.messageText, 'Your two networks cannot connect directly.');
  assert.equal(online.panel.visible, true);
  assert.equal(online.active, true, 'the panel still holds the title');
  assert.equal(online.handleStart(), true, 'Play under the panel starts no couch run');
  online.update({ titleOpen: true, warmUpDone: true, deltaSeconds: STEP });
  assert.equal(items.get('play').enabled, false);
  const cancel = allNodes(online.panel.element).find((node) => node.tagName === 'BUTTON' && node.textContent === 'Cancel');
  await cancel.fire('click');
  assert.equal(online.panel.visible, false);
  assert.equal(online.active, false);
  assert.equal(online.handleStart(), false);
  for (let frame = 0; frame < 3; frame += 1) online.update({ titleOpen: true, warmUpDone: true, deltaSeconds: STEP });
  assert.equal(online.panel.visible, false, 'a dismissed panel does not come back');
  assert.equal(factory.count, 1);
});

test('Play is ghosted while a connection is pending and enabled again once it is cancelled', () => {
  const factory = countingConnectionFactory();
  const { fakes, items } = createFakes();
  const online = createOnlineWiring({ ...fakes, createConnection: factory.create });
  online.update({ titleOpen: true, warmUpDone: true, deltaSeconds: STEP });
  assert.equal(items.get('play').enabled, true);
  online.toggleOnline();
  online.update({ titleOpen: true, warmUpDone: true, deltaSeconds: STEP });
  assert.deepEqual(items.get('play'), { label: 'Play', enabled: false });
  online.toggleOnline();
  online.update({ titleOpen: true, warmUpDone: true, deltaSeconds: STEP });
  assert.equal(items.get('play').enabled, true);
});

test('the host connect timeout counts from an accepted reply and returns a fresh invite', async () => {
  const factory = countingConnectionFactory();
  const { fakes, timers } = createFakes();
  const online = createOnlineWiring({ ...fakes, createConnection: factory.create });
  online.toggleOnline();
  await settleUntil(() => online.inviteUrl !== null, 'the invite');
  assert.ok(online.inviteUrl.startsWith('https://example.test/game/#join='));
  timers.advanceTo(20);
  const answer = await encodeSignal({ kind: 'answer', sdp: SAMPLE_SDP });
  const box = allNodes(online.panel.element).find((node) => node.tagName === 'TEXTAREA');
  box.value = answer;
  await box.fire('keydown', { key: 'Enter' });
  await settleUntil(() => factory.connections[0].answers.length === 1 && panelStatus(online) === 'Connecting...', 'the reply accepted');
  assert.deepEqual(factory.connections[0].answers, [SAMPLE_SDP]);
  timers.advanceTo(29.99);
  assert.equal(factory.count, 1);
  timers.advanceTo(30);
  assert.equal(factory.connections[0].closed, true);
  assert.equal(factory.count, 2, 'a fresh invite');
  assert.equal(online.panel.messageText, 'Your two networks cannot connect directly.');
  await settleUntil(() => online.inviteUrl !== null, 'the fresh invite');
});

test('the session actions drive the pause note, the countdown and the title', () => {
  const factory = countingConnectionFactory();
  const { fakes, sessions, toasts, items } = createFakes({ runPhase: 'playing' });
  const online = createOnlineWiring({ ...fakes, createConnection: factory.create });
  const session = connectHost(online, sessions);
  online.update({ titleOpen: true, warmUpDone: true, deltaSeconds: STEP });
  assert.equal(session.calls.markReady, 1);
  assert.deepEqual(items.get('lab'), { label: 'Lab', enabled: false });
  assert.equal(items.get('online').label, 'DISCONNECT');
  assert.deepEqual(session.calls.titleModes, ['hives']);
  session.act({ type: 'start', mode: 'hives' });
  assert.equal(fakes.menu.visible, false);
  session.act({ type: 'pause', by: 1 });
  assert.equal(fakes.pauseMenu.visible, true);
  assert.equal(fakes.pauseMenu.note, 'PLAYER 2 PAUSED');
  session.act({ type: 'countdown', number: 3 });
  assert.equal(fakes.pauseMenu.visible, false);
  assert.equal(online.countdown.number, 3);
  session.act({ type: 'pause', by: null, lost: true });
  assert.equal(fakes.pauseMenu.note, 'CONNECTION LOST');
  session.act({ type: 'end', reason: 'lost' });
  assert.equal(fakes.menu.visible, true);
  assert.equal(fakes.pauseMenu.visible, false);
  assert.equal(online.active, false);
  assert.deepEqual(toasts, ['Connection lost. The match has ended.']);
  assert.deepEqual(online.remoteSeats().size, 0);
});

test('the sparring dummy is cleared when a connection is made', () => {
  const factory = countingConnectionFactory();
  const { fakes, toasts } = createFakes();
  const online = createOnlineWiring({ ...fakes, sparring: true, createConnection: factory.create });
  online.toggleOnline();
  assert.deepEqual(fakes.game.immuneCalls, [[]]);
  assert.equal(toasts.length, 1);
});

test('resume, restart and quit go to a live session only, and the peer quitting names the player', () => {
  const factory = countingConnectionFactory();
  const { fakes, sessions, toasts } = createFakes({ runPhase: 'playing' });
  const exposeTo = {};
  const online = createOnlineWiring({ ...fakes, exposeTo, createConnection: factory.create });
  assert.deepEqual([online.handleResume(), online.handleRestart(), online.handleQuit(), online.handleStart()], [false, false, false, false]);
  const session = connectHost(online, sessions);
  assert.equal(exposeTo.online.session, session);
  assert.deepEqual([online.handleResume(), online.handleRestart(), online.handleQuit()], [true, true, true]);
  assert.deepEqual([session.calls.resume, session.calls.restart, session.calls.quit], [1, 1, 1]);
  assert.equal(online.handleStart(), true);
  assert.deepEqual(session.calls.start, ['hives']);
  session.act({ type: 'restart' });
  assert.equal(fakes.audio.restarts, 1);
  session.act({ type: 'resume' });
  assert.equal(fakes.pauseMenu.note, '');
  online.toggleOnline();
  assert.equal(session.calls.quit, 2, 'the DISCONNECT item quits the session');
  session.act({ type: 'end', reason: 'remoteQuit' });
  assert.deepEqual(toasts, ['Player 2 left the match.']);
  assert.equal(exposeTo.online.session, null);
});

test('cancelling the panel, or a connection that fails before it opens, leaves nothing behind', async () => {
  const factory = countingConnectionFactory();
  const { fakes, sessions } = createFakes();
  const online = createOnlineWiring({ ...fakes, createConnection: factory.create });
  online.toggleOnline();
  online.toggleOnline();
  assert.equal(factory.connections[0].closed, true);
  assert.equal(online.active, false);
  assert.equal(online.panel.visible, false);
  online.toggleOnline();
  sessions.at(-1).act({ type: 'end', reason: 'lost' });
  assert.equal(online.panel.messageText, 'Your two networks cannot connect directly.');
  assert.equal(factory.count, 3, 'the host gets a fresh invite');
  await settleUntil(() => online.inviteUrl !== null, 'the fresh invite');
});
