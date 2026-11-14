// The player swarm (player-swarm spike): one instanced quad per white ship (at most
// MAXIMUM_SWARM_SHIPS, read from a uniform array), plus one more instance for the controlled point's
// marker (a faint ring with a dot) when markerShown is 1. Ships are small white darts with a bright
// outline and a halo, nose along each ship's own heading (its velocity, so it banks through
// curves), drawn at shipSize (SWARM_SHIP_SIZE) of the first spike's dart, and a cockpit in the armed weapon's hue; a new
// ship flashes for its first SPAWN_FLASH_SECONDS. Max-blended (MAX_BLEND) after the particles.
// Common and quad headers prepended (hsvToRgb, quadCorner, worldFeather).

// Uniform layout, total 4160 bytes; SwarmRenderer in swarm.js writes it.
//   0 worldToClipScale vec2f, 8 worldToClipOffset vec2f, 16 devicePixelToClip vec2f, 24 time f32,
//  28 header padding f32, 32 facing f32, 36 markerX f32, 40 markerY f32, 44 markerShown f32,
//  48 hue f32, 52 count f32, 56 shipSize f32, 60 padding f32, then MAXIMUM_SWARM_SHIPS vec4f
//  (x, y, age, heading). facing (the aim) is unused by the ships since they face their heading.
struct SwarmView {
  worldToClipScale: vec2f,
  worldToClipOffset: vec2f,
  devicePixelToClip: vec2f,
  time: f32,
  headerPadding: f32,
  facing: f32,
  markerX: f32,
  markerY: f32,
  markerShown: f32,
  hue: f32,
  count: f32,
  shipSize: f32,
  padding: f32,
  ships: array<vec4f, MAXIMUM_SWARM_SHIPS>,
}

@group(0) @binding(0) var<uniform> view: SwarmView;

const SHIP_HALF_EXTENT: f32 = 0.16;
const MARKER_HALF_EXTENT: f32 = 0.2;
const MARKER_RADIUS: f32 = 0.12;
// Local hull scale at shipSize 1: the dart's nose is SHIP_SCALE * 0.3 ahead of its centre.
const SHIP_SCALE: f32 = 0.4;
const SPAWN_FLASH_SECONDS: f32 = 0.4;

struct SwarmVaryings {
  @builtin(position) position: vec4f,
  @location(0) offset: vec2f,
  @location(1) @interpolate(flat) marker: f32,
  @location(2) @interpolate(flat) age: f32,
  @location(3) @interpolate(flat) heading: f32,
}

@vertex
fn swarmVertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> SwarmVaryings {
  var output: SwarmVaryings;
  let corner = quadCorner(vertexIndex);
  let isMarker = instanceIndex >= u32(view.count + 0.5);
  var center = vec2f(view.markerX, view.markerY);
  var halfExtent = MARKER_HALF_EXTENT;
  output.age = 0.0;
  output.heading = 0.0;
  if (!isMarker) {
    let ship = view.ships[min(instanceIndex, MAXIMUM_SWARM_SHIPS - 1u)];
    center = ship.xy;
    halfExtent = SHIP_HALF_EXTENT * view.shipSize;
    output.age = ship.z;
    output.heading = ship.w;
  }
  output.offset = corner * halfExtent;
  output.marker = select(0.0, 1.0, isMarker);
  let world = center + output.offset;
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

// A swept dart: fuselage and the two wings, mirrored across the heading axis, in hull units.
fn dartDistance(point: vec2f) -> f32 {
  let mirrored = vec2f(point.x, abs(point.y));
  let fuselage = triangleDistance(point, vec2f(0.30, 0.0), vec2f(-0.17, 0.075), vec2f(-0.17, -0.075));
  let wing = triangleDistance(mirrored, vec2f(0.07, 0.05), vec2f(-0.22, 0.26), vec2f(-0.13, 0.05));
  return min(fuselage, wing);
}

@fragment
fn swarmFragment(input: SwarmVaryings) -> @location(0) vec4f {
  let feather = worldFeather(view.devicePixelToClip, view.worldToClipScale);
  let tint = hsvToRgb(view.hue, 0.8, 1.0);
  if (input.marker > 0.5) {
    if (view.markerShown < 0.5) {
      discard;
    }
    let ringDistance = abs(length(input.offset) - MARKER_RADIUS);
    let ring = 1.0 - smoothstep(0.006, 0.006 + feather * 2.0, ringDistance);
    let centerDot = 1.0 - smoothstep(0.012, 0.012 + feather * 2.0, length(input.offset));
    return vec4f(vec3f(0.35) * ring + tint * 0.6 * centerDot, 0.0);
  }
  let scale = SHIP_SCALE * view.shipSize;
  let forward = vec2f(cos(input.heading), sin(input.heading));
  let side = vec2f(-forward.y, forward.x);
  let local = vec2f(dot(input.offset, forward), dot(input.offset, side)) / scale;
  let distance = dartDistance(local) * scale;
  let body = 1.0 - smoothstep(-feather, feather, distance);
  let outline = 1.0 - smoothstep(0.006 * view.shipSize, 0.006 * view.shipSize + feather * 2.0, abs(distance));
  let halo = exp(-max(distance, 0.0) * 30.0 / view.shipSize) * 0.5;
  let cockpit = (1.0 - smoothstep(0.0, 0.02 * view.shipSize + feather, length(local - vec2f(0.07, 0.0)) * scale)) * body;
  let flash = 1.0 + 2.0 * clamp(1.0 - input.age / SPAWN_FLASH_SECONDS, 0.0, 1.0);
  let color = (vec3f(1.1) * body + vec3f(2.0) * outline + vec3f(0.8) * halo) * flash + tint * cockpit * 1.5;
  return vec4f(color, 0.0);
}
