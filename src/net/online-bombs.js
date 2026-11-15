// The one bomb pool online: the host's RunState holds it. A host press spends it at once; a guest
// press only asks (bombRequest with its swarm's centroid, its point with no ships), and the host
// spends the pool for it when bombs are left. Every spent bomb is cleared at once on the host and
// announced (bombAnnounced); the guest clears on the announce. Both clear the same disc: the
// centroid as the wire carries it (f32) and ONLINE_BOMB_RADIUS, the 16:9 view's bomb radius, so a
// narrow or wide window clears no differently from the other machine.

import { bombRadiusForView } from '../game/camera.js';
import { VIEW_HEIGHT, VIEW_WIDTH } from '../sim/layout.js';

export const ONLINE_BOMB_RADIUS = bombRadiusForView(VIEW_WIDTH, VIEW_HEIGHT);
// The bomb shockwave (RunState's, which the host's useBomb queues).
const BOMB_SHOCKWAVE_STRENGTH = 1;

function bombCenter(seat) {
  const center = seat.aliveCount > 0 ? seat.centroid : seat.point;
  return { x: Math.fround(center.x), y: Math.fround(center.y) };
}

// Host: spends the pool for seatIndex at center (false when empty), clears and announces it.
function spendBomb(online, game, seatIndex, center) {
  if (!game.run.useBomb(center)) return false;
  game.simulation.requestRadialKill(center.x, center.y, ONLINE_BOMB_RADIUS);
  online.queueEvent({ type: 'bombAnnounced', seat: seatIndex, x: center.x, y: center.y });
  game.effects?.bomb?.(seatIndex);
  return true;
}

// The local seat's bomb press.
export function pressOnlineBomb(online, game, seat) {
  const center = bombCenter(seat);
  if (online.isGuest) online.queueEvent({ type: 'bombRequest', x: center.x, y: center.y });
  else spendBomb(online, game, seat.index, center);
}

// This update's received bomb events: the host grants requests, the guest clears announces.
export function receiveBombs(online, game) {
  for (const event of online.receivedEvents) {
    if (online.isHost && event.type === 'bombRequest') spendBomb(online, game, online.remoteSeatIndex, { x: event.x, y: event.y });
    else if (online.isGuest && event.type === 'bombAnnounced') {
      game.simulation.requestRadialKill(event.x, event.y, ONLINE_BOMB_RADIUS);
      game.queueImpulse(event.x, event.y, BOMB_SHOCKWAVE_STRENGTH, true);
      game.effects?.bomb?.(event.seat);
    }
  }
}
