// Integrate, in place, one thread per agent slot, after steer: position += velocity * dt; inside
// params.wallMargin of an edge of the arena bounds (params.worldBounds) the velocity gets a push
// toward the arena center proportional to the penetration depth; the position is then clamped to
// the bounds so nothing escapes. Spawn-in
// frames count down by one. phase advances by dt * (2 + 0.5 * speed) radians and wraps at tau,
// so faster agents pulse faster. Dead agents are left untouched.

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> agents: array<Agent>;

// The margin (0.5 by default) and the stiffness (velocity change per second per world unit of
// penetration, 40 by default) are SimParams fields so the lab can tune them.

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
  let lowPenetration = max(params.worldBounds.xy + vec2f(params.wallMargin) - agent.position, vec2f(0.0));
  let highPenetration = max(agent.position - (params.worldBounds.zw - vec2f(params.wallMargin)), vec2f(0.0));
  agent.velocity = agent.velocity + (lowPenetration - highPenetration) * params.wallStiffness * params.dt;
  agent.position = clampToBounds(agent.position, params);

  let spawnFrames = spawnFramesRemaining(agent.flags);
  if (spawnFrames > 0u) {
    let clearedFlags = agent.flags & ~(SPAWN_FRAMES_MASK << SPAWN_FRAMES_SHIFT);
    agent.flags = clearedFlags | ((spawnFrames - 1u) << SPAWN_FRAMES_SHIFT);
  }

  let advanced = agent.phase + params.dt * (2.0 + 0.5 * length(agent.velocity));
  agent.phase = advanced - TAU * floor(advanced / TAU);
  agents[index] = agent;
}
