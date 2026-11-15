// The connected title: what the title menu shows once an online session exists. onlineTitleView is the
// pure mapping from the session to the ONLINE item's label, the status line and the Play and Lab items;
// createOnlineTitle draws the one status line in seat 2's color, always laid out (visibility only).
import { SEAT_COLORS } from '../game/seat-colors.js';

export const ONLINE_ITEM_ID = 'online';
// The host's Play while a side is still loading (the session's waitingFor), naming that side.
const PLAY_LABELS = Object.freeze({ local: 'WAITING FOR YOUR GAME TO LOAD', remote: 'WAITING FOR PLAYER 2 TO LOAD' });

function latencyText(roundTripMilliseconds) {
  return Number.isFinite(roundTripMilliseconds) ? ` (${Math.round(roundTripMilliseconds)} MS)` : '';
}

export function onlineTitleView({ connected, role, roundTripMilliseconds = null, waitingFor = null }) {
  if (!connected) return { onlineLabel: 'ONLINE', statusLine: '', playLabel: 'Play', playEnabled: true, labEnabled: true };
  if (role === 'host') {
    return {
      onlineLabel: 'DISCONNECT',
      statusLine: `PLAYER 2 CONNECTED ONLINE${latencyText(roundTripMilliseconds)}`,
      playLabel: waitingFor === null ? 'Play' : (PLAY_LABELS[waitingFor] ?? PLAY_LABELS.remote),
      playEnabled: waitingFor === null,
      labEnabled: false,
    };
  }
  return {
    onlineLabel: 'DISCONNECT',
    statusLine: `CONNECTED TO PLAYER 1 ONLINE${latencyText(roundTripMilliseconds)}`,
    playLabel: 'WAITING FOR THE HOST TO START',
    playEnabled: false,
    labEnabled: false,
  };
}

export function createOnlineTitle(menuElement, { documentObject = document } = {}) {
  const element = documentObject.createElement('div');
  element.className = 'online-status';
  element.style.color = SEAT_COLORS[1].css;
  element.style.visibility = 'hidden';
  menuElement.append(element);
  let lastText = null;
  let lastVisible = false;
  return {
    element,
    update(view, { visible }) {
      // The class that sizes Play for the connected labels is set only while a session exists.
      menuElement.classList?.toggle('menu-online', view.statusLine !== '');
      if (view.statusLine !== lastText) {
        element.textContent = view.statusLine;
        lastText = view.statusLine;
      }
      if (visible !== lastVisible) {
        element.style.visibility = visible ? 'visible' : 'hidden';
        lastVisible = visible;
      }
    },
  };
}
