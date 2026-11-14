// Density readback sum (src/sim/density-readback.js): one thread per coarse cell adds the five
// species density channels of the blurred coarse field into one f32 per cell. The threat and
// padding channels are never read.
@group(0) @binding(0) var<storage, read> field: array<f32>;
@group(0) @binding(1) var<storage, read_write> density: array<f32>;

const CELL_COUNT: u32 = __COARSE_COLUMNS__u * __COARSE_ROWS__u;

@compute @workgroup_size(__WORKGROUP_SIZE__)
fn sum(@builtin(global_invocation_id) globalId: vec3u) {
  let cell = globalId.x;
  if (cell >= CELL_COUNT) {
    return;
  }
  var total = 0.0;
  for (var species = 0u; species < __SPECIES_COUNT__u; species = species + 1u) {
    total = total + field[cell * __COARSE_CHANNELS__u + species];
  }
  density[cell] = total;
}
