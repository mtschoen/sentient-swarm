// Hives (stage 3) tuning, one frozen set of numbers. The lab is solo and cannot enter a two-seat
// mode, so these are not lab knobs: tuning them is a code edit here. hives.js reads them; the
// feeding reach also reaches projectiles_collide.wgsl through SHADER_CONSTANTS (layout.js).

// World units: a hive's disc, where its agents emerge and where ships capture it.
export const HIVE_RADIUS = 1.5;
// A kill inside this multiple of the hive radius from a hive the killer owns is on its feeding ground.
export const HIVE_FEEDING_REACH_SCALE = 2;

export const HIVE_TUNING = Object.freeze({
  radius: HIVE_RADIUS,
  // World units on y between a seat's start and its side hive (hives.js hiveSites).
  sideOffset: 4.5,
  // Capture progress (0 to 1) per second per ship of advantage (own ships in the disc minus the
  // opponent's): the 12-ship starting swarm parked on a hive takes 5 s.
  captureRatePerShip: 1 / 60,
  // The fastest capture: a swarm of 20 ships of advantage or more takes 3 s, never less.
  maximumCaptureRate: 1 / 3,
  // Progress lost per second while no ship of either seat is in the disc.
  decayRate: 0.1,
  // Seconds a seat must own every hive to win the match.
  holdSecondsToWin: 20,
  feedingReachScale: HIVE_FEEDING_REACH_SCALE,
  // A feeding ground kill counts this many times toward the killer's swarm growth.
  feedingGrowthMultiplier: 2,
});
