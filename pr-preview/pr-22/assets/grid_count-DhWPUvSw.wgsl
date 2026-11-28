// Counts alive agents per grid cell. cellCounts is cleared by the encoder before dispatch.

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read> agents: array<Agent>;
@group(0) @binding(2) var<storage, read_write> cellCounts: array<atomic<u32>>;

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  if (index >= params.capacity) {
    return;
  }
  if (!isAlive(agents[index].flags)) {
    return;
  }
  let cell = cellIndexFor(agents[index].position, params);
  atomicAdd(&cellCounts[cell], 1u);
}
