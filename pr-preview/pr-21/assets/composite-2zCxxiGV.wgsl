// Composite: scene plus the warp grid layer plus bloom times bloomStrength, times exposure, an
// ACES-fitted tonemap of the luminance (load-bearing: additive glyphs pile up in dense regions),
// gamma encode for the non-sRGB swapchain, and black letterbox bands outside the arena rect.
// During a time warp (timeWarp 0 to 1) the mapped color blends toward a cold desaturated blue of
// the same luminance, at most TIME_WARP_TINT_MAXIMUM of the way.
// Prepended with fullscreen.wgsl.
// Why luminance: a per-channel curve drives every channel toward 1 as radiance grows, so a dense
// core turns white even though each glyph is a saturated hue (GLYPH_SATURATION leaves a 0.2 white
// floor on the minor channels that the curve lifts to about 0.9). Mapping the luminance and
// scaling the color by mapped / original keeps the hue; dividing by the largest channel when it
// passes 1 keeps the saturation instead of clipping one channel.
struct CompositeUniform {
  arenaRect: vec4f,
  bloomStrength: f32,
  // Scene radiance scale ahead of the tonemap (composite.js BASE_EXPOSURE times the renderer's
  // exposure setting).
  exposure: f32,
  // Time warp strength, 0 (none) to 1 (full).
  timeWarp: f32,
  padding: f32,
}

@group(0) @binding(0) var<uniform> composite: CompositeUniform;
@group(0) @binding(1) var scene: texture_2d<f32>;
@group(0) @binding(2) var bloom: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var grid: texture_2d<f32>;

const LUMINANCE_WEIGHTS: vec3f = vec3f(0.2126, 0.7152, 0.0722);
const MINIMUM_LUMINANCE: f32 = 0.000001;
const TIME_WARP_TINT_MAXIMUM: f32 = 0.25;
const TIME_WARP_COLD: vec3f = vec3f(0.62, 0.8, 1.25);

// Narkowicz 2015 fit of the ACES filmic curve, on one value.
fn acesFitted(value: f32) -> f32 {
  let numerator = value * (2.51 * value + 0.03);
  let denominator = value * (2.43 * value + 0.59) + 0.14;
  return clamp(numerator / denominator, 0.0, 1.0);
}

fn tonemapLuminance(color: vec3f) -> vec3f {
  let luminance = dot(color, LUMINANCE_WEIGHTS);
  if (luminance < MINIMUM_LUMINANCE) {
    return vec3f(0.0);
  }
  let mapped = color * (acesFitted(luminance) / luminance);
  return mapped / max(1.0, max(mapped.r, max(mapped.g, mapped.b)));
}

@fragment
fn compositeFragment(input: FullscreenOutput) -> @location(0) vec4f {
  let pixel = input.position.xy;
  let rect = composite.arenaRect;
  let inside = all(pixel >= rect.xy) && all(pixel < rect.xy + rect.zw);
  let sceneColor = textureLoad(scene, vec2i(pixel), 0).rgb + textureLoad(grid, vec2i(pixel), 0).rgb;
  let bloomColor = textureSampleLevel(bloom, linearSampler, input.uv, 0.0).rgb;
  let mapped = tonemapLuminance(max((sceneColor + bloomColor * composite.bloomStrength) * composite.exposure, vec3f(0.0)));
  let cold = min(TIME_WARP_COLD * dot(mapped, LUMINANCE_WEIGHTS), vec3f(1.0));
  let tinted = mix(mapped, cold, composite.timeWarp * TIME_WARP_TINT_MAXIMUM);
  let encoded = pow(tinted, vec3f(1.0 / 2.2));
  return vec4f(select(vec3f(0.0), encoded, inside), 1.0);
}
