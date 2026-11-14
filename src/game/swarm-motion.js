// The player swarm's bee motion: the fixed tightness, buzz and follow of its flocking.
//   tightness: a harmonic well toward the controlled point (desired speed grows linearly with the
//              distance, TIGHTNESS_WELL_RATE * SWARM_TIGHTNESS per second) and the roaming
//              waypoints' reach shrunk by SWARM_ROAM_SCALE = 1 / (1 + SWARM_TIGHTNESS).
//   buzz:      a per-ship jittering velocity (a fresh random direction several times a second,
//              smoothly blended, independent per slot) of SWARM_BUZZ * BUZZ_SPEED_SHARE * cruise
//              speed, added to the ship's movement directly: as a steering input the steering
//              response and the acceleration cap smoothed it away.
//   follow:    the share of the controlled point's velocity that carries the flock (SWARM_FOLLOW,
//              1: the flock flies in the point's frame and behaves around a moving point as around
//              a still one).
// Pure: the noise is a function of the slot and the time.
import { slotHash } from './swarm-hash.js';

export const SWARM_TIGHTNESS = 2;
export const SWARM_BUZZ = 1.5;
export const SWARM_FOLLOW = 1;
// The roaming waypoints' reach multiplier.
export const SWARM_ROAM_SCALE = 1 / (1 + SWARM_TIGHTNESS);

// Well strength per unit of tightness, in 1/s: at tightness 1 a ship 1 unit from the point wants to
// fly toward it at 3 units per second (the cruise speed is 2.2).
export const TIGHTNESS_WELL_RATE = 3;
// Buzz 1 adds a velocity of this share of the ship's cruise speed, at a random direction.
export const BUZZ_SPEED_SHARE = 0.8;
// Seconds over which the point's velocity is smoothed before it carries the flock, so the flock
// leans into a start and a stop instead of moving as one rigid body.
export const FOLLOW_SMOOTH_SECONDS = 0.06;
// How many times per second a ship's buzz direction is redrawn (per slot, within this range).
export const BUZZ_MINIMUM_HERTZ = 3;
export const BUZZ_MAXIMUM_HERTZ = 7;

// The buzz velocity direction of a slot at a time, written into out as a vector of length at most 1
// (two random directions blended with a smoothstep, so it turns smoothly but unpredictably).
export function buzzDirection(slot, time, out) {
  const hertz = BUZZ_MINIMUM_HERTZ + (BUZZ_MAXIMUM_HERTZ - BUZZ_MINIMUM_HERTZ) * slotHash(slot, 40);
  const position = time * hertz + slotHash(slot, 41) * 1000;
  const epoch = Math.floor(position);
  const fraction = position - epoch;
  const blend = fraction * fraction * (3 - 2 * fraction);
  const fromAngle = slotHash(slot, 5000 + epoch) * Math.PI * 2;
  const toAngle = slotHash(slot, 5001 + epoch) * Math.PI * 2;
  out.x = Math.cos(fromAngle) * (1 - blend) + Math.cos(toAngle) * blend;
  out.y = Math.sin(fromAngle) * (1 - blend) + Math.sin(toAngle) * blend;
  return out;
}
