// Warp grid: line-list vertices derived from vertex_index (warpGridLatticePoint in warpgrid.js is
// the CPU mirror), displaced toward higher potential, where potential is
// density * densityWeight + threat * threatWeight bilinearly sampled from the blurred coarse field
// (density is the sum of the five species channels). The gradient is a central difference over one
// coarse cell in world units, and the displacement saturates at MAXIMUM_DISPLACEMENT (below the
// line spacing) so a dense mass dents the grid instead of folding it. Lines are a dim neon blue
// that brightens with the displacement and with local threat, so kills flash and ripple.
// Shockwaves: each live impulse (x, y, age, strength) pushes vertices radially outward by
// strength * exp(-((distance - IMPULSE_SPEED * age)^2) / IMPULSE_WIDTH) * (1 - age / IMPULSE_DURATION_SECONDS)
// world units, a ring that runs out from the impulse and fades; the push also brightens the lines.
// Common header prepended.

// Uniform layout (byte offsets), total 48 + IMPULSE_CAPACITY * 16 = 176 bytes; packWarpView in
// warpgrid.js writes it.
//   0 worldToClipScale    vec2f
//   8 worldToClipOffset   vec2f
//  16 densityWeight       f32
//  20 threatWeight        f32
//  24 time                f32
//  28 padding0            f32
//  32 columns             u32
//  36 rows                u32
//  40 padding1            vec2u
//  48 impulses            array<vec4f, IMPULSE_CAPACITY> of (x, y, age, strength); strength 0 is dead
const IMPULSE_CAPACITY: u32 = 8u;

struct WarpView {
  worldToClipScale: vec2f,
  worldToClipOffset: vec2f,
  densityWeight: f32,
  threatWeight: f32,
  time: f32,
  padding0: f32,
  columns: u32,
  rows: u32,
  padding1: vec2u,
  impulses: array<vec4f, IMPULSE_CAPACITY>,
}

@group(0) @binding(0) var<uniform> view: WarpView;
@group(0) @binding(1) var<storage, read> field: array<vec4f>;

// World units; the default line spacing is 16 / 96, about 0.167.
const MAXIMUM_DISPLACEMENT: f32 = 0.12;
// World units of displacement per unit of potential gradient, before saturation.
const DISPLACEMENT_GAIN: f32 = 0.004;
const LINE_COLOR: vec3f = vec3f(0.1, 0.35, 1.0);
const LINE_INTENSITY: f32 = 0.3;
const DISPLACEMENT_BRIGHTENING: f32 = 3.0;
const THREAT_BRIGHTENING: f32 = 0.5;
const MAXIMUM_THREAT_BRIGHTENING: f32 = 12.0;
const RIPPLE_RATE: f32 = 14.0;
const RIPPLE_WAVENUMBER: f32 = 6.0;
// World units per second the shockwave ring travels, its squared-width divisor, and its lifetime
// (DEFAULT_IMPULSE_DURATION_SECONDS in impulses.js).
const IMPULSE_SPEED: f32 = 7.0;
const IMPULSE_WIDTH: f32 = 0.3;
const IMPULSE_DURATION_SECONDS: f32 = 1.2;
// Line brightening per world unit of shockwave push.
const IMPULSE_BRIGHTENING: f32 = 12.0;
const IMPULSE_TINT: vec3f = vec3f(0.6, 0.3, 1.0);

struct WarpVaryings {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
}

// x is the summed species density, y the threat, of one coarse cell (clamped to the field).
fn cellDensityAndThreat(column: i32, row: i32) -> vec2f {
  let clampedColumn = u32(clamp(column, 0, i32(COARSE_COLUMNS) - 1));
  let clampedRow = u32(clamp(row, 0, i32(COARSE_ROWS) - 1));
  let cell = clampedColumn + clampedRow * COARSE_COLUMNS;
  let first = field[cell * 2u];
  let second = field[cell * 2u + 1u];
  return vec2f(first.x + first.y + first.z + first.w + second.x, second.y);
}

// Bilinear over coarse cell centers.
fn sampleField(position: vec2f) -> vec2f {
  let cellPosition = position / vec2f(ARENA_WIDTH, ARENA_HEIGHT) * vec2f(f32(COARSE_COLUMNS), f32(COARSE_ROWS)) - vec2f(0.5);
  let base = floor(cellPosition);
  let fraction = cellPosition - base;
  let column = i32(base.x);
  let row = i32(base.y);
  let top = mix(cellDensityAndThreat(column, row), cellDensityAndThreat(column + 1, row), fraction.x);
  let bottom = mix(cellDensityAndThreat(column, row + 1), cellDensityAndThreat(column + 1, row + 1), fraction.x);
  return mix(top, bottom, fraction.y);
}

fn potentialAt(position: vec2f) -> f32 {
  let sampled = sampleField(position);
  return sampled.x * view.densityWeight + sampled.y * view.threatWeight;
}

// Summed radial push of every live impulse at position, in world units.
fn impulseDisplacement(position: vec2f) -> vec2f {
  var total = vec2f(0.0);
  for (var index = 0u; index < IMPULSE_CAPACITY; index = index + 1u) {
    let impulse = view.impulses[index];
    let strength = impulse.w;
    if (strength <= 0.0) {
      continue;
    }
    let offset = position - impulse.xy;
    let distance = length(offset);
    let age = impulse.z;
    let front = distance - IMPULSE_SPEED * age;
    let amount = strength * exp(-(front * front) / IMPULSE_WIDTH) * max(1.0 - age / IMPULSE_DURATION_SECONDS, 0.0);
    total = total + select(vec2f(0.0), offset / max(distance, 1e-6) * amount, distance > 1e-6);
  }
  return total;
}

@vertex
fn warpVertex(@builtin(vertex_index) vertexIndex: u32) -> WarpVaryings {
  let segment = vertexIndex / 2u;
  let end = vertexIndex % 2u;
  let horizontalSegments = (view.rows + 1u) * view.columns;
  var lattice: vec2u;
  if (segment < horizontalSegments) {
    lattice = vec2u(segment % view.columns + end, segment / view.columns);
  } else {
    let vertical = segment - horizontalSegments;
    lattice = vec2u(vertical / view.rows, vertical % view.rows + end);
  }
  let position = vec2f(lattice) / vec2f(f32(view.columns), f32(view.rows)) * vec2f(ARENA_WIDTH, ARENA_HEIGHT);

  let cellSize = vec2f(ARENA_WIDTH / f32(COARSE_COLUMNS), ARENA_HEIGHT / f32(COARSE_ROWS));
  let gradient = vec2f(
    potentialAt(position + vec2f(cellSize.x, 0.0)) - potentialAt(position - vec2f(cellSize.x, 0.0)),
    potentialAt(position + vec2f(0.0, cellSize.y)) - potentialAt(position - vec2f(0.0, cellSize.y)),
  ) / (2.0 * cellSize);
  let magnitude = length(gradient);
  let saturation = 1.0 - exp(-magnitude * DISPLACEMENT_GAIN / MAXIMUM_DISPLACEMENT);
  let direction = select(vec2f(0.0), gradient / max(magnitude, 1e-6), magnitude > 1e-6);
  let shockwave = impulseDisplacement(position);
  let displacement = direction * MAXIMUM_DISPLACEMENT * saturation + shockwave;
  // Border lines stay on the arena edge, and a shockwave cannot push inner lines past it into
  // the letterbox: they pile up against the wall instead.
  let onBorder = vec2<bool>(lattice.x == 0u || lattice.x == view.columns, lattice.y == 0u || lattice.y == view.rows);
  let displaced = clamp(position + select(displacement, vec2f(0.0), onBorder), vec2f(0.0), vec2f(ARENA_WIDTH, ARENA_HEIGHT));

  let threat = sampleField(position).y;
  let ripple = 0.6 + 0.4 * sin(view.time * RIPPLE_RATE - threat * RIPPLE_WAVENUMBER);
  let threatGlow = min(threat * THREAT_BRIGHTENING, MAXIMUM_THREAT_BRIGHTENING) * ripple;
  var output: WarpVaryings;
  output.position = vec4f(displaced * view.worldToClipScale + view.worldToClipOffset, 0.0, 1.0);
  let shockwaveGlow = IMPULSE_BRIGHTENING * length(shockwave);
  output.color = LINE_COLOR * LINE_INTENSITY * (1.0 + DISPLACEMENT_BRIGHTENING * saturation + threatGlow)
    + IMPULSE_TINT * LINE_INTENSITY * shockwaveGlow;
  return output;
}

@fragment
fn warpFragment(input: WarpVaryings) -> @location(0) vec4f {
  return vec4f(input.color, 0.0);
}
