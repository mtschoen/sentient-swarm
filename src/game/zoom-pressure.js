// Zoom pressure sampler for the solo camera zoom: pure, no GPU, DOM or clock. It turns the CPU density
// map (Game.densityAt, the newest 64 by 36 readback) into two preset-invariant pressures in 0..1:
// near (crowding around the focus) and far (action just outside the current view). Each is a ring
// mean of density divided by capacityScale (capacity / DENSITY_REFERENCE_CAPACITY) and the crowd
// reference, then passed through a smoothstep.
export const ZOOM_NEAR_RADIUS = 3.0;
export const ZOOM_FAR_VIEW_FACTOR = 1.1;
export const ZOOM_SAMPLE_POINTS = 8;
// Uncalibrated placeholder: the density that reads as full crowding at the reference capacity.
// To be measured in the browser lane (read Game.densityAt at the swarm near a heavy crowd at
// capacity 524288); until then the lab knob soloZoomCrowdReference is the way to tune it.
export const ZOOM_DEFAULT_CROWD_REFERENCE = 1;

const NEAR_EDGES = [0.25, 1.0];
const FAR_EDGES = [0.15, 0.6];

// 0 at or below lower, 1 at or above upper, the cubic ease between.
export function smoothstep(lower, upper, value) {
  const fraction = Math.min(1, Math.max(0, (value - lower) / (upper - lower)));
  return fraction * fraction * (3 - 2 * fraction);
}

function insideBounds(x, y, bounds) {
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
}

// The mean density over ZOOM_SAMPLE_POINTS points evenly spaced by angle from 0 on a circle, skipping
// points outside bounds; extraSamples are always counted. Returns 0 when nothing was sampled.
function ringMean(densityAt, centerX, centerY, radius, bounds, extraSamples = []) {
  let sum = 0;
  let count = 0;
  for (const value of extraSamples) {
    sum += value;
    count += 1;
  }
  for (let index = 0; index < ZOOM_SAMPLE_POINTS; index += 1) {
    const angle = (index / ZOOM_SAMPLE_POINTS) * 2 * Math.PI;
    const x = centerX + radius * Math.cos(angle);
    const y = centerY + radius * Math.sin(angle);
    if (!insideBounds(x, y, bounds)) continue;
    sum += densityAt(x, y);
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

// viewWidth and viewHeight are the current zoomed view extents (the far ring sits just outside what
// is on screen now).
export function sampleZoomPressure({ densityAt, focusX, focusY, viewWidth, viewHeight, bounds, capacityScale, crowdReference }) {
  const normalizer = capacityScale * crowdReference;
  if (!(normalizer > 0)) throw new RangeError(`capacityScale times crowdReference must be above 0, got ${normalizer}`);
  const nearMean = ringMean(densityAt, focusX, focusY, ZOOM_NEAR_RADIUS, bounds, [densityAt(focusX, focusY)]);
  const farRadius = ZOOM_FAR_VIEW_FACTOR * Math.hypot(viewWidth, viewHeight) / 2;
  const farMean = ringMean(densityAt, focusX, focusY, farRadius, bounds);
  return {
    near: smoothstep(NEAR_EDGES[0], NEAR_EDGES[1], nearMean / normalizer),
    far: smoothstep(FAR_EDGES[0], FAR_EDGES[1], farMean / normalizer),
  };
}
