// Coarse species field, step 2 of 2: a single-pass 3x3 binomial blur (weights 1 2 1 by 1 2 1)
// of every channel of raw into blurred, one thread per coarse cell. At the arena edge the
// out-of-range taps are dropped and the remaining weights renormalized, so a uniform field
// stays uniform up to the walls instead of fading.

@group(0) @binding(0) var<storage, read> raw: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> blurred: array<vec4f>;

// raw and blurred hold COARSE_CHANNELS floats per cell as vec4 pairs: channels 0..3, then 4..7.
const VECTORS_PER_CELL: u32 = COARSE_CHANNELS / 4u;

@compute @workgroup_size(WORKGROUP_SIZE)
fn blur(@builtin(global_invocation_id) globalId: vec3u) {
  let cell = globalId.x;
  if (cell >= COARSE_COLUMNS * COARSE_ROWS) {
    return;
  }
  let column = i32(cell % COARSE_COLUMNS);
  let row = i32(cell / COARSE_COLUMNS);
  var low = vec4f(0.0);
  var high = vec4f(0.0);
  var weightTotal = 0.0;
  for (var rowOffset = -1; rowOffset <= 1; rowOffset = rowOffset + 1) {
    for (var columnOffset = -1; columnOffset <= 1; columnOffset = columnOffset + 1) {
      let sampleColumn = column + columnOffset;
      let sampleRow = row + rowOffset;
      let inside = sampleColumn >= 0 && sampleColumn < i32(COARSE_COLUMNS) && sampleRow >= 0 && sampleRow < i32(COARSE_ROWS);
      if (inside) {
        let weight = f32((2 - abs(columnOffset)) * (2 - abs(rowOffset)));
        let sampleCell = u32(sampleColumn) + u32(sampleRow) * COARSE_COLUMNS;
        low = low + raw[sampleCell * VECTORS_PER_CELL] * weight;
        high = high + raw[sampleCell * VECTORS_PER_CELL + 1u] * weight;
        weightTotal = weightTotal + weight;
      }
    }
  }
  blurred[cell * VECTORS_PER_CELL] = low / weightTotal;
  blurred[cell * VECTORS_PER_CELL + 1u] = high / weightTotal;
}
