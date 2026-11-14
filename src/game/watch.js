// The lab's watch mode helpers (solo only): the point that follows the pointer, and the held-fraction
// spawn pressure that replaces the play ramp.
import { SPEC_SPAWN_DISTANCE_FRACTION, SpawnPressure } from '../sim/spawner.js';

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

// The point sits on the pointer (clamped inside the arena), else moves with the stick.
export function moveWatchPoint(player, deltaSeconds, inputState, controls) {
  const pointer = inputState.pointerWorld;
  if (!pointer) {
    player.update(deltaSeconds, { ...controls, firing: false });
    return;
  }
  const { radius, bounds } = player;
  player.positionX = clamp(pointer.x, bounds.minX + radius, bounds.maxX - radius);
  player.positionY = clamp(pointer.y, bounds.minY + radius, bounds.maxY - radius);
}

// A watch SpawnPressure holding fraction of capacity with full seek; the in-flight spawn estimate of
// the previous watch pressure carries over. Throws RangeError for a fraction outside [0, 1].
export function createWatchPressure(capacity, fraction, previous = null) {
  if (!(typeof fraction === 'number' && fraction >= 0 && fraction <= 1)) throw new RangeError(`watch fraction must lie in [0, 1], got ${fraction}`);
  const next = new SpawnPressure({
    capacity, floorFraction: fraction, ceilingFraction: fraction, seekFloorFraction: 1,
    spawnDistanceStartFraction: SPEC_SPAWN_DISTANCE_FRACTION,
  });
  if (previous !== null) {
    next.newestStats = previous.newestStats;
    next.requests = previous.requests;
    next.filling = previous.filling;
  }
  return next;
}
