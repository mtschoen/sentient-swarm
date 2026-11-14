// Trail decay: the previous scene times trailDecay becomes the start of the current scene.
// Prepended with fullscreen.wgsl. Both scene targets share the canvas size, so texels map 1:1, and
// each pixel reads the previous scene shift texels away (the camera's movement since the last
// frame, whole device pixels, TrailDecayPass.draw); a source outside the target reads as empty.
struct DecayUniform {
  decay: f32,
  shiftX: f32,
  shiftY: f32,
  padding: f32,
}

@group(0) @binding(0) var<uniform> decayUniform: DecayUniform;
@group(0) @binding(1) var previousScene: texture_2d<f32>;

@fragment
fn decayFragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let source = vec2i(position.xy) + vec2i(i32(decayUniform.shiftX), i32(decayUniform.shiftY));
  let size = vec2i(textureDimensions(previousScene));
  if (any(source < vec2i(0)) || any(source >= size)) {
    return vec4f(0.0);
  }
  return textureLoad(previousScene, source, 0) * decayUniform.decay;
}
