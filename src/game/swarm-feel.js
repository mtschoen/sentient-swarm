// Swarm feel dials (EXPERIMENT, meant to be deleted once the liked values are baked in): three live
// multipliers on the player swarm's flocking, so the owner can tune "bees, not fish" on a phone.
//   alignment: scales the neighbour-alignment term. 0 = none (no schooling), 1 = today's value.
//   tightness: a harmonic well toward the controlled point (desired speed grows linearly with the
//              distance, TIGHTNESS_WELL_RATE * tightness per second) and the roaming waypoints'
//              reach shrunk by 1 / (1 + tightness). 0 = today's leash and roaming only.
//   buzz:      a per-ship jittering velocity (a fresh random direction several times a second,
//              smoothly blended, independent per slot) of buzz * BUZZ_SPEED_SHARE * cruise speed.
//              0 = today's slow wander only.
// FISH_FEEL reproduces the behaviour before the dials. BEES_FEEL is the spike's default.
// Pure: parsing, formatting and the noise are functions of their arguments (the noise of the time).
import { slotHash } from './swarm-hash.js';

export const FISH_FEEL = Object.freeze({ alignment: 1, tightness: 0, buzz: 0 });
export const BEES_FEEL = Object.freeze({ alignment: 0.1, tightness: 2, buzz: 1.5 });

export const FEEL_DIALS = Object.freeze([
  { key: 'alignment', label: 'Alignment', parameter: 'swarmAlignment', minimum: 0, maximum: 2, step: 0.05 },
  { key: 'tightness', label: 'Tightness', parameter: 'swarmTightness', minimum: 0, maximum: 4, step: 0.05 },
  { key: 'buzz', label: 'Buzz', parameter: 'swarmBuzz', minimum: 0, maximum: 3, step: 0.05 },
]);

// Well strength per unit of tightness, in 1/s: at tightness 1 a ship 1 unit from the point wants to
// fly toward it at 3 units per second (the cruise speed is 2.2).
export const TIGHTNESS_WELL_RATE = 3;
// Buzz 1 adds a velocity of this share of the ship's cruise speed, at a random direction.
export const BUZZ_SPEED_SHARE = 0.8;
// How many times per second a ship's buzz direction is redrawn (per slot, within this range).
export const BUZZ_MINIMUM_HERTZ = 3;
export const BUZZ_MAXIMUM_HERTZ = 7;

// The roaming waypoints' reach multiplier for this tightness.
export function roamScaleFor(tightness) {
  return 1 / (1 + tightness);
}

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

function clampDial(spec, value) {
  return Math.min(spec.maximum, Math.max(spec.minimum, value));
}

// Dials from a URL search string; a missing or malformed parameter takes the fallback's value.
export function feelFromSearch(search, fallback = BEES_FEEL) {
  const parameters = new URLSearchParams(search);
  const feel = { ...fallback };
  for (const spec of FEEL_DIALS) {
    const text = parameters.get(spec.parameter);
    if (text === null || text.trim() === '') continue;
    const value = Number(text);
    if (Number.isFinite(value)) feel[spec.key] = clampDial(spec, value);
  }
  return feel;
}

function formatDial(value) {
  return String(Math.round(value * 100) / 100);
}

// The query string (with the leading ?) that restores these dials.
export function feelToSearch(feel) {
  return `?${FEEL_DIALS.map((spec) => `${spec.parameter}=${formatDial(feel[spec.key])}`).join('&')}`;
}

// A search string with the dial parameters replaced by these dials' and every other parameter kept.
export function feelToSearchMerged(search, feel) {
  const parameters = new URLSearchParams(search);
  for (const spec of FEEL_DIALS) parameters.set(spec.parameter, formatDial(feel[spec.key]));
  return `?${parameters.toString()}`;
}
