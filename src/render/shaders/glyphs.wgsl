// Agent ships: one instance per agent slot, a 4-vertex triangle strip pulled from the agent
// buffer. Dead agents collapse to a degenerate quad. common.wgsl and ships.wgsl are prepended.
// The quad is shipDevicePixels * glowScale device pixels wide, rotated so local +x is the heading;
// the ship body lies inside radius 1 and the glow and engine plume reach out to radius glowScale.
// Heading: the velocity direction, blended toward the player at low speed (agents carry no
// heading), so idle and spawning ships face the player instead of snapping to an arbitrary axis.
// Shading: a one-pixel rim in the species hue, a fill at FILL_BRIGHTNESS of it, a soft halo and an
// engine plume whose length follows speed / maximumSpeed and pulses with phase. Spawning ships are
// rim only and fill in over SPAWN_IN_FRAMES.
// Position is extrapolated by velocity * alpha * dt so rendering between fixed steps stays smooth;
// at half simulation rate (view.interpolation 1) it is instead mixed from the previous step's
// position (previousAgents, the last step's input) to the newest by alpha, one step behind.
// Density attenuation works in screen coverage: the coarse density (agents per cell) times
// coverageScale (ship body area over coarse cell area, in device pixels) is the fraction of the
// cell that ship bodies cover, and each ship is divided by 1 + COVERAGE_ATTENUATION * coverage,
// but never below ATTENUATION_FLOOR (capped so the floor's summed radiance stays under
// MAXIMUM_CROWD_RADIANCE), so dense cores stay bright and colored rather than murky.
// emissionScale (trailFrameFactors) keeps steady-state brightness refresh-independent.

// Uniform layout (byte offsets), total 64 bytes; packShipView in glyphs.js writes it.
//   0 worldToClipScale    vec2f
//   8 worldToClipOffset   vec2f
//  16 devicePixelToClip   vec2f
//  24 shipDevicePixels    f32 (ship length, shipDevicePixels in glyphs.js, zoom included)
//  28 glowScale           f32
//  32 alpha               f32
//  36 time                f32
//  40 coverageScale       f32 (ship body area / coarse cell area, on-screen device pixels)
//  44 emissionScale       f32
//  48 interpolation       f32 (1 interpolate from previousAgents, 0 extrapolate)
//  52 padding             3 x f32
struct GlyphView {
  worldToClipScale: vec2f,
  worldToClipOffset: vec2f,
  devicePixelToClip: vec2f,
  shipDevicePixels: f32,
  glowScale: f32,
  alpha: f32,
  time: f32,
  coverageScale: f32,
  emissionScale: f32,
  interpolation: f32,
  paddingFirst: f32,
  paddingSecond: f32,
  paddingThird: f32,
}

@group(0) @binding(0) var<uniform> view: GlyphView;
@group(0) @binding(1) var<uniform> params: SimParams;
@group(0) @binding(2) var<storage, read> agents: array<Agent>;
@group(0) @binding(3) var<storage, read> field: array<vec4f>;
@group(0) @binding(4) var<storage, read> speciesTable: array<f32>;
@group(0) @binding(5) var<storage, read> previousAgents: array<Agent>;

const HUE_JITTER_RANGE: f32 = 0.03;
const GLYPH_SATURATION: f32 = 0.8;
const COVERAGE_ATTENUATION: f32 = 4.0;
// Lowest brightness factor the density attenuation may apply, so crowds stay bright and colored.
const ATTENUATION_FLOOR: f32 = 0.3;
// Ceiling on the floor's summed radiance (floor times coverage): past it the floor falls off as
// 1 / coverage, so a full ramp under trails does not saturate into a white smear.
const MAXIMUM_CROWD_RADIANCE: f32 = 0.75;
const GLOW_INTENSITY: f32 = 0.05;
const GLOW_FALLOFF: f32 = 3.0;
const SPAWN_PULSE_RATE: f32 = 18.0;
// Fill brightness relative to the rim.
const FILL_BRIGHTNESS: f32 = 0.25;
// Below this speed (world units per second) the heading turns toward the player.
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

// Turns from the player direction toward the travel direction by smoothstep(0, HEADING_IDLE_SPEED,
// speed) of the shorter arc between them. Rotating an angle never passes through a zero vector
// (summed directions cancel for a slow retreat and snapped to +x), so stopped ships face the
// player and ships at HEADING_IDLE_SPEED or faster face where they travel, retreating ones too.
fn shipHeading(position: vec2f, velocity: vec2f) -> vec2f {
  let speed = length(velocity);
  let toPlayer = params.playerPosition - position;
  let travelAngle = select(0.0, atan2(velocity.y, velocity.x), speed > 1e-6);
  let playerAngle = select(travelAngle, atan2(toPlayer.y, toPlayer.x), length(toPlayer) > 1e-4);
  let travelWeight = smoothstep(0.0, HEADING_IDLE_SPEED, speed);
  let arc = travelAngle - playerAngle;
  let shorterArc = arc - TAU * floor(arc / TAU + 0.5);
  let angle = playerAngle + shorterArc * travelWeight;
  return vec2f(cos(angle), sin(angle));
}

@vertex
fn glyphVertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> GlyphVaryings {
  var output: GlyphVaryings;
  let agent = agents[instanceIndex];
  // A zero glyph or glow size (the smoke hides glyphs this way) collapses early, so the fragment
  // stage never divides by it.
  if (!isAlive(agent.flags) || view.shipDevicePixels <= 0.0 || view.glowScale <= 0.0) {
    output.position = vec4f(2.0, 2.0, 0.0, 1.0);
    output.local = vec2f(0.0);
    output.color = vec3f(0.0);
    output.shape = 0u;
    output.engine = vec3f(0.0);
    return output;
  }
  let corner = vec2f(f32(vertexIndex & 1u), f32(vertexIndex >> 1u)) * 2.0 - vec2f(1.0);
  var position = clampToArena(agent.position + agent.velocity * view.alpha * params.dt);
  if (view.interpolation > 0.5) {
    // A slot dead in the previous step has no earlier position; it starts where it is.
    let previous = previousAgents[instanceIndex];
    let start = select(agent.position, previous.position, isAlive(previous.flags));
    position = clampToArena(mix(start, agent.position, view.alpha));
  }
  let forward = shipHeading(position, agent.velocity);
  let side = vec2f(-forward.y, forward.x);
  // World and device pixels both grow y downward, so the world direction is the screen direction.
  let offsetDevicePixels = (forward * corner.x + side * corner.y) * (0.5 * view.shipDevicePixels * view.glowScale);
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
  let attenuationFloor = min(ATTENUATION_FLOOR, MAXIMUM_CROWD_RADIANCE / max(coverage, 1e-6));
  let attenuation = max(1.0 / (1.0 + COVERAGE_ATTENUATION * coverage), attenuationFloor);
  var alpha = select(calmPulse, spawnPulse, spawning) * attenuation;
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
  // One device pixel spans 2 / shipDevicePixels local units; the body edge is antialiased over it
  // and the rim is the outermost pixel inside the edge.
  let pixelUnits = 2.0 / view.shipDevicePixels;
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
