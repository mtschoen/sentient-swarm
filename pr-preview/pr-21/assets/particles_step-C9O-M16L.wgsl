// Particle step, one thread per particle slot, after every kill pass. Dead slots (lifetime <= 0
// or age >= lifetime) are untouched. A live particle ages by dt, moves by its velocity, and loses
// speed to drag. The particles still alive afterwards are counted into the pool header's
// liveCount (zeroed just before this pass, one atomicAdd per workgroup); the next step's kills
// budget their bursts against the free slots it leaves. The barrier sits outside every branch.

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> pool: ParticlePool;

const DRAG_PER_SECOND: f32 = 3.0;

var<workgroup> workgroupLive: atomic<u32>;

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(
  @builtin(global_invocation_id) globalId: vec3u,
  @builtin(local_invocation_index) localIndex: u32,
) {
  let slot = globalId.x;
  if (slot < arrayLength(&pool.particles)) {
    var particle = pool.particles[slot];
    if (isParticleAlive(particle)) {
      particle.age = particle.age + params.dt;
      particle.position = particle.position + particle.velocity * params.dt;
      particle.velocity = particle.velocity * max(0.0, 1.0 - DRAG_PER_SECOND * params.dt);
      pool.particles[slot] = particle;
      if (isParticleAlive(particle)) {
        atomicAdd(&workgroupLive, 1u);
      }
    }
  }
  workgroupBarrier();

  if (localIndex == 0u) {
    let live = atomicLoad(&workgroupLive);
    if (live > 0u) {
      atomicAdd(&pool.liveCount, live);
    }
  }
}
