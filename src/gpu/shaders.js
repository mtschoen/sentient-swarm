// Shader source loading and constant substitution for the WGSL pipelines.

const SIMULATION_SHADER_DIRECTORY = new URL('../sim/shaders/', import.meta.url);

// The Vite dev server rewrites a literal new URL('./dir/', import.meta.url) without its trailing
// slash, which would resolve the name against the parent directory; restore the slash.
export function shaderUrl(name, baseUrl) {
  const directory = String(baseUrl).endsWith('/') ? String(baseUrl) : String(baseUrl) + '/';
  return new URL(name + '.wgsl', directory);
}

// baseUrl is the directory URL holding the shader; render modules pass their own shaders directory.
export async function loadShader(name, { fetchFunction = fetch, baseUrl = SIMULATION_SHADER_DIRECTORY } = {}) {
  const url = shaderUrl(name, baseUrl);
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
