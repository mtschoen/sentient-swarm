// Pickups: one instanced quad per pickup (at most MAXIMUM_PICKUPS, drawn as the instance count),
// read from a small uniform array. A slowly rotating hexagon outline in the weapon's hue with a
// soft pulse and a glowing core, alpha times the pickup's fade. A hue of 1 or more is the time warp
// (PICKUP_SHAPE_CLOCK added in pickups.js): a paler ring with a sweeping hand and a brighter core,
// a clock. Common and quad headers prepended (hsvToRgb, segmentDistance).

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
// The time warp clock: hand sweep in radians per second, hand length as a share of the ring,
// a whiter tint and a brighter core than the weapons.
const CLOCK_HAND_RATE: f32 = 2.5;
const CLOCK_HAND_SHARE: f32 = 0.8;
const CLOCK_SATURATION: f32 = 0.45;
const CLOCK_CORE: f32 = 1.4;
const WEAPON_CORE: f32 = 0.8;

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
  let corner = quadCorner(vertexIndex);
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
  let feather = worldFeather(view.devicePixelToClip, view.worldToClipScale);
  let angle = view.time * ROTATION_RATE + input.phase;
  let cosine = cos(angle);
  let sine = sin(angle);
  let rotated = vec2f(cosine * input.offset.x + sine * input.offset.y, -sine * input.offset.x + cosine * input.offset.y);
  let pulse = 1.0 + 0.1 * sin(view.time * PULSE_RATE + input.phase);
  let clock = input.hue >= 1.0;
  var outline = abs(hexagonDistance(rotated, HEXAGON_RADIUS * pulse));
  if (clock) {
    let handAngle = view.time * CLOCK_HAND_RATE + input.phase;
    let hand = vec2f(sin(handAngle), cos(handAngle)) * HEXAGON_RADIUS * CLOCK_HAND_SHARE;
    outline = min(abs(length(input.offset) - HEXAGON_RADIUS * pulse), segmentDistance(input.offset, vec2f(0.0), hand));
  }
  let band = 1.0 - smoothstep(OUTLINE_HALF_WIDTH, OUTLINE_HALF_WIDTH + feather * 2.0, outline);
  let glow = exp(-max(outline - OUTLINE_HALF_WIDTH, 0.0) * 16.0) * 0.6;
  let core = exp(-length(input.offset) * 14.0) * select(WEAPON_CORE, CLOCK_CORE, clock);
  let tint = hsvToRgb(fract(input.hue), select(SATURATION, CLOCK_SATURATION, clock), 1.0);
  let color = tint * (band * 1.5 + glow + core) + vec3f(band * 0.4);
  return vec4f(color * input.fade, 0.0);
}
