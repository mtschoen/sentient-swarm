// Pickups: one instanced quad per pickup (at most MAXIMUM_PICKUPS, drawn as the instance count),
// read from a small uniform array. A slowly rotating hexagon outline in the weapon's hue with a
// soft pulse and a glowing core, alpha times the pickup's fade. Common header prepended (hsvToRgb).

// Uniform layout, total 544 bytes; PickupRenderer in pickups.js writes it.
//   0 worldToClipScale vec2f, 8 worldToClipOffset vec2f, 16 devicePixelToClip vec2f, 24 time f32,
//  28 header padding f32, then 32 pickups of vec4f (x, y, hue, fade).
struct PickupView {
  worldToClipScale: vec2f,
  worldToClipOffset: vec2f,
  devicePixelToClip: vec2f,
  time: f32,
  headerPadding: f32,
  pickups: array<vec4f, 32>,
}

@group(0) @binding(0) var<uniform> view: PickupView;

const HALF_EXTENT: f32 = 0.5;
const HEXAGON_RADIUS: f32 = 0.24;
const OUTLINE_HALF_WIDTH: f32 = 0.028;
const ROTATION_RATE: f32 = 1.2;
const PULSE_RATE: f32 = 3.0;
const SATURATION: f32 = 0.85;
const PIXEL_FEATHER: f32 = 0.75;

struct PickupVaryings {
  @builtin(position) position: vec4f,
  @location(0) offset: vec2f,
  @location(1) @interpolate(flat) hue: f32,
  @location(2) @interpolate(flat) fade: f32,
  @location(3) @interpolate(flat) phase: f32,
}

@vertex
fn pickupVertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> PickupVaryings {
  var output: PickupVaryings;
  let pickup = view.pickups[instanceIndex];
  let corner = vec2f(f32(vertexIndex & 1u), f32(vertexIndex >> 1u)) * 2.0 - vec2f(1.0);
  output.offset = corner * HALF_EXTENT;
  let world = pickup.xy + output.offset;
  output.position = vec4f(world * view.worldToClipScale + view.worldToClipOffset, 0.0, 1.0);
  output.hue = pickup.z;
  output.fade = pickup.w;
  output.phase = f32(instanceIndex) * 1.7;
  return output;
}

// Regular hexagon with the given circumradius (Inigo Quilez), flat sides up.
fn hexagonDistance(point: vec2f, radius: f32) -> f32 {
  let constants = vec3f(-0.866025404, 0.5, 0.577350269);
  var folded = abs(point);
  folded -= 2.0 * min(dot(constants.xy, folded), 0.0) * constants.xy;
  folded -= vec2f(clamp(folded.x, -constants.z * radius, constants.z * radius), radius);
  return length(folded) * sign(folded.y);
}

@fragment
fn pickupFragment(input: PickupVaryings) -> @location(0) vec4f {
  let feather = max(abs(view.devicePixelToClip.x / view.worldToClipScale.x), 1e-5) * PIXEL_FEATHER;
  let angle = view.time * ROTATION_RATE + input.phase;
  let cosine = cos(angle);
  let sine = sin(angle);
  let rotated = vec2f(cosine * input.offset.x + sine * input.offset.y, -sine * input.offset.x + cosine * input.offset.y);
  let pulse = 1.0 + 0.1 * sin(view.time * PULSE_RATE + input.phase);
  let distance = hexagonDistance(rotated, HEXAGON_RADIUS * pulse);
  let outline = abs(distance);
  let band = 1.0 - smoothstep(OUTLINE_HALF_WIDTH, OUTLINE_HALF_WIDTH + feather * 2.0, outline);
  let glow = exp(-max(outline - OUTLINE_HALF_WIDTH, 0.0) * 16.0) * 0.6;
  let core = exp(-length(input.offset) * 14.0) * 0.8;
  let tint = hsvToRgb(input.hue, SATURATION, 1.0);
  let color = tint * (band * 1.5 + glow + core) + vec3f(band * 0.4);
  return vec4f(color * input.fade, 0.0);
}
