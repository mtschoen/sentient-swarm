// The swarm's fire rate law (pure): the whole swarm fires an aggregate number of shots per second that
// grows sublinearly with its size, and each ship's interval is the swarm size divided by that aggregate.
//   aggregateShotsPerSecond = baseShotsPerSecond * (shipCount / REFERENCE_SWARM_SHIPS) ^ exponent
// An exponent of 0 gives a fixed aggregate served across the ships in rotation.

// The swarm size the per-kind base rates are stated for (INITIAL_SWARM_SHIPS).
export const REFERENCE_SWARM_SHIPS = 12;

export function aggregateShotsPerSecond(baseShotsPerSecond, exponent, shipCount) {
  if (shipCount <= 0) return 0;
  return baseShotsPerSecond * (shipCount / REFERENCE_SWARM_SHIPS) ** exponent;
}

// Seconds between one ship's shots (before the per-slot cooldown jitter); Infinity when nothing fires.
export function perShipInterval(baseShotsPerSecond, exponent, shipCount) {
  const aggregate = aggregateShotsPerSecond(baseShotsPerSecond, exponent, shipCount);
  return aggregate > 0 ? shipCount / aggregate : Infinity;
}
