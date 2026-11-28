// Bloom downsample of the scene plus the warp grid layer (so threat-lit grid ripples glow; the grid
// still never enters the trails). Prepended with fullscreen.wgsl.
// At half resolution (high) one bilinear tap at the output texel center averages exactly the
// 2 by 2 full-resolution block under it. At a third or a quarter (medium, low) one tap would see
// only 2 by 2 of the 3 by 3 or 4 by 4 pixels the texel covers, so a thin feature that moves
// across the texel grid would blink in and out. There four bilinear taps, at plus or minus a
// fixed offset along each axis, cover the whole block with equal weight: the offset is a third of
// (pixels per output texel minus one), which is a quarter of an output texel at a quarter
// resolution (taps land on pixel corners, each averaging a 2 by 2 block) and two thirds of a pixel
// at a third (a quarter texel there would weight the middle pixel 1/4 against 3/8 for its
// neighbors; two thirds weights all three equally).
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var grid: texture_2d<f32>;

const BOX_RATIO: f32 = 2.5;

fn sampleBoth(uv: vec2f) -> vec4f {
  return textureSampleLevel(source, linearSampler, uv, 0.0) + textureSampleLevel(grid, linearSampler, uv, 0.0);
}

@fragment
fn downsampleFragment(input: FullscreenOutput) -> @location(0) vec4f {
  // Derivatives need uniform control flow, so they come before the branch.
  let sourceTexel = 1.0 / vec2f(textureDimensions(source));
  let outputTexel = vec2f(abs(dpdx(input.uv.x)), abs(dpdy(input.uv.y)));
  if (outputTexel.x < BOX_RATIO * sourceTexel.x) {
    return sampleBoth(input.uv);
  }
  let offset = (outputTexel - sourceTexel) / 3.0;
  return 0.25 * (
    sampleBoth(input.uv + vec2f(offset.x, offset.y)) +
    sampleBoth(input.uv + vec2f(offset.x, -offset.y)) +
    sampleBoth(input.uv + vec2f(-offset.x, offset.y)) +
    sampleBoth(input.uv + vec2f(-offset.x, -offset.y))
  );
}
