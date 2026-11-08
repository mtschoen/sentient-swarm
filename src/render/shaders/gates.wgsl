// Spawn gates: one instanced quad per gate (at most 4, drawn as the instance count), read from a
// small uniform array. A soft ring at the gate radius with GATE_DASHES rotating dashes in the
// favored species' hue, a faint inner haze, all scaled by the open amount; the telegraph (the next
// wave's gate) and emission brighten it and emission adds a pulsing core. Common header prepended
// (hsvToRgb).

// Uniform layout, total 160 bytes; GateRenderer in gates.js writes it.
//   0 worldToClipScale vec2f, 8 worldToClipOffset vec2f, 16 devicePixelToClip vec2f, 24 time f32,
//  28 header padding f32, then 4 gates of two vec4f: (x, y, radius, open), (hue, emit, telegraph,
//  index).
struct GateView {
  worldToClipScale: vec2f,
  worldToClipOffset: vec2f,
  devicePixelToClip: vec2f,
  time: f32,
  headerPadding: f32,
  gates: array<vec4f, 8>,
}

@group(0) @binding(0) var<uniform> view: GateView;

// The quad reaches this multiple of the gate radius, room for the outer glow.
const QUAD_REACH: f32 = 1.4;
const RING_HALF_WIDTH: f32 = 0.035;
const GATE_DASHES: f32 = 6.0;
const ROTATION_RATE: f32 = 0.8;
const SATURATION: f32 = 0.7;
const BASE_BRIGHTNESS: f32 = 0.35;
const TELEGRAPH_BRIGHTNESS: f32 = 0.6;
const EMIT_BRIGHTNESS: f32 = 0.9;

struct GateVaryings {
  @builtin(position) position: vec4f,
  @location(0) offset: vec2f,
  @location(1) @interpolate(flat) shape: vec4f,
  @location(2) @interpolate(flat) state: vec4f,
}

@vertex
fn gateVertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> GateVaryings {
  var output: GateVaryings;
  let shape = view.gates[instanceIndex * 2u];
  let state = view.gates[instanceIndex * 2u + 1u];
  let corner = vec2f(f32(vertexIndex & 1u), f32(vertexIndex >> 1u)) * 2.0 - vec2f(1.0);
  output.offset = corner * shape.z * QUAD_REACH;
  let world = shape.xy + output.offset;
  output.position = vec4f(world * view.worldToClipScale + view.worldToClipOffset, 0.0, 1.0);
  output.shape = shape;
  output.state = state;
  return output;
}

@fragment
fn gateFragment(input: GateVaryings) -> @location(0) vec4f {
  let radius = input.shape.z;
  let open = input.shape.w;
  let emit = input.state.y;
  let telegraph = input.state.z;
  let distance = length(input.offset);
  let angle = atan2(input.offset.y, input.offset.x);
  let spin = view.time * ROTATION_RATE * select(1.0, -1.0, (u32(input.state.w) & 1u) == 1u);
  let dash = smoothstep(0.15, 0.45, 0.5 + 0.5 * cos(angle * GATE_DASHES + spin * GATE_DASHES));
  let ringRadius = radius * (1.0 - 0.12 * emit * (0.5 + 0.5 * sin(view.time * 18.0)));
  let ringDistance = abs(distance - ringRadius);
  let ring = exp(-max(ringDistance - RING_HALF_WIDTH, 0.0) * 28.0) * (0.35 + 0.65 * dash);
  let haze = (1.0 - smoothstep(0.0, radius, distance)) * 0.12;
  let core = exp(-distance / max(radius, 0.01) * 4.0) * emit * (0.6 + 0.4 * sin(view.time * 24.0));
  let brightness = open * (BASE_BRIGHTNESS + TELEGRAPH_BRIGHTNESS * telegraph + EMIT_BRIGHTNESS * emit);
  let tint = hsvToRgb(input.state.x, SATURATION, 1.0);
  let color = tint * (ring + haze + core) * brightness + vec3f(ring * 0.15 * brightness);
  return vec4f(color, 0.0);
}
