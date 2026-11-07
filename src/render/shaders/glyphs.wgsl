// Agent glyphs: one instance per agent slot, a 4-vertex triangle strip pulled from the agent
// buffer. Dead agents collapse to a degenerate quad. Common header prepended.
// The quad is glyphDevicePixels * glowScale device pixels wide, rotated to face the velocity;
// local coordinates put the glyph body inside radius 1 and the glow out to radius glowScale.
// Position is extrapolated by velocity * alpha * dt so rendering between fixed steps stays smooth.

// Uniform layout (byte offsets), total 48 bytes; packGlyphView in glyphs.js writes it.
//   0 worldToClipScale    vec2f
//   8 worldToClipOffset   vec2f
//  16 devicePixelToClip   vec2f
//  24 glyphDevicePixels   f32 (already multiplied by the inspect zoom)
//  28 glowScale           f32
//  32 alpha               f32
//  36 time                f32
//  40 padding             vec2f
struct GlyphView {
  worldToClipScale: vec2f,
  worldToClipOffset: vec2f,
  devicePixelToClip: vec2f,
  glyphDevicePixels: f32,
  glowScale: f32,
  alpha: f32,
  time: f32,
  padding: vec2f,
}

@group(0) @binding(0) var<uniform> view: GlyphView;
@group(0) @binding(1) var<uniform> params: SimParams;
@group(0) @binding(2) var<storage, read> agents: array<Agent>;
@group(0) @binding(3) var<storage, read> field: array<vec4f>;
@group(0) @binding(4) var<storage, read> speciesTable: array<f32>;

const HUE_JITTER_RANGE: f32 = 0.03;
const GLYPH_SATURATION: f32 = 0.8;
const DENSITY_ATTENUATION: f32 = 0.02;
const GLOW_INTENSITY: f32 = 0.35;
const GLOW_FALLOFF: f32 = 2.5;
const SPAWN_PULSE_RATE: f32 = 18.0;

struct GlyphVaryings {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) color: vec3f,
  @location(2) @interpolate(flat) shape: u32,
}

@vertex
fn glyphVertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> GlyphVaryings {
  var output: GlyphVaryings;
  let agent = agents[instanceIndex];
  if (!isAlive(agent.flags)) {
    output.position = vec4f(2.0, 2.0, 0.0, 1.0);
    output.local = vec2f(0.0);
    output.color = vec3f(0.0);
    output.shape = 0u;
    return output;
  }
  let corner = vec2f(f32(vertexIndex & 1u), f32(vertexIndex >> 1u)) * 2.0 - vec2f(1.0);
  let position = clampToArena(agent.position + agent.velocity * view.alpha * params.dt);
  let speed = length(agent.velocity);
  let forward = select(vec2f(1.0, 0.0), agent.velocity / max(speed, 1e-6), speed > 1e-5);
  let side = vec2f(-forward.y, forward.x);
  // World and device pixels both grow y downward, so the world direction is the screen direction.
  let offsetDevicePixels = (forward * corner.x + side * corner.y) * (0.5 * view.glyphDevicePixels * view.glowScale);
  let center = position * view.worldToClipScale + view.worldToClipOffset;
  output.position = vec4f(center + offsetDevicePixels * view.devicePixelToClip * vec2f(1.0, -1.0), 0.0, 1.0);
  output.local = corner * view.glowScale;

  let hue = speciesTable[speciesFieldIndex(agent.species, SPECIES_FIELD_HUE)];
  let rgb = hsvToRgb(fract(hue + agent.hueJitter * HUE_JITTER_RANGE), GLYPH_SATURATION, 1.0);
  let spawning = spawnFramesRemaining(agent.flags) > 0u;
  let calmPulse = 0.85 + 0.15 * sin(agent.phase);
  let spawnPulse = 0.5 + 0.5 * sin(agent.phase + view.time * SPAWN_PULSE_RATE);
  let cell = coarseCellIndexFor(position);
  let densities = field[cell * 2u];
  let localDensity = densities.x + densities.y + densities.z + densities.w + field[cell * 2u + 1u].x;
  var alpha = select(calmPulse, spawnPulse, spawning) / (1.0 + DENSITY_ATTENUATION * localDensity);
  if (spawning) {
    alpha *= 0.5;
  }
  output.color = rgb * alpha;
  output.shape = agent.species;
  return output;
}

fn boxDistance(point: vec2f, halfExtent: vec2f) -> f32 {
  let outside = abs(point) - halfExtent;
  return length(max(outside, vec2f(0.0))) + min(max(outside.x, outside.y), 0.0);
}

fn segmentDistance(point: vec2f, start: vec2f, end: vec2f) -> f32 {
  let along = point - start;
  let segment = end - start;
  let fraction = clamp(dot(along, segment) / dot(segment, segment), 0.0, 1.0);
  return length(along - segment * fraction);
}

// Equilateral triangle pointing along +x (Inigo Quilez, axes swapped so its apex faces forward).
fn triangleDistance(point: vec2f) -> f32 {
  let squareRootThree = sqrt(3.0);
  let radius = 0.87;
  var folded = vec2f(abs(point.y) - radius, point.x + radius / squareRootThree);
  if (folded.x + squareRootThree * folded.y > 0.0) {
    folded = vec2f(folded.x - squareRootThree * folded.y, -squareRootThree * folded.x - folded.y) / 2.0;
  }
  folded.x -= clamp(folded.x, -2.0 * radius, 0.0);
  return -length(folded) * sign(folded.y);
}

fn diamondDistance(point: vec2f) -> f32 {
  let halfLength = 1.0;
  let halfWidth = 0.55;
  let folded = abs(point);
  return (folded.x * halfWidth + folded.y * halfLength - halfLength * halfWidth) / length(vec2f(halfLength, halfWidth));
}

fn crossDistance(point: vec2f) -> f32 {
  return min(boxDistance(point, vec2f(0.95, 0.22)), boxDistance(point, vec2f(0.22, 0.95)));
}

fn chevronDistance(point: vec2f) -> f32 {
  let tip = vec2f(0.75, 0.0);
  let upper = segmentDistance(point, vec2f(-0.6, -0.8), tip);
  let lower = segmentDistance(point, vec2f(-0.6, 0.8), tip);
  return min(upper, lower) - 0.18;
}

// Regular pentagon outline (Inigo Quilez pentagon, apothem 0.75), apex along +x.
fn pentagonOutlineDistance(point: vec2f) -> f32 {
  let folding = vec3f(0.809016994, 0.587785252, 0.726542528);
  let apothem = 0.75;
  var folded = vec2f(abs(point.y), -point.x);
  folded -= 2.0 * min(dot(vec2f(-folding.x, folding.y), folded), 0.0) * vec2f(-folding.x, folding.y);
  folded -= 2.0 * min(dot(vec2f(folding.x, folding.y), folded), 0.0) * vec2f(folding.x, folding.y);
  folded -= vec2f(clamp(folded.x, -apothem * folding.z, apothem * folding.z), apothem);
  return abs(length(folded) * sign(folded.y)) - 0.16;
}

// 0 triangle, 1 diamond, 2 cross, 3 chevron, 4 pentagon outline; species index selects the glyph.
fn glyphDistance(shape: u32, point: vec2f) -> f32 {
  switch shape {
    case 0u: { return triangleDistance(point); }
    case 1u: { return diamondDistance(point); }
    case 2u: { return crossDistance(point); }
    case 3u: { return chevronDistance(point); }
    default: { return pentagonOutlineDistance(point); }
  }
}

@fragment
fn glyphFragment(input: GlyphVaryings) -> @location(0) vec4f {
  let signedDistance = glyphDistance(input.shape, input.local);
  // One device pixel spans 2 / glyphDevicePixels local units; the body edge is antialiased over it.
  let pixelUnits = 2.0 / view.glyphDevicePixels;
  let body = 1.0 - smoothstep(-0.5 * pixelUnits, 0.5 * pixelUnits, signedDistance);
  let edgeFade = clamp(1.0 - length(input.local) / view.glowScale, 0.0, 1.0);
  let glow = GLOW_INTENSITY * exp(-max(signedDistance, 0.0) * GLOW_FALLOFF) * edgeFade;
  return vec4f(input.color * (body + glow), 0.0);
}
