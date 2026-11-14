// Drawn positions between fixed steps, matching Camera.sample(alpha): the last step's position
// extrapolated by alpha of one step along the step's movement (current less previous), so the
// ships and the camera that frames them agree exactly and the trails do not stamp the difference.
// A ship with no previous position (just spawned, or after a reset) has previous equal to current
// and so does not move. Pure: no clock, nothing random.

export function blendedCoordinate(current, previous, alpha) {
  return current + (current - previous) * alpha;
}

// Fills out (reused entries { x, y, ... }) from ships carrying x, y, previousX and previousY; the
// other fields are copied as they are. Returns out, trimmed to ships.length.
export function blendShips(ships, alpha, out) {
  out.length = ships.length;
  ships.forEach((ship, index) => {
    const entry = out[index] ?? (out[index] = {});
    Object.assign(entry, ship);
    entry.x = blendedCoordinate(ship.x, ship.previousX, alpha);
    entry.y = blendedCoordinate(ship.y, ship.previousY, alpha);
  });
  return out;
}

// The controlled point's drawn position: its velocity carried for alpha of the camera's last delta
// (zero after a cut), exactly as Camera.sample extrapolates the center.
export function blendedPoint(position, velocityX, velocityY, alpha, lastDeltaSeconds) {
  const seconds = alpha * lastDeltaSeconds;
  return { x: position.x + velocityX * seconds, y: position.y + velocityY * seconds };
}
