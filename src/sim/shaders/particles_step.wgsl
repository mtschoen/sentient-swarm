// Particle step, one thread per particle slot. Dead slots (lifetime <= 0 or age >= lifetime) are
// untouched. A live particle ages by dt, moves by its velocity, and loses speed to drag.

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

const DRAG_PER_SECOND: f32 = 3.0;

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let slot = globalId.x;
  if (slot >= arrayLength(&particles)) {
    return;
  }
  var particle = particles[slot];
  if (!isParticleAlive(particle)) {
    return;
  }
  particle.age = particle.age + params.dt;
  particle.position = particle.position + particle.velocity * params.dt;
  particle.velocity = particle.velocity * max(0.0, 1.0 - DRAG_PER_SECOND * params.dt);
  particles[slot] = particle;
}
