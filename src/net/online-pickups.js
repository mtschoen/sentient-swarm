// The online pickup flow over an OnlineGame (its pickupLedger on the host, its guestPickups on the
// guest, its receivedEvents and queueEvent); the header of online-game.js describes it.

import { RunPhase } from '../game/run.js';
import { applyCollection } from '../game/pickup-collect.js';
import { findReachedPickup } from './pickup-ledger.js';

// Host: the director's new pickups announced and its gone ones expired.
export function observeHostPickups(online, game) {
  const { announced, expired } = online.pickupLedger.observe(game.pickups.pickups);
  for (const entry of announced) online.queueEvent({ type: 'pickupAnnounced', ...entry });
  for (const id of expired) online.queueEvent({ type: 'pickupExpired', id });
}

// Guest: the host's pickup events of this update, then the fade while Playing.
export function ageGuestPickups(online, game, deltaSeconds) {
  const pickups = online.guestPickups;
  for (const event of online.receivedEvents) {
    if (event.type === 'pickupAnnounced') pickups.announce(event);
    else if (event.type === 'pickupExpired') pickups.remove(event.id);
    else if (event.type === 'pickupCollected') {
      pickups.remove(event.id);
      const seat = game.seats[event.seat];
      if (seat !== undefined) applyCollection(game, seat, event.pickupType, event.x, event.y, { arm: event.seat === online.localSeatIndex });
    }
  }
  if (game.run.phase === RunPhase.Playing) pickups.age(deltaSeconds, game.pickups.fadeSeconds);
}

// Host: the pickup taken for seat (refused once gone), announced and collected at x, y as the
// guest will read it (f32).
function grant(online, game, seat, id, x, y) {
  const pickup = id === null ? null : online.pickupLedger.take(id, game.pickups.pickups);
  if (pickup === null) return;
  const at = { x: Math.fround(x), y: Math.fround(y) };
  online.queueEvent({ type: 'pickupCollected', id, seat: seat.index, pickupType: pickup.type, ...at });
  applyCollection(game, seat, pickup.type, at.x, at.y, { arm: seat.index === online.localSeatIndex });
}

// The local seat's reach: the host takes at once, then grants the guest's claims of this update;
// the guest claims the pickup it reaches (once per id).
export function collectOnline(online, game, seat) {
  const reached = findReachedPickup(seat, game.pickups.pickups);
  const { x, y } = seat.point;
  if (online.isGuest) {
    if (reached !== null && reached.id !== undefined && online.guestPickups.claim(reached.id)) online.queueEvent({ type: 'pickupClaim', id: reached.id, x, y });
    return;
  }
  if (reached !== null) grant(online, game, seat, online.pickupLedger.idOf(reached), x, y);
  for (const event of online.receivedEvents) {
    if (event.type === 'pickupClaim') grant(online, game, game.seats[online.remoteSeatIndex], event.id, event.x, event.y);
  }
}
