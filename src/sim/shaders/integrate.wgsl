// Integrate, in place, one thread per agent slot, after steer: position += velocity * dt; inside
// WALL_MARGIN of an edge the velocity gets a push toward the arena center proportional to the
// penetration depth; the position is then clamped to the arena so nothing escapes. Spawn-in
// frames count down by one. phase advances by dt * (2 + 0.5 * speed) radians and wraps at tau,
// so faster agents pulse faster. Dead agents are left untouched.

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> agents: array<Agent>;

const WALL_MARGIN: f32 = 0.5;
// Velocity change per second per world unit of penetration into the margin.
const WALL_STIFFNESS: f32 = 40.0;
const TAU: f32 = 6.283185307;

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  if (index >= params.capacity) {
    return;
  }
  var agent = agents[index];
  if (!isAlive(agent.flags)) {
    return;
  }
  agent.position = agent.position + agent.velocity * params.dt;
  let arena = vec2f(ARENA_WIDTH, ARENA_HEIGHT);
  let lowPenetration = max(vec2f(WALL_MARGIN) - agent.position, vec2f(0.0));
  let highPenetration = max(agent.position - (arena - vec2f(WALL_MARGIN)), vec2f(0.0));
  agent.velocity = agent.velocity + (lowPenetration - highPenetration) * WALL_STIFFNESS * params.dt;
  agent.position = clampToArena(agent.position);

  let spawnFrames = spawnFramesRemaining(agent.flags);
  if (spawnFrames > 0u) {
    let clearedFlags = agent.flags & ~(SPAWN_FRAMES_MASK << SPAWN_FRAMES_SHIFT);
    agent.flags = clearedFlags | ((spawnFrames - 1u) << SPAWN_FRAMES_SHIFT);
  }

  let advanced = agent.phase + params.dt * (2.0 + 0.5 * length(agent.velocity));
  agent.phase = advanced - TAU * floor(advanced / TAU);
  agents[index] = agent;
}
