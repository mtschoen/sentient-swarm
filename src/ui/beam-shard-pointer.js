// The beam shard pointer: a larger, throbbing arrowhead on the edge of the view for each beam shard
// that lies outside what the camera shows, so a shard reads as important next to the small pickup
// chevrons (edgeIndicators.js). Persistent DOM slots (BEAM_SHARD_POINTER_SLOTS, never added or
// removed during play) fade by opacity; the throb is a CSS animation on the inner element
// (beam-shard-pointer.css), so the outer slot's transform only positions and rotates.
import { MAXIMUM_BEAM_SHARDS_NEEDED } from '../game/beam-shards.js';
import { BEAM_SHARD_TYPE } from '../game/weaponTypes.js';
import { edgeIndicatorPlacement } from './edgeIndicators.js';

export const BEAM_SHARD_POINTER_SLOTS = MAXIMUM_BEAM_SHARDS_NEEDED;
// The inset clears the HUD's top row: the pause button ends about 38 px down, and a pointer's box
// reaches 17.5 px from its center at the top of its throb, so a shard straight above the view is
// drawn below the pause button instead of under it.
export const BEAM_SHARD_POINTER_INSET_CSS_PIXELS = 64;
// Under the HUD and its game-over backdrop, level with the edge indicators (edgeIndicators.js).
export const BEAM_SHARD_POINTER_LAYER_Z_INDEX = '4';
const CHEVRON_SIZE_CSS_PIXELS = 28;
// The reach of the chevron's box from its center at any rotation (half the diagonal), plus a margin.
const KEEP_OUT_REACH_CSS_PIXELS = CHEVRON_SIZE_CSS_PIXELS * Math.SQRT1_2 + 2;
const FADE = 'opacity 0.2s linear';

// Pickups of type beamshard as { x, y }, in order, at most one per slot. Whether a shard is inside
// the view is decided at update time.
export function beamShardTargets(pickups) {
  return pickups
    .filter((pickup) => pickup.type === BEAM_SHARD_TYPE)
    .slice(0, BEAM_SHARD_POINTER_SLOTS)
    .map(({ x, y }) => ({ x, y }));
}

// The pointer's center moved to the nearer side (up or right) that clears every keep-out rectangle
// (CSS pixels: the Settings button and the mute hint at the bottom left), padded by the chevron's
// reach at any rotation, so a pointer toward a corner is not drawn over a HUD control. No keep-out, no move.
export function clearOfKeepOuts(center, keepOuts, half = KEEP_OUT_REACH_CSS_PIXELS) {
  const boxes = keepOuts.filter((box) => box.right > box.left && box.bottom > box.top);
  if (boxes.length === 0) return center;
  const union = {
    left: Math.min(...boxes.map((box) => box.left)), top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)), bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
  const inside = center.left > union.left - half && center.left < union.right + half && center.top > union.top - half && center.top < union.bottom + half;
  if (!inside) return center;
  const up = { left: center.left, top: union.top - half };
  const right = { left: union.right + half, top: center.top };
  return center.top - up.top <= right.left - center.left ? up : right;
}

// parent: the element the layer is appended to (the layer is fixed, full-window, no pointer events).
export function createBeamShardPointers(parent, { documentObject = document } = {}) {
  const layer = documentObject.createElement('div');
  Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: BEAM_SHARD_POINTER_LAYER_Z_INDEX, overflow: 'hidden' });
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
    // targets from beamShardTargets; viewBounds and rect as edgeIndicatorPlacement takes them; keepOuts
    // are CSS rectangles (left, top, right, bottom) a pointer is moved clear of.
    update(targets, viewBounds, rect, keepOuts = []) {
      slots.forEach((element, index) => {
        const target = targets[index];
        const placement = target ? edgeIndicatorPlacement(target, viewBounds, rect, BEAM_SHARD_POINTER_INSET_CSS_PIXELS) : null;
        if (placement === null || !placement.visible) {
          element.style.opacity = '0';
          return;
        }
        element.style.opacity = '1';
        const { left, top } = clearOfKeepOuts(placement, keepOuts);
        element.style.transform = `translate(${left - CHEVRON_SIZE_CSS_PIXELS / 2}px, ${top - CHEVRON_SIZE_CSS_PIXELS / 2}px) rotate(${placement.angle}rad)`;
      });
    },
  };
}
