// The beam shard pointer: a larger, throbbing arrowhead on the edge of the view for each beam shard
// that lies outside what the camera shows, so a shard reads as important next to the small pickup
// chevrons (edgeIndicators.js). Persistent DOM slots (BEAM_SHARD_POINTER_SLOTS, never added or
// removed during play) fade by opacity; the throb is a CSS animation on the inner element
// (beam-shard-pointer.css), so the outer slot's transform only positions and rotates.
import { BEAM_SHARD_TYPE } from '../game/weaponTypes.js';
import { edgeIndicatorPlacement } from './edgeIndicators.js';

export const BEAM_SHARD_POINTER_SLOTS = 8;
export const BEAM_SHARD_POINTER_INSET_CSS_PIXELS = 40;
const CHEVRON_SIZE_CSS_PIXELS = 28;
const FADE = 'opacity 0.2s linear';

// Pickups of type beamshard as { x, y }, in order, at most one per slot. Whether a shard is inside
// the view is decided at update time.
export function beamShardTargets(pickups) {
  return pickups
    .filter((pickup) => pickup.type === BEAM_SHARD_TYPE)
    .slice(0, BEAM_SHARD_POINTER_SLOTS)
    .map(({ x, y }) => ({ x, y }));
}

// parent: the element the layer is appended to (the layer is fixed, full-window, no pointer events).
export function createBeamShardPointers(parent, { documentObject = document } = {}) {
  const layer = documentObject.createElement('div');
  Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '5', overflow: 'hidden' });
  const slots = Array.from({ length: BEAM_SHARD_POINTER_SLOTS }, () => {
    const element = documentObject.createElement('div');
    element.className = 'beam-shard-pointer';
    Object.assign(element.style, {
      position: 'absolute', left: '0', top: '0', width: `${CHEVRON_SIZE_CSS_PIXELS}px`, height: `${CHEVRON_SIZE_CSS_PIXELS}px`,
      opacity: '0', transition: FADE,
    });
    const chevron = documentObject.createElement('div');
    chevron.className = 'beam-shard-pointer-chevron';
    element.append(chevron);
    layer.append(element);
    return element;
  });
  parent.append(layer);
  return {
    element: layer,
    chevronSizeCssPixels: CHEVRON_SIZE_CSS_PIXELS,
    // targets from beamShardTargets; viewBounds and rect as edgeIndicatorPlacement takes them.
    update(targets, viewBounds, rect) {
      slots.forEach((element, index) => {
        const target = targets[index];
        const placement = target ? edgeIndicatorPlacement(target, viewBounds, rect, BEAM_SHARD_POINTER_INSET_CSS_PIXELS) : null;
        if (placement === null || !placement.visible) {
          element.style.opacity = '0';
          return;
        }
        element.style.opacity = '1';
        element.style.transform = `translate(${placement.left - CHEVRON_SIZE_CSS_PIXELS / 2}px, ${placement.top - CHEVRON_SIZE_CSS_PIXELS / 2}px) rotate(${placement.angle}rad)`;
      });
    },
  };
}
