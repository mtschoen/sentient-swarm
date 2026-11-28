// Two-level exclusive prefix sum of cellCounts into cellOffsets.
// scanBlocks: one workgroup per 256-cell block, writes block-local offsets and the block total.
// scanBlockSums: a single workgroup scans the block totals (at most WORKGROUP_SIZE blocks).
// addBlockOffsets: adds each block's scanned total back onto its cells.
// Every workgroupBarrier sits in uniform control flow; only loads and stores are guarded.

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read> cellCounts: array<u32>;
@group(0) @binding(2) var<storage, read_write> cellOffsets: array<u32>;
@group(0) @binding(3) var<storage, read_write> blockSums: array<u32>;

var<workgroup> scratch: array<u32, WORKGROUP_SIZE>;

fn cellCount() -> u32 {
  return params.gridColumns * params.gridRows;
}

// Inclusive Hillis-Steele scan of scratch in place.
fn scanScratch(localIndex: u32) {
  for (var stride = 1u; stride < WORKGROUP_SIZE; stride = stride * 2u) {
    workgroupBarrier();
    var addend = 0u;
    if (localIndex >= stride) {
      addend = scratch[localIndex - stride];
    }
    workgroupBarrier();
    scratch[localIndex] = scratch[localIndex] + addend;
  }
  workgroupBarrier();
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn scanBlocks(
  @builtin(global_invocation_id) globalId: vec3u,
  @builtin(local_invocation_index) localIndex: u32,
  @builtin(workgroup_id) workgroupId: vec3u,
) {
  let index = globalId.x;
  var value = 0u;
  if (index < cellCount()) {
    value = cellCounts[index];
  }
  scratch[localIndex] = value;
  scanScratch(localIndex);
  if (index < cellCount()) {
    cellOffsets[index] = scratch[localIndex] - value;
  }
  if (localIndex == WORKGROUP_SIZE - 1u) {
    blockSums[workgroupId.x] = scratch[localIndex];
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn scanBlockSums(@builtin(local_invocation_index) localIndex: u32) {
  let blockCount = (cellCount() + WORKGROUP_SIZE - 1u) / WORKGROUP_SIZE;
  var value = 0u;
  if (localIndex < blockCount) {
    value = blockSums[localIndex];
  }
  scratch[localIndex] = value;
  scanScratch(localIndex);
  if (localIndex < blockCount) {
    blockSums[localIndex] = scratch[localIndex] - value;
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn addBlockOffsets(
  @builtin(global_invocation_id) globalId: vec3u,
  @builtin(workgroup_id) workgroupId: vec3u,
) {
  let index = globalId.x;
  if (index < cellCount()) {
    cellOffsets[index] = cellOffsets[index] + blockSums[workgroupId.x];
  }
}
