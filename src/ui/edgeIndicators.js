// Off-screen indicators: a chevron on the edge of the view for each pickup and for the wave gate
// the spawn director telegraphs (its telegraph above 0) while that target lies outside what the
// camera shows, pointing at it. Persistent DOM slots (EDGE_INDICATOR_SLOTS, never added or removed
// during play) fade by opacity, so nothing pops in or out of layout. edgeIndicatorPlacement is the
// pure geometry: world to CSS pixels through the view bounds and the arena rect, then the ray from
// the rect center to the target clamped to the rect inset by EDGE_INDICATOR_INSET_CSS_PIXELS.
import { PICKUP_HUES, WEAPON_HUES } from '../game/weaponTypes.js';

export const EDGE_INDICATOR_SLOTS = 12;
export const EDGE_INDICATOR_INSET_CSS_PIXELS = 24;
const CHEVRON_SIZE_CSS_PIXELS = 14;
const GATE_COLOR = 'hsl(8, 95%, 62%)';
const FADE = 'opacity 0.2s linear';

// { visible, left, top, angle } in CSS pixels and radians for target { x, y } (world units);
// viewBounds is the camera's world rectangle, rect { x, y, width, height } the CSS rectangle it is
// drawn into. visible is false while the target is inside the rect.
export function edgeIndicatorPlacement(target, viewBounds, rect, inset = EDGE_INDICATOR_INSET_CSS_PIXELS) {
  const cssX = rect.x + ((target.x - viewBounds.minX) / viewBounds.width) * rect.width;
  const cssY = rect.y + ((target.y - viewBounds.minY) / viewBounds.height) * rect.height;
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const offsetX = cssX - centerX;
  const offsetY = cssY - centerY;
  const angle = Math.atan2(offsetY, offsetX);
  if (cssX >= rect.x && cssX <= rect.x + rect.width && cssY >= rect.y && cssY <= rect.y + rect.height) {
    return { visible: false, left: cssX, top: cssY, angle };
  }
  const halfWidth = Math.max(0, rect.width / 2 - inset);
  const halfHeight = Math.max(0, rect.height / 2 - inset);
  const scaleX = offsetX === 0 ? Infinity : halfWidth / Math.abs(offsetX);
  const scaleY = offsetY === 0 ? Infinity : halfHeight / Math.abs(offsetY);
  const scale = Math.min(scaleX, scaleY);
  return { visible: true, left: centerX + offsetX * scale, top: centerY + offsetY * scale, angle };
}

// The targets to indicate: every pickup (colored by its hue), then every gate with a telegraph.
export function edgeIndicatorTargets(pickups, gates) {
  const targets = pickups.map((pickup) => ({ x: pickup.x, y: pickup.y, color: `hsl(${Math.round(360 * (WEAPON_HUES[pickup.type] ?? PICKUP_HUES[pickup.type] ?? 0))}, 90%, 66%)` }));
  for (const gate of gates) if (gate.telegraph > 0) targets.push({ x: gate.x, y: gate.y, color: GATE_COLOR });
  return targets.slice(0, EDGE_INDICATOR_SLOTS);
}

// parent: the element the slots live in (a fixed, full-window layer with no pointer events).
export function createEdgeIndicators(parent, { documentObject = document } = {}) {
  const layer = documentObject.createElement('div');
  Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '4', overflow: 'hidden' });
  const slots = Array.from({ length: EDGE_INDICATOR_SLOTS }, () => {
    const element = documentObject.createElement('div');
    Object.assign(element.style, {
      position: 'absolute', left: '0', top: '0', width: '0', height: '0', opacity: '0', transition: FADE,
      borderTop: `${CHEVRON_SIZE_CSS_PIXELS / 2}px solid transparent`, borderBottom: `${CHEVRON_SIZE_CSS_PIXELS / 2}px solid transparent`,
      borderLeft: `${CHEVRON_SIZE_CSS_PIXELS}px solid white`,
    });
    layer.append(element);
    return element;
  });
  parent.append(layer);
  return {
    element: layer,
    // targets from edgeIndicatorTargets; viewBounds and rect as edgeIndicatorPlacement takes them.
    update(targets, viewBounds, rect) {
      slots.forEach((element, index) => {
        const target = targets[index];
        const placement = target ? edgeIndicatorPlacement(target, viewBounds, rect) : null;
        if (placement === null || !placement.visible) {
          element.style.opacity = '0';
          return;
        }
        element.style.opacity = '0.9';
        element.style.borderLeftColor = target.color;
        element.style.transform = `translate(${placement.left - CHEVRON_SIZE_CSS_PIXELS / 2}px, ${placement.top - CHEVRON_SIZE_CSS_PIXELS / 2}px) rotate(${placement.angle}rad)`;
      });
    },
  };
}
