// The player ship: one instanced quad (single instance), max-blended (see MAX_BLEND) and drawn after the
// particles. A spaceship silhouette with its nose along the facing: a pointed fuselage, two swept
// wings, a cockpit, wingtip lights and a flickering engine flame, all in the armed weapon's hue
// over white; plus a thin world-aligned ring (radius RING_RADIUS) whose arc length is the charge,
// hidden on the base gun. Common header prepended (hsvToRgb).
// Local coordinates: +x is the nose, +y is to the ship's right (world y grows downward).

// Uniform layout, total 64 bytes; ShipRenderer in ship.js writes it.
//   0 worldToClipScale vec2f, 8 worldToClipOffset vec2f, 16 devicePixelToClip vec2f, 24 time f32,
//  28 pixelScale f32, 32 position vec2f, 40 facing f32 (radians), 44 charge f32 (0..1),
//  48 hue f32, 52 ringShown f32 (0 or 1), 56 brightness f32 (blink), 60 padding
struct ShipView {
  worldToClipScale: vec2f,
  worldToClipOffset: vec2f,
  devicePixelToClip: vec2f,
  time: f32,
  pixelScale: f32,
  position: vec2f,
  facing: f32,
  charge: f32,
  hue: f32,
  ringShown: f32,
  brightness: f32,
  padding: f32,
}

@group(0) @binding(0) var<uniform> view: ShipView;

const HALF_EXTENT: f32 = 0.55;
const RING_RADIUS: f32 = 0.3;
const RING_HALF_WIDTH: f32 = 0.012;
const TWO_PI: f32 = 6.28318530718;
const SATURATION: f32 = 0.8;
const PIXEL_FEATHER: f32 = 0.75;

struct ShipVaryings {
  @builtin(position) position: vec4f,
  // World-aligned offset from the ship centre, in world units.
  @location(0) offset: vec2f,
}

@vertex
fn shipVertex(@builtin(vertex_index) vertexIndex: u32) -> ShipVaryings {
  var output: ShipVaryings;
  let corner = vec2f(f32(vertexIndex & 1u), f32(vertexIndex >> 1u)) * 2.0 - vec2f(1.0);
  output.offset = corner * HALF_EXTENT;
  let world = view.position + output.offset;
  output.position = vec4f(world * view.worldToClipScale + view.worldToClipOffset, 0.0, 1.0);
  return output;
}

// Signed distance to a triangle (Inigo Quilez).
fn triangleDistance(point: vec2f, first: vec2f, second: vec2f, third: vec2f) -> f32 {
  let edgeOne = second - first;
  let edgeTwo = third - second;
  let edgeThree = first - third;
  let toFirst = point - first;
  let toSecond = point - second;
  let toThird = point - third;
  let projectedOne = toFirst - edgeOne * clamp(dot(toFirst, edgeOne) / dot(edgeOne, edgeOne), 0.0, 1.0);
  let projectedTwo = toSecond - edgeTwo * clamp(dot(toSecond, edgeTwo) / dot(edgeTwo, edgeTwo), 0.0, 1.0);
  let projectedThree = toThird - edgeThree * clamp(dot(toThird, edgeThree) / dot(edgeThree, edgeThree), 0.0, 1.0);
  let orientation = sign(edgeOne.x * edgeThree.y - edgeOne.y * edgeThree.x);
  let distances = min(min(
    vec2f(dot(projectedOne, projectedOne), orientation * (toFirst.x * edgeOne.y - toFirst.y * edgeOne.x)),
    vec2f(dot(projectedTwo, projectedTwo), orientation * (toSecond.x * edgeTwo.y - toSecond.y * edgeTwo.x))),
    vec2f(dot(projectedThree, projectedThree), orientation * (toThird.x * edgeThree.y - toThird.y * edgeThree.x)));
  return -sqrt(distances.x) * sign(distances.y);
}

// Fuselage and the two swept wings (mirrored across the heading axis).
fn hullDistance(point: vec2f) -> f32 {
  let mirrored = vec2f(point.x, abs(point.y));
  let fuselage = triangleDistance(point, vec2f(0.30, 0.0), vec2f(-0.17, 0.075), vec2f(-0.17, -0.075));
  let wing = triangleDistance(mirrored, vec2f(0.07, 0.05), vec2f(-0.22, 0.26), vec2f(-0.13, 0.05));
  return min(fuselage, wing);
}

@fragment
fn shipFragment(input: ShipVaryings) -> @location(0) vec4f {
  let feather = max(abs(view.devicePixelToClip.x / view.worldToClipScale.x), 1e-5) * PIXEL_FEATHER;
  let forward = vec2f(cos(view.facing), sin(view.facing));
  let side = vec2f(-forward.y, forward.x);
  let local = vec2f(dot(input.offset, forward), dot(input.offset, side));
  let tint = hsvToRgb(view.hue, SATURATION, 1.0);

  let distance = hullDistance(local);
  let body = 1.0 - smoothstep(-feather, feather, distance);
  let outline = (1.0 - smoothstep(0.012, 0.012 + feather * 2.0, abs(distance)));
  let halo = exp(-max(distance, 0.0) * 14.0) * 0.55;
  var color = vec3f(0.55) * body + vec3f(1.9) * outline + tint * halo;

  // Cockpit: a bright hue-coloured teardrop on the spine.
  let cockpit = 1.0 - smoothstep(0.0, 0.05 + feather, length((local - vec2f(0.07, 0.0)) * vec2f(0.8, 1.6)));
  color += tint * cockpit * 1.4 * body;
  // Wingtip lights.
  let wingtip = exp(-length(vec2f(local.x + 0.22, abs(local.y) - 0.26)) * 38.0);
  color += tint * wingtip * 1.6;

  // Engine flame behind the tail, flickering.
  let flicker = 0.75 + 0.25 * sin(view.time * 63.0) + 0.1 * sin(view.time * 31.0);
  let flameLength = 0.16 * flicker;
  let behind = -local.x - 0.17;
  let flameWidth = 0.05 * clamp(1.0 - behind / max(flameLength, 0.001), 0.0, 1.0);
  let flame = step(0.0, behind) * (1.0 - smoothstep(flameWidth * 0.5, flameWidth + feather, abs(local.y))) * clamp(1.0 - behind / max(flameLength, 0.001), 0.0, 1.0);
  color += (tint * 1.3 + vec3f(0.6)) * flame;

  // Charge ring: a faint full track, with the bright arc covering the charge fraction clockwise
  // from the top (world y grows downward, so atan2 grows clockwise on screen).
  let ringDistance = abs(length(input.offset) - RING_RADIUS);
  let ringBand = 1.0 - smoothstep(RING_HALF_WIDTH, RING_HALF_WIDTH + feather * 2.0, ringDistance);
  let ringGlow = exp(-max(ringDistance - RING_HALF_WIDTH, 0.0) * 40.0);
  let turn = fract((atan2(input.offset.y, input.offset.x) + TWO_PI * 0.25) / TWO_PI);
  let filled = select(0.0, 1.0, turn <= view.charge);
  let ringColor = tint * (ringBand * (0.12 + 1.5 * filled) + ringGlow * 0.35 * filled);
  color += ringColor * view.ringShown;

  return vec4f(color * view.brightness, 0.0);
}
