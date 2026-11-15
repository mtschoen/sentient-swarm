// The title's controller status: one always-present row per seat showing what the page really receives
// from navigator.getGamepads() (the pad's id, a non-standard mapping warning, a live press marker).
import { SEAT_COLORS } from '../game/seat-colors.js';

export const GAMEPAD_ID_MAXIMUM_LENGTH = 40;

const ONE_NONE_TEXT = 'P1: NO CONTROLLER DETECTED. KEYBOARD AND MOUSE IN USE. A BROWSER LISTS A CONTROLLER ONLY AFTER A BUTTON IS PRESSED ON IT';
const TWO_NONE_TEXT = 'P2: NO SECOND CONTROLLER DETECTED';
const TWO_DETECTED_TEXT = 'P2: SECOND CONTROLLER DETECTED. PRESS A BUTTON ON IT TO JOIN';
const TWO_MISSING_TEXT = 'P2: JOINED, BUT THE BROWSER NO LONGER LISTS ITS CONTROLLER';
const TWO_SPARRING_TEXT = 'P2: SPARRING DUMMY (DEBUG)';
const MAPPING_WARNING = 'WARNING: THE BROWSER REPORTS A NON-STANDARD MAPPING, SO THE BUTTONS MAY NOT MATCH';

export function shortPadId(gamepad) {
  return String(gamepad?.id ?? 'controller').slice(0, GAMEPAD_ID_MAXIMUM_LENGTH);
}

function padText(label, gamepad) {
  const base = `${label}: ${shortPadId(gamepad)}`;
  return gamepad.mapping === 'standard' ? base : `${base}. ${MAPPING_WARNING}`;
}

function anyPressed(gamepad) {
  return Array.from(gamepad?.buttons ?? []).some((button) => button?.pressed);
}

function rowFor(label, gamepad, fallbackText) {
  if (!gamepad) return { text: fallbackText, pressed: false };
  return { text: padText(label, gamepad), pressed: anyPressed(gamepad) };
}

// pads: the raw getGamepads() list (null holes allowed); seatTwoPad: seat 2's pad index when joined, else null.
export function padStatusModel({ pads, seatTwoPad = null, sparring = false }) {
  const listed = Array.from(pads ?? []).filter(Boolean);
  const joined = seatTwoPad !== null && seatTwoPad !== undefined;
  const seatOne = listed.find((gamepad) => gamepad.index !== (joined ? seatTwoPad : null)) ?? null;
  let seatTwo = null;
  let seatTwoFallback = TWO_NONE_TEXT;
  if (sparring && joined) {
    return { one: rowFor('P1', seatOne, ONE_NONE_TEXT), two: { text: TWO_SPARRING_TEXT, pressed: false } };
  }
  if (joined) {
    seatTwo = listed.find((gamepad) => gamepad.index === seatTwoPad) ?? null;
    seatTwoFallback = TWO_MISSING_TEXT;
  } else {
    seatTwo = listed.find((gamepad) => gamepad !== seatOne) ?? null;
    if (seatTwo) {
      return {
        one: rowFor('P1', seatOne, ONE_NONE_TEXT),
        two: { text: TWO_DETECTED_TEXT + (seatTwo.mapping === 'standard' ? '' : `. ${MAPPING_WARNING}`), pressed: anyPressed(seatTwo) },
      };
    }
  }
  return { one: rowFor('P1', seatOne, ONE_NONE_TEXT), two: rowFor('P2', seatTwo, seatTwoFallback) };
}

export function createPadStatus(parent, { documentObject = document } = {}) {
  const make = (seatIndex, seatClass) => {
    const element = documentObject.createElement('div');
    element.className = `pad-status ${seatClass}`;
    element.style.color = SEAT_COLORS[seatIndex].css;
    element.hidden = true;
    parent.append(element);
    return { element, lastText: null, lastPressed: false,lastVisible: false };
  };
  const rows = { one: make(0, 'pad-status-one'), two: make(1, 'pad-status-two') };
  const apply = (row, { text, pressed }, visible) => {
    if (text !== row.lastText) {
      row.element.textContent = text;
      row.lastText = text;
    }
    if (pressed !== row.lastPressed) {
      row.element.className = `pad-status ${row === rows.one ? 'pad-status-one' : 'pad-status-two'}${pressed ? ' pad-status-pressed' : ''}`;
      row.lastPressed = pressed;
    }
    if (visible !== row.lastVisible) {
      row.element.hidden = !visible;
      row.lastVisible = visible;
    }
  };
  return {
    elements: [rows.one.element, rows.two.element],
    update({ pads, seatTwoPad, visible, sparring = false }) {
      const model = padStatusModel({ pads, seatTwoPad, sparring });
      apply(rows.one, model.one, visible);
      apply(rows.two, model.two, visible);
    },
  };
}
