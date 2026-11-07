// Bloom downsample: one bilinear tap at each half-resolution texel center averages the 2 by 2
// full-resolution block under it, of the scene plus the warp grid layer (so threat-lit grid
// ripples glow; the grid still never enters the trails). Prepended with fullscreen.wgsl.
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var grid: texture_2d<f32>;

@fragment
fn downsampleFragment(input: FullscreenOutput) -> @location(0) vec4f {
  return textureSampleLevel(source, linearSampler, input.uv, 0.0) + textureSampleLevel(grid, linearSampler, input.uv, 0.0);
}
