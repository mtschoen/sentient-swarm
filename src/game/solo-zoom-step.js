// The solo zoom's per-update step, taking the Game as context (like seats.js): decides whether the
// solo controller drives the camera this update and, if so, returns the camera's zoom options.
// Returns null (and resets the controller) for everything else, so the caller takes today's path:
// the feature off (the default), reduced motion, no or two live seats, Ready, Game over and watch mode.
import { DENSITY_REFERENCE_CAPACITY } from '../sim/species.js';
import { MINIMUM_CAMERA_ZOOM } from './camera.js';
import { RunPhase } from './run.js';
import { liveSeats } from './seats.js';
import { sampleZoomPressure } from './zoom-pressure.js';

// The largest distance from the focus to an alive ship (0 with none).
function swarmRadiusAround(seat, focus) {
  let largest = 0;
  for (const ship of seat.swarm.ships) {
    largest = Math.max(largest, Math.hypot(ship.x - focus.x, ship.y - focus.y));
  }
  return largest;
}

// The target zoom is held (no pressure sampling, no controller state change) during a bomb, while
// the time warp eases, and outside Playing (Dying and Respawning keep the last zoom).
function holds(game) {
  return game.bombedThisUpdate || (game.timeWarp.active && game.timeWarp.strength < 1) || game.run.phase !== RunPhase.Playing;
}

export function soloZoomOptions(game, deltaSeconds) {
  const controller = game.soloZoom;
  const settings = controller.settings;
  const phase = game.run.phase;
  const inRun = phase === RunPhase.Playing || phase === RunPhase.Dying || phase === RunPhase.Respawning;
  const live = liveSeats(game.seats);
  if (!settings.enabled || game.reducedMotion || game.watching || !inRun || live.length !== 1) {
    controller.reset();
    return null;
  }
  const seat = live[0];
  const focus = seat.cameraFocus;
  let targetZoom;
  if (holds(game)) targetZoom = controller.hold();
  else {
    const { near, far } = sampleZoomPressure({
      densityAt: game.densityAt,
      focusX: focus.x,
      focusY: focus.y,
      viewWidth: game.view.width,
      viewHeight: game.view.height,
      bounds: game.worldBounds,
      capacityScale: game.simulation.capacity / DENSITY_REFERENCE_CAPACITY,
      crowdReference: settings.crowdReference,
    });
    targetZoom = controller.update(deltaSeconds, {
      near,
      far,
      swarmRadius: swarmRadiusAround(seat, focus),
      viewWidth: game.viewSize.width,
      viewHeight: game.viewSize.height,
    });
  }
  return { targetZoom, zoomMinimum: settings.minimum, zoomMaximum: settings.maximum, zoomSmoothSeconds: settings.smoothSeconds };
}

// A zoom outside the default range is more than this away before the limits are widened.
const OUT_OF_RANGE_TOLERANCE = 1e-3;

// Camera.update clamps hard to the limits it is passed. After the solo zoom ends (a seat revives, the
// knob turns off, reduced motion turns on) the camera may still sit above 1 (or below the co-op floor),
// so the non-solo call widens the limits to the current zoom and the spring eases back with no pop;
// once the zoom is inside the default range (within a thousandth) this is {}, today's exact call.
export function easeOutLimits(camera) {
  const options = {};
  if (camera.zoom > 1 + OUT_OF_RANGE_TOLERANCE) options.zoomMaximum = camera.zoom;
  if (camera.zoom < MINIMUM_CAMERA_ZOOM - OUT_OF_RANGE_TOLERANCE) options.zoomMinimum = camera.zoom;
  return options;
}
