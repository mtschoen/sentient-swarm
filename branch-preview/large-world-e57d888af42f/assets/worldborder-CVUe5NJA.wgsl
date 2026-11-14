// World border: the rectangle of the world's edge as a bright line with a soft glow, drawn into the
// warp grid layer (cleared every frame, never copied by the trail decay, so it cannot smear when the
// camera moves) and added into the bloom. Four instances (top, bottom, left, right), one quad of six
// vertices each. A quad spans the edge plus BORDER_PIXEL_EXTENT device pixels past each end and that
// far to both sides; the fragment shader turns its pixel distance from the edge into a thin core
// plus a glow, so the line keeps one device-pixel thickness whatever the zoom or window size.
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
  // Signed device pixels from the edge line.
  @location(0) acrossPixels: f32,
}

// The quad corners as (along, across) in {0, 1} by {-1, 1}, two triangles.
const CORNERS = array<vec2f, 6>(
  vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(0.0, 1.0),
  vec2f(0.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
);

@vertex
fn borderVertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) edge: u32) -> BorderVaryings {
  let corner = CORNERS[vertexIndex];
  let world = vec2f(WORLD_WIDTH, WORLD_HEIGHT);
  // Edges 0 and 1 run along x at y = 0 and y = WORLD_HEIGHT; edges 2 and 3 along y at x = 0 and x = WORLD_WIDTH.
  let horizontal = edge < 2u;
  let atFar = (edge % 2u) == 1u;
  let reachPixels = view.glowPixels;
  var along = vec2f(1.0, 0.0);
  var across = vec2f(0.0, 1.0);
  var start = vec2f(0.0, select(0.0, world.y, atFar));
  var edgeLength = world.x;
  if (!horizontal) {
    along = vec2f(0.0, 1.0);
    across = vec2f(1.0, 0.0);
    start = vec2f(select(0.0, world.x, atFar), 0.0);
    edgeLength = world.y;
  }
  let edgePoint = start + along * edgeLength * corner.x;
  let clip = edgePoint * view.worldToClipScale + view.worldToClipOffset;
  // The quad runs reachPixels past both ends so corners keep their glow.
  let alongPixels = (corner.x * 2.0 - 1.0) * reachPixels;
  let offset = (along * alongPixels + across * corner.y * reachPixels) * view.clipPerPixel * vec2f(1.0, -1.0);
  var output: BorderVaryings;
  output.position = vec4f(clip + offset, 0.0, 1.0);
  output.acrossPixels = corner.y * reachPixels;
  return output;
}

@fragment
fn borderFragment(input: BorderVaryings) -> @location(0) vec4f {
  let distance = abs(input.acrossPixels);
  let core = 1.0 - smoothstep(view.coreHalfPixels - 0.75, view.coreHalfPixels + 0.75, distance);
  let reach = 1.0 - smoothstep(view.glowPixels * 0.5, view.glowPixels, distance);
  let glow = exp(-GLOW_FALLOFF * distance / view.glowPixels) * reach;
  return vec4f(CORE_COLOR * CORE_INTENSITY * core + GLOW_COLOR * GLOW_INTENSITY * glow, 0.0);
}
