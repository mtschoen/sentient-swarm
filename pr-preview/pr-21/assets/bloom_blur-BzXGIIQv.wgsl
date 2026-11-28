// Separable 9-tap Gaussian blur at half resolution; step is (1, 0) for the horizontal pass and
// (0, 1) for the vertical one. Prepended with fullscreen.wgsl.
struct BlurUniform {
  step: vec2i,
  padding: vec2i,
}

@group(0) @binding(0) var<uniform> blur: BlurUniform;
@group(0) @binding(1) var source: texture_2d<f32>;

@fragment
fn blurFragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  var weights = array<f32, 5>(0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162);
  let lastTexel = vec2i(textureDimensions(source)) - vec2i(1);
  let center = vec2i(position.xy);
  var total = textureLoad(source, center, 0) * weights[0];
  for (var tap = 1; tap < 5; tap += 1) {
    let offset = blur.step * tap;
    let forward = textureLoad(source, clamp(center + offset, vec2i(0), lastTexel), 0);
    let backward = textureLoad(source, clamp(center - offset, vec2i(0), lastTexel), 0);
    total += (forward + backward) * weights[tap];
  }
  return total;
}
