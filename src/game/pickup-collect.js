// Pickup collection, taking the Game as context like versus-seats.js: a seat reaching a pickup
// arms its weapon (or starts the global time warp, or counts a beam shard), and the collection
// plays the pickup effect, the blast (a radial kill of pickupBlastRadius) and a shockwave at the
// seat's point. Online (src/net/online-game.js) the machine that did not collect runs
// applyCollection with arm false: the same blast and shockwave, no sound, weapon, warp or shard change.
import { BEAM_SHARD_TYPE } from './weaponTypes.js';
import { BEAM_TIME_IMPULSE_STRENGTH, collectShardFor } from './beam-time-seats.js';

const PICKUP_IMPULSE_STRENGTH = 0.15;
const PICKUP_BLAST_IMPULSE_STRENGTH = 0.5;
const TIME_WARP_IMPULSE_STRENGTH = 0.6;

// The collection of a pickup of type by seat at x, y.
export function applyCollection(game, seat, type, x, y, { arm = true } = {}) {
  // Only a two-seat game tells the effect which seat collected.
  const seatArguments = game.seats.length > 1 ? [seat.index] : [];
  const timeWarp = type === 'timewarp';
  const shard = type === BEAM_SHARD_TYPE;
  let opensBeamTime = false;
  if (shard) {
    if (arm) opensBeamTime = collectShardFor(game, seat);
  } else if (timeWarp) {
    if (arm) game.timeWarp.start();
    if (arm) game.effects?.pickup?.('timewarp', ...seatArguments);
  } else if (arm) {
    seat.weapons.collect(type);
    game.effects?.pickup?.(...(seatArguments.length > 0 ? [undefined, ...seatArguments] : []));
  }
  const blast = game.pickupBlastRadiusValue > 0;
  if (blast) game.simulation.requestRadialKill(x, y, game.pickupBlastRadiusValue);
  const strength = blast ? PICKUP_BLAST_IMPULSE_STRENGTH : PICKUP_IMPULSE_STRENGTH;
  if (opensBeamTime) game.queueImpulse(x, y, BEAM_TIME_IMPULSE_STRENGTH, true);
  else game.queueImpulse(x, y, timeWarp ? TIME_WARP_IMPULSE_STRENGTH : strength, false);
}

// A pickup at this seat: its weapon (or the global time warp), the blast and the shockwave.
export function collectFor(game, seat) {
  const collected = seat.collectPickup(game.pickups);
  if (collected === null) return;
  const { x, y } = seat.point;
  applyCollection(game, seat, collected, x, y);
}
