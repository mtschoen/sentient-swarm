// Shader source loading and constant substitution for the WGSL pipelines.

// The template literal ending in .wgsl is the form Vite analyzes: the build globs the directory,
// emits each shader as an asset and rewrites the URL. Callers outside src/sim/shaders/ pass their
// own url built the same way.
export async function loadShader(name, {
  fetchFunction = fetch,
  url = new URL(`../sim/shaders/${name}.wgsl`, import.meta.url),
} = {}) {
  const response = await fetchFunction(url);
  if (response.ok === false) {
    throw new Error('Failed to load shader ' + name + ': ' + response.status);
  }
  return response.text();
}

export function substituteConstants(source, constants) {
  let result = source;
  for (const [name, value] of Object.entries(constants)) {
    result = result.split('__' + name + '__').join(String(value));
  }
  const leftover = result.match(/__[A-Z_]+__/);
  if (leftover) {
    throw new Error('Unresolved shader constant ' + leftover[0]);
  }
  return result;
}

export function prependCommon(source, common) {
  return common + '\n' + source;
}
