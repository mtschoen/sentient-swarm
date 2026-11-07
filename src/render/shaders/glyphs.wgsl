// Agent ships: one instance per agent slot, a 4-vertex triangle strip pulled from the agent
// buffer. Dead agents collapse to a degenerate quad. common.wgsl and ships.wgsl are prepended.
// The quad is glyphDevicePixels * glowScale device pixels wide, rotated so local +x is the heading;
// the ship body lies inside radius 1 and the glow and engine plume reach out to radius glowScale.
// Heading: the velocity direction, blended toward the player at low speed (agents carry no
// heading), so idle and spawning ships face the player instead of snapping to an arbitrary axis.
// Shading: a one-pixel rim in the species hue, a fill at FILL_BRIGHTNESS of it, a soft halo and an
// engine plume whose length follows speed / maximumSpeed and pulses with phase. Spawning ships are
// rim only and fill in over SPAWN_IN_FRAMES.
// Position is extrapolated by velocity * alpha * dt so rendering between fixed steps stays smooth.
// Density attenuation works in screen coverage: the coarse density (agents per cell) times
// coverageScale (glyph body area over coarse cell area, in device pixels) is the fraction of the
// cell that glyph bodies cover, and each glyph is divided by 1 + COVERAGE_ATTENUATION * coverage,
// so a crowd's summed radiance per pixel levels off near 1 / COVERAGE_ATTENUATION glyphs at any
// arena size. emissionScale (trailFrameFactors) keeps steady-state brightness refresh-independent.

// Uniform layout (byte offsets), total 48 bytes; packGlyphView in glyphs.js writes it.
//   0 worldToClipScale    vec2f
//   8 worldToClipOffset   vec2f
//  16 devicePixelToClip   vec2f
//  24 glyphDevicePixels   f32 (already multiplied by the inspect zoom)
//  28 glowScale           f32
//  32 alpha               f32
//  36 time                f32
//  40 coverageScale       f32 (glyph body area / coarse cell area, device pixels)
//  44 emissionScale       f32
struct GlyphView {
  worldToClipScale: vec2f,
  worldToClipOffset: vec2f,
  devicePixelToClip: vec2f,
  glyphDevicePixels: f32,
  glowScale: f32,
  alpha: f32,
  time: f32,
  coverageScale: f32,
  emissionScale: f32,
}

@group(0) @binding(0) var<uniform> view: GlyphView;
@group(0) @binding(1) var<uniform> params: SimParams;
@group(0) @binding(2) var<storage, read> agents: array<Agent>;
@group(0) @binding(3) var<storage, read> field: array<vec4f>;
@group(0) @binding(4) var<storage, read> speciesTable: array<f32>;

const HUE_JITTER_RANGE: f32 = 0.03;
const GLYPH_SATURATION: f32 = 0.8;
const COVERAGE_ATTENUATION: f32 = 4.0;
const GLOW_INTENSITY: f32 = 0.05;
const GLOW_FALLOFF: f32 = 3.0;
const SPAWN_PULSE_RATE: f32 = 18.0;
// Fill brightness relative to the rim.
const FILL_BRIGHTNESS: f32 = 0.35;
// Below this speed (world units per second) the heading leans toward the player.
const HEADING_IDLE_SPEED: f32 = 0.4;
// Plume length in local units at full speed, its minimum share at rest, its half-width and peak.
const PLUME_LENGTH: f32 = 0.9;
const PLUME_IDLE_SHARE: f32 = 0.15;
const PLUME_HALF_WIDTH: f32 = 0.12;
const PLUME_INTENSITY: f32 = 0.9;
const PLUME_FLICKER_RATE: f32 = 9.0;

struct GlyphVaryings {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) color: vec3f,
  @location(2) @interpolate(flat) shape: u32,
  // x plume length (local units), y plume intensity, z fill progress (0 spawning, 1 settled).
  @location(3) @interpolate(flat) engine: vec3f,
}

// Velocity direction, plus a pull toward the player that fades out as speed reaches
// HEADING_IDLE_SPEED, so slow ships keep a steady nose and stopped ones face the player.
fn shipHeading(position: vec2f, velocity: vec2f) -> vec2f {
  let toPlayer = params.playerPosition - position;
  let playerDistance = length(toPlayer);
  let towardPlayer = select(vec2f(0.0), toPlayer / max(playerDistance, 1e-6), playerDistance > 1e-4);
  let idleWeight = max(HEADING_IDLE_SPEED - length(velocity), 0.0);
  let blended = velocity + towardPlayer * idleWeight;
  let blendedLength = length(blended);
  return select(vec2f(1.0, 0.0), blended / max(blendedLength, 1e-6), blendedLength > 1e-5);
}

@vertex
fn glyphVertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> GlyphVaryings {
  var output: GlyphVaryings;
  let agent = agents[instanceIndex];
  // A zero glyph or glow size (the smoke hides glyphs this way) collapses early, so the fragment
  // stage never divides by it.
  if (!isAlive(agent.flags) || view.glyphDevicePixels <= 0.0 || view.glowScale <= 0.0) {
    output.position = vec4f(2.0, 2.0, 0.0, 1.0);
    output.local = vec2f(0.0);
    output.color = vec3f(0.0);
    output.shape = 0u;
    output.engine = vec3f(0.0);
    return output;
  }
  let corner = vec2f(f32(vertexIndex & 1u), f32(vertexIndex >> 1u)) * 2.0 - vec2f(1.0);
  let position = clampToArena(agent.position + agent.velocity * view.alpha * params.dt);
  let forward = shipHeading(position, agent.velocity);
  let side = vec2f(-forward.y, forward.x);
  // World and device pixels both grow y downward, so the world direction is the screen direction.
  let offsetDevicePixels = (forward * corner.x + side * corner.y) * (0.5 * view.glyphDevicePixels * view.glowScale);
  let center = position * view.worldToClipScale + view.worldToClipOffset;
  output.position = vec4f(center + offsetDevicePixels * view.devicePixelToClip * vec2f(1.0, -1.0), 0.0, 1.0);
  output.local = corner * view.glowScale;

  let hue = speciesTable[speciesFieldIndex(agent.species, SPECIES_FIELD_HUE)];
  let rgb = hsvToRgb(fract(hue + agent.hueJitter * HUE_JITTER_RANGE), GLYPH_SATURATION, 1.0);
  let spawnFrames = spawnFramesRemaining(agent.flags);
  let spawning = spawnFrames > 0u;
  let calmPulse = 0.85 + 0.15 * sin(agent.phase);
  let spawnPulse = 0.5 + 0.5 * sin(agent.phase + view.time * SPAWN_PULSE_RATE);
  let cell = coarseCellIndexFor(position);
  let densities = field[cell * 2u];
  let localDensity = densities.x + densities.y + densities.z + densities.w + field[cell * 2u + 1u].x;
  let coverage = localDensity * view.coverageScale;
  var alpha = select(calmPulse, spawnPulse, spawning) / (1.0 + COVERAGE_ATTENUATION * coverage);
  if (spawning) {
    alpha *= 0.5;
  }
  output.color = rgb * alpha * view.emissionScale;
  output.shape = agent.species;

  let maximumSpeed = speciesTable[speciesFieldIndex(agent.species, FIELD_MAXIMUM_SPEED)];
  let thrust = clamp(length(agent.velocity) / max(maximumSpeed, 1e-6), 0.0, 1.0);
  let flicker = 0.7 + 0.3 * sin(agent.phase * 3.0 + view.time * PLUME_FLICKER_RATE);
  let plumeLength = PLUME_LENGTH * (PLUME_IDLE_SHARE + (1.0 - PLUME_IDLE_SHARE) * thrust);
  let fillProgress = 1.0 - min(f32(spawnFrames) / f32(SPAWN_IN_FRAMES), 1.0);
  output.engine = vec3f(plumeLength, PLUME_INTENSITY * flicker * (0.3 + 0.7 * thrust), fillProgress);
  return output;
}

@fragment
fn glyphFragment(input: GlyphVaryings) -> @location(0) vec4f {
  let signedDistance = shipDistance(input.shape, input.local);
  // One device pixel spans 2 / glyphDevicePixels local units; the body edge is antialiased over it
  // and the rim is the outermost pixel inside the edge.
  let pixelUnits = 2.0 / view.glyphDevicePixels;
  let body = 1.0 - smoothstep(-0.5 * pixelUnits, 0.5 * pixelUnits, signedDistance);
  let interior = 1.0 - smoothstep(-1.5 * pixelUnits, -0.5 * pixelUnits, signedDistance);
  let rim = body - interior;
  let fill = interior * FILL_BRIGHTNESS * input.engine.z;
  let edgeFade = clamp(1.0 - length(input.local) / view.glowScale, 0.0, 1.0);
  let glow = GLOW_INTENSITY * exp(-max(signedDistance, 0.0) * GLOW_FALLOFF) * edgeFade;
  // The plume runs from the nozzle backward along -x, tapering with distance from the nozzle.
  let nozzle = vec2f(shipNozzleX(input.shape), 0.0);
  let plumeEnd = nozzle - vec2f(input.engine.x, 0.0);
  let plumeDistance = segmentDistance(input.local, nozzle, plumeEnd);
  let plumeAlong = clamp((nozzle.x - input.local.x) / max(input.engine.x, 1e-3), 0.0, 1.0);
  let plumeWidth = max(PLUME_HALF_WIDTH * (1.0 - 0.6 * plumeAlong), 0.5 * pixelUnits);
  let plume = input.engine.y * (1.0 - smoothstep(0.0, plumeWidth, plumeDistance)) * (1.0 - plumeAlong) * (1.0 - body) * edgeFade;
  return vec4f(input.color * (rim + fill + glow + plume), 0.0);
}
