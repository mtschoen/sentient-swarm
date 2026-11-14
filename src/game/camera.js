// Follow camera: a center in world units and a zoom (1 unless a targetZoom is passed) that the renderer's Viewport
// draws around. Pure: no GPU, DOM or clock; time is the deltaSeconds passed to update, and nothing
// here is random. The simulation never reads the camera (spawning, walls and kills use the world).
// update(deltaSeconds, { focusX, focusY, viewWidth, viewHeight, bounds, targetZoom = 1 }) moves the
// center toward the focus (the view extents below are viewWidth / zoom and viewHeight / zoom; the
// zoom eases to targetZoom by the same closed form with CAMERA_ZOOM_SMOOTH_SECONDS, clamped to
// [MINIMUM_CAMERA_ZOOM, 1]; the solo game never passes a target, so its zoom stays exactly 1):
//   - dead zone: a focus within deadZoneFraction of the view's width and height of the current
//     center (on each axis) does not move the camera; past it the target is the focus less the
//     dead zone, so the focus sits on the zone's edge;
//   - the target is clamped so the view stays inside bounds extended by CAMERA_OVERSHOOT_FRACTION
//     of the view's extent on that axis (the overshoot: the world's edge can scroll that far in
//     from the screen edge, so a border drawn there is seen coming and the swarm pressed against
//     it sits clear of the screen edge; on an axis where the view is at least as large as bounds
//     the view centers on bounds, no overshoot), before smoothing, so the camera eases into an
//     edge instead of stopping dead;
//   - a critically damped spring with the exact closed form (frame-rate independent) moves the
//     center to the target: omega = 2 / smoothSeconds, so a step change covers 1 - 3 e^-2, about
//     60 percent, in smoothSeconds and about 98 percent in 3 smoothSeconds, never overshooting;
//   - the result is clamped again, so the view never leaves the overshoot limit.
// cut(focusX, focusY, view) jumps to the clamped focus with zero velocity (run start and respawn).
// sample(alpha) is the center extrapolated by alpha of the last update's delta along the velocity,
// clamped like update, for rendering between fixed updates (glyphs extrapolate the same way).
// cameraFocus blends the controlled point with the swarm centroid by CAMERA_POINT_WEIGHT: the ships
// leash to the point but lag it, so the blend keeps the swarm, not just the point, in view.
// bombRadiusForView is BOMB_VIEW_HALF_DIAGONALS view half-diagonals: the bomb clears what the
// camera sees plus a margin around the swarm.
export const CAMERA_SMOOTH_SECONDS = 0.3;
export const CAMERA_DEAD_ZONE_FRACTION = 0.1;
// Fraction of the view's width (or height) the view may extend past the world's edge.
export const CAMERA_OVERSHOOT_FRACTION = 0.12;
export const CAMERA_POINT_WEIGHT = 0.5;
export const MINIMUM_CAMERA_ZOOM = 0.5;
export const CAMERA_ZOOM_SMOOTH_SECONDS = 0.5;
// World units kept around the focuses when fitting several of them.
export const CAMERA_FIT_MARGIN = 2.5;
export const BOMB_VIEW_HALF_DIAGONALS = 1.2;

// The point the camera follows: point is { x, y }, centroid { x, y } or null (no ship alive).
export function cameraFocus(point, centroid) {
  if (centroid === null) return { x: point.x, y: point.y };
  return {
    x: CAMERA_POINT_WEIGHT * point.x + (1 - CAMERA_POINT_WEIGHT) * centroid.x,
    y: CAMERA_POINT_WEIGHT * point.y + (1 - CAMERA_POINT_WEIGHT) * centroid.y,
  };
}

// The zoom that shows every focus ({ x, y }) with margin on each side: 1 for zero or one focus.
export function fitZoom(focuses, viewWidth, viewHeight, margin = CAMERA_FIT_MARGIN) {
  if (focuses.length < 2) return 1;
  const box = boundingBox(focuses);
  const spanX = box.maxX - box.minX + 2 * margin;
  const spanY = box.maxY - box.minY + 2 * margin;
  return Math.max(MINIMUM_CAMERA_ZOOM, Math.min(1, viewWidth / spanX, viewHeight / spanY));
}

// The center of the focuses' bounding box.
export function framingCenter(focuses) {
  const box = boundingBox(focuses);
  return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
}

function boundingBox(focuses) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const focus of focuses) {
    minX = Math.min(minX, focus.x);
    minY = Math.min(minY, focus.y);
    maxX = Math.max(maxX, focus.x);
    maxY = Math.max(maxY, focus.y);
  }
  return { minX, minY, maxX, maxY };
}

export function bombRadiusForView(width, height) {
  return BOMB_VIEW_HALF_DIAGONALS * Math.hypot(width, height) / 2;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

// The center on one axis that keeps a view of size extent inside [minimum, maximum] widened by
// the overshoot on each side.
function clampAxis(center, extent, minimum, maximum) {
  if (extent >= maximum - minimum) return (minimum + maximum) / 2;
  const reach = extent / 2 - CAMERA_OVERSHOOT_FRACTION * extent;
  return clamp(center, minimum + reach, maximum - reach);
}

// The focus less the dead zone of half extent halfZone around center, on one axis.
function deadZoneTarget(center, focus, halfZone) {
  if (focus > center + halfZone) return focus - halfZone;
  if (focus < center - halfZone) return focus + halfZone;
  return center;
}

// One axis of the critically damped spring over deltaSeconds; returns [value, velocity].
export function criticallyDampedStep(value, velocity, target, omega, deltaSeconds) {
  const offset = value - target;
  const blend = velocity + omega * offset;
  const decay = Math.exp(-omega * deltaSeconds);
  return [target + (offset + blend * deltaSeconds) * decay, (velocity - omega * blend * deltaSeconds) * decay];
}

export class Camera {
  constructor({ centerX = 0, centerY = 0, smoothSeconds = CAMERA_SMOOTH_SECONDS, deadZoneFraction = CAMERA_DEAD_ZONE_FRACTION } = {}) {
    if (!(smoothSeconds > 0)) throw new RangeError(`smoothSeconds must be above 0, got ${smoothSeconds}`);
    if (!(deadZoneFraction >= 0 && deadZoneFraction < 0.5)) throw new RangeError(`deadZoneFraction must lie in [0, 0.5), got ${deadZoneFraction}`);
    this.smoothSeconds = smoothSeconds;
    this.deadZoneFraction = deadZoneFraction;
    this.centerX = centerX;
    this.centerY = centerY;
    this.velocityX = 0;
    this.velocityY = 0;
    this.zoom = 1;
    this.zoomVelocity = 0;
    this.lastDeltaSeconds = 0;
    this.lastView = null;
  }

  update(deltaSeconds, { focusX, focusY, viewWidth, viewHeight, bounds, targetZoom = 1 }) {
    const omega = 2 / this.smoothSeconds;
    [this.zoom, this.zoomVelocity] = criticallyDampedStep(this.zoom, this.zoomVelocity, clamp(targetZoom, MINIMUM_CAMERA_ZOOM, 1), 2 / CAMERA_ZOOM_SMOOTH_SECONDS, deltaSeconds);
    this.zoom = clamp(this.zoom, MINIMUM_CAMERA_ZOOM, 1);
    const extentX = viewWidth / this.zoom;
    const extentY = viewHeight / this.zoom;
    const targetX = clampAxis(deadZoneTarget(this.centerX, focusX, this.deadZoneFraction * extentX), extentX, bounds.minX, bounds.maxX);
    const targetY = clampAxis(deadZoneTarget(this.centerY, focusY, this.deadZoneFraction * extentY), extentY, bounds.minY, bounds.maxY);
    [this.centerX, this.velocityX] = criticallyDampedStep(this.centerX, this.velocityX, targetX, omega, deltaSeconds);
    [this.centerY, this.velocityY] = criticallyDampedStep(this.centerY, this.velocityY, targetY, omega, deltaSeconds);
    this.centerX = clampAxis(this.centerX, extentX, bounds.minX, bounds.maxX);
    this.centerY = clampAxis(this.centerY, extentY, bounds.minY, bounds.maxY);
    this.lastDeltaSeconds = deltaSeconds;
    this.lastView = { viewWidth, viewHeight, bounds };
  }

  cut(focusX, focusY, { viewWidth, viewHeight, bounds, zoom = 1 }) {
    this.zoom = clamp(zoom, MINIMUM_CAMERA_ZOOM, 1);
    this.zoomVelocity = 0;
    this.centerX = clampAxis(focusX, viewWidth / this.zoom, bounds.minX, bounds.maxX);
    this.centerY = clampAxis(focusY, viewHeight / this.zoom, bounds.minY, bounds.maxY);
    this.velocityX = 0;
    this.velocityY = 0;
    this.lastDeltaSeconds = 0;
    this.lastView = { viewWidth, viewHeight, bounds };
  }

  // { centerX, centerY, zoom } for Viewport.setCamera; alpha in [0, 1] of the last update's delta.
  sample(alpha = 0) {
    const seconds = alpha * this.lastDeltaSeconds;
    let centerX = this.centerX + this.velocityX * seconds;
    let centerY = this.centerY + this.velocityY * seconds;
    const zoom = clamp(this.zoom + this.zoomVelocity * seconds, MINIMUM_CAMERA_ZOOM, 1);
    if (this.lastView !== null) {
      const { viewWidth, viewHeight, bounds } = this.lastView;
      centerX = clampAxis(centerX, viewWidth / zoom, bounds.minX, bounds.maxX);
      centerY = clampAxis(centerY, viewHeight / zoom, bounds.minY, bounds.maxY);
    }
    return { centerX, centerY, zoom };
  }
}
