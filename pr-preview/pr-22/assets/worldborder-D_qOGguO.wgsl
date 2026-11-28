// World border: the rectangle of the world's edge as a bright line with a soft glow, drawn into the
// warp grid layer (cleared every frame, never copied by the trail decay, so it cannot smear when the
// camera moves) and added into the bloom. One quad of six vertices covers the world rectangle plus
// glowPixels device pixels on every side; the fragment shader works from the device-pixel offset
// of the fragment from the rectangle's center, so the line keeps one device-pixel thickness
// whatever the zoom or window size and each pixel is lit once (no overlap at the corners). The core
// uses the Chebyshev distance to the outline (square corners, a sharp right angle); the glow uses
// the Euclidean one (it rounds off around the outside of a corner).
// Common header prepended.

// Uniform layout (byte offsets), 32 bytes; packWorldBorder in world-border.js writes it.
//   0 worldToClipScale   vec2f
//   8 worldToClipOffset  vec2f
//  16 clipPerPixel       vec2f   clip units per device pixel on x and y
//  24 coreHalfPixels     f32     half the core line's width in device pixels
//  28 glowPixels         f32     how far the glow reaches from the edge in device pixels
struct BorderView {
  worldToClipScale: vec2f,
  worldToClipOffset: vec2f,
  clipPerPixel: vec2f,
  coreHalfPixels: f32,
  glowPixels: f32,
}

@group(0) @binding(0) var<uniform> view: BorderView;

// HDR: the composite exposes and blooms the grid layer with the scene.
const CORE_COLOR: vec3f = vec3f(0.7, 0.95, 1.0);
const CORE_INTENSITY: f32 = 2.5;
const GLOW_COLOR: vec3f = vec3f(0.15, 0.55, 1.0);
const GLOW_INTENSITY: f32 = 0.9;
// Glow falloff rate: the glow is GLOW_INTENSITY at the core and exp(-GLOW_FALLOFF) at glowPixels.
const GLOW_FALLOFF: f32 = 3.0;

struct BorderVaryings {
  @builtin(position) position: vec4f,
  // Device pixels from the world rectangle's center.
  @location(0) pixelOffset: vec2f,
}

// The quad's corners in {0, 1} by {0, 1}, two triangles.
const CORNERS = array<vec2f, 6>(
  vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
  vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
);

// Device pixels per world unit on each axis.
fn pixelsPerUnit() -> vec2f {
  return abs(view.worldToClipScale) / view.clipPerPixel;
}

@vertex
fn borderVertex(@builtin(vertex_index) vertexIndex: u32) -> BorderVaryings {
  let world = vec2f(WORLD_WIDTH, WORLD_HEIGHT);
  let scale = pixelsPerUnit();
  let margin = vec2f(view.glowPixels) / scale;
  let position = CORNERS[vertexIndex] * (world + 2.0 * margin) - margin;
  var output: BorderVaryings;
  output.position = vec4f(position * view.worldToClipScale + view.worldToClipOffset, 0.0, 1.0);
  output.pixelOffset = (position - world * 0.5) * scale;
  return output;
}

@fragment
fn borderFragment(input: BorderVaryings) -> @location(0) vec4f {
  let halfSize = vec2f(WORLD_WIDTH, WORLD_HEIGHT) * 0.5 * pixelsPerUnit();
  // Negative inside the rectangle on an axis, positive outside it.
  let beyond = abs(input.pixelOffset) - halfSize;
  let squareDistance = abs(max(beyond.x, beyond.y));
  let roundDistance = abs(length(max(beyond, vec2f(0.0))) + min(max(beyond.x, beyond.y), 0.0));
  let core = 1.0 - smoothstep(view.coreHalfPixels - 0.75, view.coreHalfPixels + 0.75, squareDistance);
  let reach = 1.0 - smoothstep(view.glowPixels * 0.5, view.glowPixels, roundDistance);
  let glow = exp(-GLOW_FALLOFF * roundDistance / view.glowPixels) * reach;
  return vec4f(CORE_COLOR * CORE_INTENSITY * core + GLOW_COLOR * GLOW_INTENSITY * glow, 0.0);
}
