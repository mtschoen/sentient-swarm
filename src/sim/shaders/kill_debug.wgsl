// Debug kill, one thread per agent slot, run on agentsOut after integrate and before stats.
// An agent is killed when it is alive, past its spawn-in frames (spawning agents cannot be
// killed), and within params.debugKillRadius of params.debugKillPosition. The alive bit is
// cleared with atomicAnd and the kill only counts when the old flags had it, so concurrent
// killers never double count. Each kill then:
//   adds 1 to the kills stat (reduced per workgroup, one global atomicAdd from thread 0),
//   claims KILL_PARTICLE_COUNT particle slots with one atomicAdd on the cursor (wrapping modulo
//   the pool capacity) and writes particles radiating from the agent in its species hue,
//   adds one threat unit (THREAT_FIXED_POINT_SCALE fixed point) to its coarse cell.
// The barrier sits outside every branch; threads past capacity still reach it.

// Same 32-byte layout as Agent with the flags word atomic.
struct AtomicAgent {
  position: vec2f,
  velocity: vec2f,
  species: u32,
  flags: atomic<u32>,
  phase: f32,
  hueJitter: f32,
}

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> agents: array<AtomicAgent>;
@group(0) @binding(2) var<storage, read_write> stats: array<atomic<u32>, 8>;
@group(0) @binding(3) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(4) var<storage, read_write> particleCursor: atomic<u32>;
@group(0) @binding(5) var<storage, read_write> threatAccumulator: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read> speciesTable: array<f32>;

const STAT_KILLS: u32 = 6u;
const KILL_PARTICLE_COUNT: u32 = 6u;
const MINIMUM_SPEED: f32 = 1.5;
const SPEED_RANGE: f32 = 1.5;
const MINIMUM_LIFETIME: f32 = 0.4;
const LIFETIME_RANGE: f32 = 0.3;
const HUE_JITTER_SPREAD: f32 = 0.05;
const PARTICLE_SATURATION: f32 = 0.8;

var<workgroup> workgroupKills: atomic<u32>;

fn emitKillParticles(slot: u32, position: vec2f, species: u32, hueJitter: f32) {
  let capacity = arrayLength(&particles);
  let first = atomicAdd(&particleCursor, KILL_PARTICLE_COUNT) % capacity;
  let hue = speciesTable[speciesFieldIndex(species, SPECIES_FIELD_HUE)];
  let color = packColor(hsvToRgb(fract(hue + HUE_JITTER_SPREAD * hueJitter), PARTICLE_SATURATION, 1.0));
  var randomState = pcgHash(slot ^ pcgHash(params.frameSequence * 2u + 1u));
  let rotation = nextRandom(&randomState) * TAU;
  for (var index = 0u; index < KILL_PARTICLE_COUNT; index = index + 1u) {
    let angle = rotation + f32(index) * TAU / f32(KILL_PARTICLE_COUNT);
    var particle: Particle;
    particle.position = position;
    particle.velocity = vec2f(cos(angle), sin(angle)) * (MINIMUM_SPEED + SPEED_RANGE * nextRandom(&randomState));
    particle.color = color;
    particle.age = 0.0;
    particle.lifetime = MINIMUM_LIFETIME + LIFETIME_RANGE * nextRandom(&randomState);
    particle.padding = 0.0;
    particles[(first + index) % capacity] = particle;
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(
  @builtin(global_invocation_id) globalId: vec3u,
  @builtin(local_invocation_index) localIndex: u32,
) {
  let slot = globalId.x;
  if (slot < params.capacity) {
    let flags = atomicLoad(&agents[slot].flags);
    let position = agents[slot].position;
    if (isAlive(flags) && spawnFramesRemaining(flags) == 0u && distance(position, params.debugKillPosition) <= params.debugKillRadius) {
      let previousFlags = atomicAnd(&agents[slot].flags, ~FLAG_ALIVE);
      if (isAlive(previousFlags)) {
        atomicAdd(&workgroupKills, 1u);
        emitKillParticles(slot, position, min(agents[slot].species, SPECIES_COUNT - 1u), agents[slot].hueJitter);
        atomicAdd(&threatAccumulator[coarseCellIndexFor(position)], u32(THREAT_FIXED_POINT_SCALE));
      }
    }
  }
  workgroupBarrier();

  if (localIndex == 0u) {
    let kills = atomicLoad(&workgroupKills);
    if (kills > 0u) {
      atomicAdd(&stats[STAT_KILLS], kills);
    }
  }
}
