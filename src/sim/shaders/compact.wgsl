// Capacity change compaction, one thread per slot of the new agent buffer. The spatial grid lists
// every alive agent of the old buffer in sortedIndices (grid order, cellOffsets is the exclusive
// prefix sum of cellCounts); slot i of the new buffer receives the i-th listed agent, so a shrink
// keeps every alive agent that fits instead of a slot prefix. Slots past the listed count stay as
// created (zero, dead). params is the old simulation's SimParams, which the grid was built with.

struct CompactLimits {
  targetCapacity: u32,
  padding0: u32,
  padding1: u32,
  padding2: u32,
}

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<uniform> limits: CompactLimits;
@group(0) @binding(2) var<storage, read> cellCounts: array<u32>;
@group(0) @binding(3) var<storage, read> cellOffsets: array<u32>;
@group(0) @binding(4) var<storage, read> sortedIndices: array<u32>;
@group(0) @binding(5) var<storage, read> agentsIn: array<Agent>;
@group(0) @binding(6) var<storage, read_write> agentsOut: array<Agent>;

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let slot = globalId.x;
  if (slot >= limits.targetCapacity) {
    return;
  }
  let lastCell = params.gridColumns * params.gridRows - 1u;
  let listedCount = cellOffsets[lastCell] + cellCounts[lastCell];
  if (slot >= listedCount) {
    return;
  }
  agentsOut[slot] = agentsIn[sortedIndices[slot]];
}
