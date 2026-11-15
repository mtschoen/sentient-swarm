// Rail gunner ships: station geometry and gunner assignment. A gunner is an ordinary swarm ship that
// holds a station on a circle around the controlled point (at the aim angle plus its turret offset)
// and points outward along it. Each station without a gunner takes the nearest live non-gunner
// ship; a gunner keeps its station index until it dies or the effective count drops below it.
// Pure; allocation-free once the station list has grown to the count.
import { MAXIMUM_RAIL_TURRETS, railTurretOffset } from './weaponTypes.js';

// Station radius as a share of the home radius: inside the leash circle, outside the bee cloud.
export const GUNNER_STATION_REACH = 0.8;
// Seek weight toward the station (the roaming waypoint's is SWARM_SEEK, 0.6).
export const GUNNER_SEEK = 1.6;
// Wander and buzz shares a gunner keeps, so it hovers on its station instead of jittering off it.
export const GUNNER_WANDER_SCALE = 0.25;
export const GUNNER_BUZZ_SCALE = 0.3;
// Share of the ships' speed floor a gunner keeps: at the full floor a ship never stops and loops
// 0.2 to 0.3 units around its station instead of holding it.
export const GUNNER_SPEED_FLOOR_SCALE = 0.1;

const holders = new Int16Array(MAXIMUM_RAIL_TURRETS);

// Fills out[0..count - 1] with { x, y, angle } stations; entries are reused, created only when out
// is shorter. Returns out.
export function gunnerStations(count, aimAngle, centerX, centerY, radius, out) {
  for (let index = 0; index < count; index += 1) {
    if (out[index] === undefined) out[index] = { x: 0, y: 0, angle: 0 };
    const angle = aimAngle + railTurretOffset(index, count);
    const entry = out[index];
    entry.angle = angle;
    entry.x = centerX + Math.cos(angle) * radius;
    entry.y = centerY + Math.sin(angle) * radius;
  }
  return out;
}

// Sets gunnerIndex on every slot (-1 for a non-gunner) and copies the station into each gunner's
// stationX, stationY and stationAngle.
export function assignGunners(slots, effectiveCount, stations) {
  holders.fill(-1);
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
    const slot = slots[slotIndex];
    if (!slot.alive || slot.gunnerIndex >= effectiveCount) slot.gunnerIndex = -1;
    else if (slot.gunnerIndex >= 0) holders[slot.gunnerIndex] = slotIndex;
  }
  for (let station = 0; station < effectiveCount; station += 1) {
    if (holders[station] >= 0) continue;
    const target = stations[station];
    let best = -1;
    let bestDistance = Infinity;
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      const slot = slots[slotIndex];
      if (!slot.alive || slot.gunnerIndex >= 0) continue;
      const offsetX = slot.x - target.x;
      const offsetY = slot.y - target.y;
      const distance = offsetX * offsetX + offsetY * offsetY;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = slotIndex;
      }
    }
    if (best < 0) continue;
    slots[best].gunnerIndex = station;
    holders[station] = best;
  }
  for (let station = 0; station < effectiveCount; station += 1) {
    if (holders[station] < 0) continue;
    const slot = slots[holders[station]];
    slot.stationX = stations[station].x;
    slot.stationY = stations[station].y;
    slot.stationAngle = stations[station].angle;
  }
}
