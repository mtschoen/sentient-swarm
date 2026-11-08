// Shared helpers of the instanced quad shaders (gates, glyphs, particles, pickups, projectiles and
// the ship), prepended after common.wgsl by loadQuadHeader in render-shaders.js.

// Antialiasing width of the world-space silhouettes, in device pixels.
const PIXEL_FEATHER: f32 = 0.75;

// Corner of a 4-vertex triangle strip quad: (-1, -1), (1, -1), (-1, 1), (1, 1) for vertices 0 to 3.
fn quadCorner(vertexIndex: u32) -> vec2f {
  return vec2f(f32(vertexIndex & 1u), f32(vertexIndex >> 1u)) * 2.0 - vec2f(1.0);
}

// PIXEL_FEATHER device pixels in world units, from a world view's devicePixelToClip and
// worldToClipScale (world-view.js).
fn worldFeather(devicePixelToClip: vec2f, worldToClipScale: vec2f) -> f32 {
  return max(abs(devicePixelToClip.x / worldToClipScale.x), 1e-5) * PIXEL_FEATHER;
}

// Distance from point to the segment from start to end.
fn segmentDistance(point: vec2f, start: vec2f, end: vec2f) -> f32 {
  let along = point - start;
  let segment = end - start;
  let fraction = clamp(dot(along, segment) / dot(segment, segment), 0.0, 1.0);
  return length(along - segment * fraction);
}
