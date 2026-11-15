// One seat as a SeatSnapshot (the state channel's message): the point, aim, weapons and every alive
// ship with its generation and gunner station. The game side marks a ship with no station -1; the
// snapshot uses null (the codec writes every non-null gunnerIndex as a station). Headings are wrapped
// into [-PI, PI], the codec's range. host (the gates and wave) and hostState are the host's blocks,
// null from the guest.

import { wrapAngle } from '../game/swarm-facing.js';

function beamFields(beam) {
  if (beam === null || beam === undefined) return null;
  const { x, y, directionX, directionY, halfWidth } = beam;
  return { x, y, directionX, directionY, halfWidth };
}

export function buildSeatSnapshot(seat, { sequence, matchSeconds, firing, beam, invulnerable, host = null, hostState = null }) {
  const { player, swarm, weapons } = seat;
  const ships = swarm.ships.map((ship) => ({
    slot: ship.slot,
    x: ship.x,
    y: ship.y,
    heading: wrapAngle(ship.heading),
    gunnerIndex: ship.gunnerIndex < 0 ? null : ship.gunnerIndex,
    generation: swarm.generationOf(ship.slot),
  }));
  return {
    type: 'snapshot',
    sequence,
    matchSeconds,
    seat: seat.index,
    point: { x: player.positionX, y: player.positionY, velocityX: player.velocityX, velocityY: player.velocityY },
    aim: { x: player.aimX, y: player.aimY },
    firing: Boolean(firing),
    invulnerable: Boolean(invulnerable),
    weapons: { armed: weapons.armed, tier: weapons.tier, charge: weapons.charge, railTurrets: weapons.railTurrets, railTier: weapons.railTier },
    aliveCount: ships.length,
    ships,
    beam: beamFields(beam),
    host,
    hostState,
  };
}
