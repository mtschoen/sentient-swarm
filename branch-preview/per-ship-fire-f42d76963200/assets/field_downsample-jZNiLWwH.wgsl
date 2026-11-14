// Coarse species field, step 1 of 2 (field_blur.wgsl is step 2).
// accumulate: one thread per sorted slot, so a workgroup's agents are spatially coherent and
//   usually share one coarse cell. A full per-cell histogram (2304 cells by 5 species) does not
//   fit 16 KB of workgroup memory, so the fast path only handles a workgroup whose agents
//   all share one coarse cell: it counts per species in 5 workgroup atomics and one thread
//   flushes them with 5 global atomicAdds. Otherwise every thread adds its own agent globally.
//   Densities are fixed point: one agent adds THREAT_FIXED_POINT_SCALE.
//   Threads at or beyond the alive total touch no agent or index buffer, but they cannot return
//   early: every workgroupBarrier must stay in uniform control flow (FXC enforces this).
// convert: one thread per coarse cell turns the density accumulators into floats (agents per
//   coarse cell) and folds the threat accumulator into channel 5 with a 0.85 decay, then zeroes
//   the threat accumulator entry. densityAccumulator is cleared by the encoder every frame.

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read> agents: array<Agent>;
@group(0) @binding(2) var<storage, read> cellCounts: array<u32>;
@group(0) @binding(3) var<storage, read> cellOffsets: array<u32>;
@group(0) @binding(4) var<storage, read> sortedIndices: array<u32>;
@group(0) @binding(5) var<storage, read_write> densityAccumulator: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> threatAccumulator: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> raw: array<f32>;

const THREAT_DECAY: f32 = 0.85;
const NO_CELL: u32 = 0xffffffffu;

var<workgroup> minimumCell: atomic<u32>;
var<workgroup> maximumCell: atomic<u32>;
var<workgroup> workgroupSpeciesCounts: array<atomic<u32>, SPECIES_COUNT>;

fn aliveTotal() -> u32 {
  let lastCell = params.gridColumns * params.gridRows - 1u;
  return cellOffsets[lastCell] + cellCounts[lastCell];
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn accumulate(
  @builtin(global_invocation_id) globalId: vec3u,
  @builtin(local_invocation_index) localIndex: u32,
) {
  if (localIndex == 0u) {
    atomicStore(&minimumCell, NO_CELL);
    atomicStore(&maximumCell, 0u);
  }
  workgroupBarrier();

  let slot = globalId.x;
  let hasAgent = slot < params.capacity && slot < aliveTotal();
  var cell = 0u;
  var species = 0u;
  if (hasAgent) {
    let agent = agents[sortedIndices[slot]];
    cell = coarseCellIndexFor(agent.position);
    species = min(agent.species, SPECIES_COUNT - 1u);
    atomicMin(&minimumCell, cell);
    atomicMax(&maximumCell, cell);
  }
  workgroupBarrier();

  // Every thread reads the same values: no atomic writes happen between the barriers.
  let sharedCell = atomicLoad(&minimumCell);
  let singleCell = sharedCell == atomicLoad(&maximumCell);
  if (hasAgent) {
    if (singleCell) {
      atomicAdd(&workgroupSpeciesCounts[species], 1u);
    } else {
      atomicAdd(&densityAccumulator[cell * SPECIES_COUNT + species], u32(THREAT_FIXED_POINT_SCALE));
    }
  }
  workgroupBarrier();

  if (singleCell && localIndex == 0u) {
    for (var flushSpecies = 0u; flushSpecies < SPECIES_COUNT; flushSpecies = flushSpecies + 1u) {
      let count = atomicLoad(&workgroupSpeciesCounts[flushSpecies]);
      if (count > 0u) {
        atomicAdd(&densityAccumulator[sharedCell * SPECIES_COUNT + flushSpecies], count * u32(THREAT_FIXED_POINT_SCALE));
      }
    }
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn convert(@builtin(global_invocation_id) globalId: vec3u) {
  let cell = globalId.x;
  if (cell >= COARSE_COLUMNS * COARSE_ROWS) {
    return;
  }
  let base = cell * COARSE_CHANNELS;
  for (var species = 0u; species < SPECIES_COUNT; species = species + 1u) {
    raw[base + species] = f32(atomicLoad(&densityAccumulator[cell * SPECIES_COUNT + species])) / THREAT_FIXED_POINT_SCALE;
  }
  let accumulatedThreat = f32(atomicExchange(&threatAccumulator[cell], 0u)) / THREAT_FIXED_POINT_SCALE;
  raw[base + THREAT_CHANNEL] = raw[base + THREAT_CHANNEL] * THREAT_DECAY + accumulatedThreat;
  for (var padding = THREAT_CHANNEL + 1u; padding < COARSE_CHANNELS; padding = padding + 1u) {
    raw[base + padding] = 0.0;
  }
}
