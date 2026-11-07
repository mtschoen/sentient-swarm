// The shared first 32 bytes of every world-space render uniform (ship, projectiles, pickups):
//   0 worldToClipScale    vec2f
//   8 worldToClipOffset   vec2f
//  16 devicePixelToClip   vec2f
//  24 time                f32
//  28 pixelScale          f32 (the inspect zoom, for widths that are fixed in device pixels)
// World to clip is affine, so two worldToClip samples give its scale and offset (inspect zoom included).
export const WORLD_VIEW_FLOATS = 8;

export function packWorldView(viewport, time, target = new Float32Array(WORLD_VIEW_FLOATS), offset = 0) {
  const origin = viewport.worldToClip(0, 0);
  const unit = viewport.worldToClip(1, 1);
  target.set([
    unit.x - origin.x, unit.y - origin.y,
    origin.x, origin.y,
    2 / viewport.canvasWidth, 2 / viewport.canvasHeight,
    time, viewport.inspectZoom,
  ], offset);
  return target;
}

// Max, not add: the scene target is the trail history, so an additive draw of something that sits
// still (the beam, a pickup, the ship at rest) would pile up to 1 / (1 - trailDecay) times its
// brightness. Max settles at the drawn value and still leaves a fading trail when it moves.
export const MAX_BLEND = Object.freeze({
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
});
