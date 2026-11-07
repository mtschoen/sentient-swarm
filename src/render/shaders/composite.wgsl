// Composite: scene plus bloom times bloomStrength, ACES-fitted tonemap (load-bearing: additive
// glyphs saturate dense regions), gamma encode for the non-sRGB swapchain, and black letterbox
// bands outside the arena rect. Prepended with fullscreen.wgsl.
struct CompositeUniform {
  arenaRect: vec4f,
  bloomStrength: f32,
  padding0: f32,
  padding1: f32,
  padding2: f32,
}

@group(0) @binding(0) var<uniform> composite: CompositeUniform;
@group(0) @binding(1) var scene: texture_2d<f32>;
@group(0) @binding(2) var bloom: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;

// Scene radiance scale ahead of the tonemap: trails at decay 0.9 hold about ten frames of glyphs.
const EXPOSURE: f32 = 0.15;

// Narkowicz 2015 fit of the ACES filmic curve.
fn acesFitted(color: vec3f) -> vec3f {
  let numerator = color * (2.51 * color + 0.03);
  let denominator = color * (2.43 * color + 0.59) + 0.14;
  return clamp(numerator / denominator, vec3f(0.0), vec3f(1.0));
}

@fragment
fn compositeFragment(input: FullscreenOutput) -> @location(0) vec4f {
  let pixel = input.position.xy;
  let rect = composite.arenaRect;
  let inside = all(pixel >= rect.xy) && all(pixel < rect.xy + rect.zw);
  let sceneColor = textureLoad(scene, vec2i(pixel), 0).rgb;
  let bloomColor = textureSampleLevel(bloom, linearSampler, input.uv, 0.0).rgb;
  let mapped = acesFitted((sceneColor + bloomColor * composite.bloomStrength) * EXPOSURE);
  let encoded = pow(mapped, vec3f(1.0 / 2.2));
  return vec4f(select(vec3f(0.0), encoded, inside), 1.0);
}
