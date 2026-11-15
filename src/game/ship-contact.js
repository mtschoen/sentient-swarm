// Versus ship to ship contact, pure CPU: opposing swarm ships that touch both die, one for one.
// At most 256 by 256 pair tests a step, each a box test before the squared distance, so no grid is
// needed. One-for-one trades are size neutral: ramming is the smaller swarm's way to trade down.

// firstShips and secondShips: the two seats' alive ships as { slot, x, y }. Returns the touching
// pairs [{ first, second }] (slots), each ship in at most one pair: every first-seat ship, in order,
// takes the nearest unpaired second-seat ship within contactDistance.
export function contactPairs(firstShips, secondShips, contactDistance) {
  const pairs = [];
  if (firstShips.length === 0 || secondShips.length === 0) return pairs;
  const taken = new Set();
  const reachSquared = contactDistance * contactDistance;
  for (const first of firstShips) {
    let nearest = null;
    let nearestSquared = reachSquared;
    for (const second of secondShips) {
      if (taken.has(second.slot)) continue;
      const offsetX = second.x - first.x;
      if (offsetX > contactDistance || offsetX < -contactDistance) continue;
      const offsetY = second.y - first.y;
      if (offsetY > contactDistance || offsetY < -contactDistance) continue;
      const squared = offsetX * offsetX + offsetY * offsetY;
      if (squared <= nearestSquared) {
        nearest = second;
        nearestSquared = squared;
      }
    }
    if (nearest !== null) {
      taken.add(nearest.slot);
      pairs.push({ first: first.slot, second: nearest.slot });
    }
  }
  return pairs;
}
