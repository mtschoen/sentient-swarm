// The online wiring of the page: the one place main.js reaches online play through. It builds the
// Host and Join panel (online-panel.js) and the connected title line (online-title.js) inside the
// title menu, and the resume countdown (resume-countdown.js) over the arena, and creates nothing
// else until the ONLINE item or a #join= link asks for a connection (createConnection, by default
// the WebRTC one). An OnlineSession (src/net/online-session.js) is made with each connection; its
// actions drive the screens: the pause menu with its note, the countdown, the title and toasts.
// main.js keeps its couch handlers and gives each one guard line (handleStart, handlePause, ...),
// which returns true when online play took the request. While a connection or session exists the
// couch join, the mode item's couch rule, the Lab and the sparring dummy are out of play.
// The connect timeout (CONNECT_TIMEOUT_SECONDS) counts on the host from an accepted reply and on
// the guest from Copy reply; on expiry both show NO_DIRECT_ROUTE and the host gets a fresh invite.
// Timers: setTimer(callback, seconds) -> handle and clearTimer(handle).

import { createRtcConnection } from '../net/rtc-transport.js';
import { OnlineSession } from '../net/online-session.js';
import { SessionClock } from '../net/session-clock.js';
import { CONNECT_TIMEOUT_SECONDS } from '../net/protocol.js';
import { SignalError, decodeSignal, encodeSignal, inviteFromHash, inviteUrl } from '../net/signal-codec.js';
import { createOnlinePanel } from './online-panel.js';
import { ONLINE_ITEM_ID, createOnlineTitle, onlineTitleView } from './online-title.js';
import { createResumeCountdown } from './resume-countdown.js';

export const NO_DIRECT_ROUTE = 'Your two networks cannot connect directly.';
const END_MESSAGES = Object.freeze({
  lost: 'Connection lost. The match has ended.',
  version: 'Both players need to reload the page.',
});
const INVITE_MESSAGES = Object.freeze({
  version: 'Both players need to reload the page.',
  wrongKind: 'That is a reply, not an invite. Open the invite link your friend sent.',
  malformed: 'That invite link is broken. Ask your friend for a new one.',
});
const STALE_REPLY = 'That reply is for another invite. Send your friend this new one.';
const NO_SECOND_INVITE = 'Already online: that invite link was ignored.';
const SPARRING_OFF = 'DEBUG SPARRING is off online';
const NO_REMOTE_SEATS = Object.freeze(new Set());

// The title menu's ONLINE item; the action is read when chosen (the wiring is made after the menu).
export function onlineMenuItem(toggle) {
  return { id: ONLINE_ITEM_ID, label: 'ONLINE', action: () => toggle() };
}

export function createOnlineWiring({
  game, menu, pauseMenu, hud, modeControl, coopJoin, input, audio, sparring = false,
  showToast = (text) => hud.showToast(text),
  documentObject = document, windowObject = null, locationObject = location, historyObject = history,
  clipboard = navigator.clipboard, exposeTo = null,
  now = () => performance.now() / 1000,
  setTimer = (callback, seconds) => setTimeout(callback, seconds * 1000),
  clearTimer = (handle) => clearTimeout(handle),
  createConnection = (timers) => createRtcConnection({ PeerConnection: windowObject.RTCPeerConnection, ...timers }),
  createSession = (options) => new OnlineSession(options),
}) {
  const panel = createOnlinePanel(menu.element, {
    documentObject, clipboard, onReply: (text) => acceptReply(text), onCopyReply: () => copiedReply(), onCancel: () => cancel(),
  });
  panel.hide();
  const onlineTitle = createOnlineTitle(menu.element, { documentObject });
  const countdown = createResumeCountdown(documentObject.body, { documentObject });

  let connection = null;
  let session = null;
  let role = null;
  let connected = false;
  let markedReady = false;
  let sentTitleMode = null;
  let connectTimer = null;
  let pendingInvite = null;
  let invite = null;
  let reply = null;
  let sparringCleared = false;
  // The pad the local seat read at the last update (a disconnected pad is gone from the list).
  let seatOnePad = null;

  const live = () => session !== null && connected;
  // A connection in progress, or the panel still up after one failed: the title belongs to online
  // play (no couch start, join or Lab) until the panel is cancelled.
  const holding = () => connection !== null || panel.visible;

  function clearConnectTimer() {
    if (connectTimer !== null) clearTimer(connectTimer);
    connectTimer = null;
  }

  // Forgets the connection and session (closing them) with no session action reaching the screens.
  function teardown() {
    clearConnectTimer();
    const closing = { session, connection };
    session = null;
    connection = null;
    role = null;
    connected = false;
    markedReady = false;
    sentTitleMode = null;
    invite = null;
    reply = null;
    modeControl.setOnline(null);
    closing.session?.dispose();
    closing.connection?.close();
  }

  function begin(asRole) {
    coopJoin.reset();
    if (sparring && !sparringCleared) {
      game.setNeutralImmuneSeats([]);
      sparringCleared = true;
      showToast(SPARRING_OFF);
    }
    role = asRole;
    connection = createConnection({ setTimer, clearTimer });
    const clock = new SessionClock({ now });
    const created = createSession({
      role, transport: connection.transport, clock, game, setTimer, clearTimer,
      onAction: (action) => { if (session === created) handleAction(action); },
    });
    session = created;
    return connection;
  }

  function beginHost(message = '') {
    const current = begin('host');
    panel.showHost();
    if (message !== '') panel.showMessage(message);
    current.createOffer()
      .then((sdp) => encodeSignal({ kind: 'offer', sdp }))
      .then((encoded) => {
        if (connection !== current) return;
        invite = inviteUrl(locationObject.href, encoded);
        panel.setInvite(invite);
      })
      .catch(() => { if (connection === current) panel.showMessage(NO_DIRECT_ROUTE); });
  }

  function beginJoin(payload) {
    const current = begin('guest');
    panel.showJoin();
    decodeSignal(payload, 'offer')
      .then(({ sdp }) => current.acceptOffer(sdp))
      .then((answer) => encodeSignal({ kind: 'answer', sdp: answer }))
      .then((encoded) => {
        if (connection !== current) return;
        reply = encoded;
        panel.setReply(encoded);
      })
      .catch((error) => {
        if (connection !== current) return;
        panel.showMessage(error instanceof SignalError ? (INVITE_MESSAGES[error.reason] ?? INVITE_MESSAGES.malformed) : NO_DIRECT_ROUTE);
      });
  }

  // Host: the panel checked the reply; a reply the connection refuses (a stale one) gets a fresh invite.
  function acceptReply(text) {
    const current = connection;
    if (role !== 'host' || current === null) return;
    decodeSignal(text, 'answer')
      .then(({ sdp }) => current.acceptAnswer(sdp))
      .then(() => {
        if (connection !== current) return;
        panel.setConnecting();
        startConnectTimer();
      })
      .catch(() => {
        if (connection !== current) return;
        teardown();
        beginHost(STALE_REPLY);
      });
  }

  // The guest's Copy reply: a gesture, so the audio unlocks here (the match starts from the host).
  function copiedReply() {
    audio?.unlock?.();
    startConnectTimer();
  }

  function startConnectTimer() {
    if (connectTimer !== null || connected || connection === null) return;
    connectTimer = setTimer(() => {
      connectTimer = null;
      const wasHost = role === 'host';
      teardown();
      if (wasHost) beginHost(NO_DIRECT_ROUTE);
      else panel.showMessage(NO_DIRECT_ROUTE);
    }, CONNECT_TIMEOUT_SECONDS);
  }

  function cancel() {
    teardown();
    panel.hide();
  }

  function showPause(text) {
    countdown.hide();
    audio?.setPaused(true);
    pauseMenu.setNote(text);
    pauseMenu.show();
  }

  function leavePause() {
    countdown.hide();
    pauseMenu.hide();
    pauseMenu.setNote('');
    audio?.setPaused(false);
  }

  function opened() {
    if (connected) return;
    connected = true;
    clearConnectTimer();
    panel.hide();
    modeControl.setOnline(role);
  }

  function ended(reason) {
    const remoteSeat = role === 'host' ? 2 : 1;
    const wasConnected = connected;
    const wasHost = role === 'host';
    session = null;
    teardown();
    leavePause();
    menu.show();
    if (!wasConnected) {
      // The connection failed before it opened: the panel says so (the host's with a fresh invite).
      if (wasHost) beginHost(NO_DIRECT_ROUTE);
      else panel.showMessage(NO_DIRECT_ROUTE);
      return;
    }
    if (reason === 'remoteQuit') showToast(`Player ${remoteSeat} left the match.`);
    else if (END_MESSAGES[reason] !== undefined) showToast(END_MESSAGES[reason]);
  }

  function handleAction(action) {
    switch (action.type) {
      case 'connection':
        if (action.state === 'open') {
          if (!connected) opened();
          else if (pauseMenu.visible) pauseMenu.setNote('');
        }
        break;
      case 'start':
      case 'restart':
        leavePause();
        menu.hide();
        audio?.restartRun();
        break;
      case 'pause':
        showPause(action.lost ? 'CONNECTION LOST' : `PLAYER ${action.by + 1} PAUSED`);
        break;
      case 'countdown':
        if (action.number === null) countdown.hide();
        else {
          pauseMenu.hide();
          countdown.show(action.number);
        }
        break;
      case 'resume':
        leavePause();
        break;
      case 'titleMode':
        modeControl.setRemoteMode(action.mode);
        break;
      case 'end':
        ended(action.reason);
        break;
      default:
        break;
    }
  }

  function openFromHash(hash) {
    const payload = inviteFromHash(hash);
    if (payload === null) return;
    historyObject.replaceState(null, '', `${locationObject.pathname}${locationObject.search}`);
    if (connection !== null) {
      showToast(NO_SECOND_INVITE);
      return;
    }
    pendingInvite = payload;
  }

  windowObject?.addEventListener('hashchange', () => openFromHash(locationObject.hash));

  function update({ titleOpen, warmUpDone }) {
    seatOnePad = input?.seatOnePadIndex() ?? null;
    if (pendingInvite !== null && titleOpen && connection === null) {
      const payload = pendingInvite;
      pendingInvite = null;
      beginJoin(payload);
    }
    if (live() && warmUpDone && !markedReady) {
      markedReady = true;
      session.markReady();
    }
    if (live() && role === 'host' && modeControl.mode !== sentTitleMode) {
      sentTitleMode = modeControl.mode;
      session.setTitleMode(sentTitleMode);
    }
    const view = onlineTitleView({ connected: live(), role, roundTripMilliseconds: session?.roundTripMilliseconds ?? null, waitingFor: session?.waitingFor ?? null });
    menu.setItem(ONLINE_ITEM_ID, { label: view.onlineLabel, enabled: true });
    const pending = holding() && !live();
    menu.setItem('play', { label: view.playLabel, enabled: view.playEnabled && !pending });
    menu.setItem('lab', { label: 'Lab', enabled: view.labEnabled && !holding() });
    onlineTitle.update(view, { visible: titleOpen && live() });
  }

  const wiring = {
    panel,
    onlineTitle,
    countdown,
    // A connection or session exists (connecting included), or the panel is still up after a failed one.
    get active() { return holding(); },
    get role() { return role; },
    get session() { return session; },
    get inviteUrl() { return invite; },
    get replyText() { return reply; },
    remoteSeats() {
      return live() ? new Set([role === 'host' ? 1 : 0]) : NO_REMOTE_SEATS;
    },
    // The title's Play: the host starts both matches; the guest's Play is ghosted.
    handleStart() {
      if (!holding()) return false;
      if (live() && role === 'host' && session.waitingFor === null) session.start(modeControl.mode);
      return true;
    },
    handlePause() {
      if (!live()) return false;
      session.pause();
      return true;
    },
    handleResume() {
      if (!live()) return false;
      session.resume();
      return true;
    },
    handleRestart() {
      if (!live()) return false;
      session.restart();
      return true;
    },
    handleQuit() {
      if (!live()) return false;
      session.quit();
      return true;
    },
    // The pad the local seat reads went away: online that pauses both.
    handlePadDisconnected(padIndex) {
      if (!live() || padIndex === undefined || padIndex !== seatOnePad) return false;
      session.pause();
      return true;
    },
    // The ONLINE item (a gesture: the audio unlocks for the match the host will start).
    toggleOnline() {
      audio?.unlock?.();
      if (live()) session.quit();
      else if (holding()) cancel();
      else beginHost();
    },
    openFromHash,
    update,
  };
  if (exposeTo !== null) {
    exposeTo.online = {
      get session() { return session; },
      get inviteUrl() { return invite; },
      get replyText() { return reply; },
      get phase() { return session?.phase ?? null; },
    };
  }
  return wiring;
}
