// Stats, one thread per agent slot. Layout of stats (u32):
//   0 aliveTotal, 1..5 alive per species, 6 kills, 7 frameSequence.
// Each workgroup counts its alive agents in workgroup atomics, then thread 0 flushes every
// nonzero counter with one global atomicAdd. Global thread 0 stores params.frameSequence.
// kills (index 6) is never touched here: the encoder clears the buffer at the start of the
// frame and kill passes add to it. Threads past capacity read no agent but still reach the
// barrier, which must stay in uniform control flow (FXC enforces this).

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read> agents: array<Agent>;
@group(0) @binding(2) var<storage, read_write> stats: array<atomic<u32>, 8>;

const STAT_ALIVE_TOTAL: u32 = 0u;
const STAT_FIRST_SPECIES: u32 = 1u;
const STAT_FRAME_SEQUENCE: u32 = 7u;
const COUNTER_COUNT: u32 = SPECIES_COUNT + 1u;

var<workgroup> workgroupCounters: array<atomic<u32>, COUNTER_COUNT>;

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(
  @builtin(global_invocation_id) globalId: vec3u,
  @builtin(local_invocation_index) localIndex: u32,
) {
  let slot = globalId.x;
  if (slot < params.capacity) {
    let agent = agents[slot];
    if (isAlive(agent.flags)) {
      atomicAdd(&workgroupCounters[STAT_ALIVE_TOTAL], 1u);
      atomicAdd(&workgroupCounters[STAT_FIRST_SPECIES + min(agent.species, SPECIES_COUNT - 1u)], 1u);
    }
  }
  workgroupBarrier();

  if (localIndex == 0u) {
    for (var counter = 0u; counter < COUNTER_COUNT; counter = counter + 1u) {
      let count = atomicLoad(&workgroupCounters[counter]);
      if (count > 0u) {
        atomicAdd(&stats[counter], count);
      }
    }
  }
  if (slot == 0u) {
    atomicStore(&stats[STAT_FRAME_SEQUENCE], params.frameSequence);
  }
}
