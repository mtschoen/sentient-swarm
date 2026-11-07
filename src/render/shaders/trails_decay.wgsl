// Trail decay: the previous scene times trailDecay becomes the start of the current scene.
// Prepended with fullscreen.wgsl. Both scene targets share the canvas size, so texels map 1:1.
struct DecayUniform {
  decay: f32,
  padding0: f32,
  padding1: f32,
  padding2: f32,
}

@group(0) @binding(0) var<uniform> decayUniform: DecayUniform;
@group(0) @binding(1) var previousScene: texture_2d<f32>;

@fragment
fn decayFragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return textureLoad(previousScene, vec2i(position.xy), 0) * decayUniform.decay;
}
