// Writes each alive agent's index into its cell's range of sortedIndices.
// cellCursor is cleared by the encoder before dispatch; atomicAdd claims a slot in the cell.

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read> agents: array<Agent>;
@group(0) @binding(2) var<storage, read> cellOffsets: array<u32>;
@group(0) @binding(3) var<storage, read_write> cellCursor: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> sortedIndices: array<u32>;

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
  let slot = cellOffsets[cell] + atomicAdd(&cellCursor[cell], 1u);
  sortedIndices[slot] = index;
}
