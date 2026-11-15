// Seat readouts for the two-player HUD, the game over banner (a versus winner in its seat's color),
// and the weapon text both HUD parts share.
import { SEAT_COLORS } from '../game/seat-colors.js';
import { matchResultText } from '../game/versus.js';

const GAME_OVER_TITLE = 'GAME OVER';
const ROMAN = ['', 'I', 'II', 'III'];
export const LIFE_ICON = '▲';

export function tierNumeral(tier) {
  return ROMAN[tier] ?? tier;
}

export function weaponText(armed, tier) {
  if (!armed || armed === 'base') return 'BASE';
  return `${armed.toUpperCase()} ${tierNumeral(tier)}`;
}

// The game over title and its color (null keeps the stylesheet's): GAME OVER outside versus, else
// PLAYER n WINS in seat n's color, or DRAW.
export function gameOverBanner(matchResult) {
  if (matchResult === null || matchResult === undefined) return { title: GAME_OVER_TITLE, color: null };
  return { title: matchResultText(matchResult), color: matchResult.draw ? null : SEAT_COLORS[matchResult.winner].css };
}

export function seatReadoutText(seat, seatIndex) {
  const label = `P${seatIndex + 1}`;
  if (seat.down) return `${label} DOWN ${seat.reviveKills}/${seat.reviveKillsNeeded}`;
  return `${label} ${LIFE_ICON} ${seat.ships} ${weaponText(seat.armed, seat.tier)}`;
}
