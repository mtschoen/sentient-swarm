// Kill particles: one instance per pool slot, a 4-vertex triangle strip pulled from the particle
// buffer, particleDevicePixels wide. Dead slots collapse to a degenerate quad. The color is the
// packed rgba8 particle color, faded by 1 - age / lifetime, with a soft round falloff.
// Common header prepended.

// Uniform layout (byte offsets), total 32 bytes; packParticleView in particles.js writes it.
//   0 worldToClipScale       vec2f
//   8 worldToClipOffset      vec2f
//  16 devicePixelToClip      vec2f
//  24 particleDevicePixels   f32 (already multiplied by the inspect zoom)
//  28 padding                f32
struct ParticleView {
  worldToClipScale: vec2f,
  worldToClipOffset: vec2f,
  devicePixelToClip: vec2f,
  particleDevicePixels: f32,
  padding: f32,
}

@group(0) @binding(0) var<uniform> view: ParticleView;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

const PARTICLE_INTENSITY: f32 = 0.4;

struct ParticleVaryings {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) color: vec3f,
}

@vertex
fn particleVertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> ParticleVaryings {
  var output: ParticleVaryings;
  let particle = particles[instanceIndex];
  if (!isParticleAlive(particle)) {
    output.position = vec4f(2.0, 2.0, 0.0, 1.0);
    output.local = vec2f(0.0);
    output.color = vec3f(0.0);
    return output;
  }
  let corner = vec2f(f32(vertexIndex & 1u), f32(vertexIndex >> 1u)) * 2.0 - vec2f(1.0);
  let center = particle.position * view.worldToClipScale + view.worldToClipOffset;
  let offsetDevicePixels = corner * (0.5 * view.particleDevicePixels);
  output.position = vec4f(center + offsetDevicePixels * view.devicePixelToClip * vec2f(1.0, -1.0), 0.0, 1.0);
  output.local = corner;
  let fade = 1.0 - clamp(particle.age / particle.lifetime, 0.0, 1.0);
  output.color = unpack4x8unorm(particle.color).rgb * fade * PARTICLE_INTENSITY;
  return output;
}

@fragment
fn particleFragment(input: ParticleVaryings) -> @location(0) vec4f {
  let falloff = clamp(1.0 - dot(input.local, input.local), 0.0, 1.0);
  return vec4f(input.color * falloff * falloff, 0.0);
}
