// The title's "player 2" line: how to join, or that seat 2 joined, in seat 2's color.
import { SEAT_COLORS } from '../game/seat-colors.js';

const INVITE_TEXT = 'PLAYER 2: PRESS A BUTTON ON A SECOND CONTROLLER TO JOIN (WITH ONE CONTROLLER AND THE KEYBOARD: A SHOULDER BUTTON)';
const JOINED_TEXT = 'PLAYER 2 JOINED. PRESS A SHOULDER BUTTON TO LEAVE';

export function joinBannerText({ joined }) {
  return joined ? JOINED_TEXT : INVITE_TEXT;
}

export function createJoinBanner(parent, { documentObject = document } = {}) {
  const element = documentObject.createElement('div');
  element.className = 'join-banner';
  element.style.color = SEAT_COLORS[1].css;
  element.hidden = true;
  parent.append(element);
  let lastText = null;
  let lastVisible = false;
  return {
    element,
    update({ joined, visible }) {
      const text = joinBannerText({ joined });
      if (text !== lastText) {
        element.textContent = text;
        lastText = text;
      }
      if (visible !== lastVisible) {
        element.hidden = !visible;
        lastVisible = visible;
      }
    },
  };
}
