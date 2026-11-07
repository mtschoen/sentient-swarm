// Fullscreen triangle vertex stage, prepended to every full-screen render pass.
// Three vertices cover the whole target; uv is (0, 0) at the top left, (1, 1) at the bottom right.
struct FullscreenOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn fullscreenVertex(@builtin(vertex_index) vertexIndex: u32) -> FullscreenOutput {
  let corner = vec2f(f32((vertexIndex << 1u) & 2u), f32(vertexIndex & 2u));
  var output: FullscreenOutput;
  output.position = vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
  output.uv = vec2f(corner.x, 1.0 - corner.y);
  return output;
}
