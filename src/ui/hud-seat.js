// Seat readouts for the two-player HUD, and the weapon text both HUD parts share.
const ROMAN = ['', 'I', 'II', 'III'];
export const LIFE_ICON = '▲';

export function tierNumeral(tier) {
  return ROMAN[tier] ?? tier;
}

export function weaponText(armed, tier) {
  if (!armed || armed === 'base') return 'BASE';
  return `${armed.toUpperCase()} ${tierNumeral(tier)}`;
}

export function seatReadoutText(seat, seatIndex) {
  const label = `P${seatIndex + 1}`;
  if (seat.down) return `${label} DOWN ${seat.reviveKills}/${seat.reviveKillsNeeded}`;
  return `${label} ${LIFE_ICON} ${seat.ships} ${weaponText(seat.armed, seat.tier)}`;
}
