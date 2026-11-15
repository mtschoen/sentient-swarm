// Spawn gates: one instanced quad per gate (at most 4, drawn as the instance count), read from a
// small uniform array. A soft ring at the gate radius with GATE_DASHES rotating dashes in the
// favored species' hue, a faint inner haze, all scaled by the open amount; the telegraph (the next
// wave's gate) and emission brighten it and emission adds a pulsing core. Common and
// quad headers prepended (hsvToRgb, quadCorner).

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

// Hives (stage 3), read by hiveFragment only (the plain gate pipeline's layout leaves it out); total
// 96 bytes, packHiveView in gates.js writes it: the two seat colors (rgb, 0), then per gate row
// (hive 1 or 0, owner seat plus 1, capture progress 0 to 1, capturer seat plus 1).
struct HiveView {
  seatColors: array<vec4f, 2>,
  rows: array<vec4f, 4>,
}

@group(0) @binding(1) var<uniform> hives: HiveView;

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
  let corner = quadCorner(vertexIndex);
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

const NEUTRAL_HIVE_TINT: vec3f = vec3f(0.75, 0.75, 0.8);
const HIVE_RING_HALF_WIDTH: f32 = 0.05;
// The progress arc sits just outside the ring, inside the quad's reach.
const PROGRESS_ARC_SCALE: f32 = 1.2;
const PROGRESS_ARC_HALF_WIDTH: f32 = 0.07;

fn seatTint(seatPlusOne: f32) -> vec3f {
  return hives.seatColors[u32(seatPlusOne) - 1u].rgb;
}

// A hive: neutral is a pale dashed ring; owned a solid ring with a haze in the owner's color; capture
// progress an arc in the capturer's color, clockwise from the top; emission flares as for a gate.
@fragment
fn hiveFragment(input: GateVaryings) -> @location(0) vec4f {
  let row = hives.rows[min(u32(input.state.w), 3u)];
  let radius = input.shape.z;
  let emit = input.state.y;
  let telegraph = input.state.z;
  let distance = length(input.offset);
  let owned = row.y >= 1.0;
  let tint = select(NEUTRAL_HIVE_TINT, seatTint(max(row.y, 1.0)), owned);
  let angle = atan2(input.offset.y, input.offset.x);
  let dash = select(smoothstep(0.15, 0.45, 0.5 + 0.5 * cos(angle * GATE_DASHES + view.time * ROTATION_RATE * GATE_DASHES)), 1.0, owned);
  let ring = exp(-max(abs(distance - radius) - HIVE_RING_HALF_WIDTH, 0.0) * 24.0) * (0.3 + 0.7 * dash);
  let haze = (1.0 - smoothstep(0.0, radius, distance)) * select(0.06, 0.22, owned);
  let core = exp(-distance / max(radius, 0.01) * 4.0) * emit * (0.6 + 0.4 * sin(view.time * 24.0));
  let brightness = select(0.45, 0.8, owned) + TELEGRAPH_BRIGHTNESS * telegraph + EMIT_BRIGHTNESS * emit;
  var color = tint * (ring + haze + core) * brightness;
  if (row.w >= 1.0 && row.z > 0.0) {
    // Clockwise on screen from the top (world y grows downward): 0 at the top, rising toward +x.
    let sweep = fract(atan2(input.offset.x, -input.offset.y) / TAU + 1.0);
    let onArc = step(sweep, row.z);
    let arc = exp(-max(abs(distance - radius * PROGRESS_ARC_SCALE) - PROGRESS_ARC_HALF_WIDTH, 0.0) * 30.0);
    color = max(color, seatTint(row.w) * arc * (0.25 + 0.95 * onArc));
  }
  return vec4f(color, 0.0);
}
