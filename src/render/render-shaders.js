// Loads render WGSL from src/render/shaders/ and prepends a header (common.wgsl, common.wgsl plus
// quad.wgsl for the instanced quad shaders, or fullscreen.wgsl).
import { loadShader, prependCommon } from '../gpu/shaders.js';

// Template literal ending in .wgsl so the Vite build emits every render shader (see loadShader).
export async function loadRenderShader(name, header = '') {
  const source = await loadShader(name, { url: new URL(`./shaders/${name}.wgsl`, import.meta.url) });
  return header === '' ? source : prependCommon(source, header);
}

// common followed by quad.wgsl (quadCorner, worldFeather, segmentDistance), the header of every
// instanced quad shader.
export async function loadQuadHeader(common) {
  return prependCommon(await loadRenderShader('quad'), common);
}

// name.wgsl with common and quad.wgsl prepended.
export async function loadQuadShader(name, common) {
  return loadRenderShader(name, await loadQuadHeader(common));
}

export function loadFullscreenHeader() {
  return loadRenderShader('fullscreen');
}

export const SCENE_FORMAT = 'rgba16float';

export function createFullscreenPipeline(device, { label, module, fragmentEntryPoint, format, blend }) {
  return device.createRenderPipelineAsync({
    label,
    layout: 'auto',
    vertex: { module, entryPoint: 'fullscreenVertex' },
    fragment: { module, entryPoint: fragmentEntryPoint, targets: [blend ? { format, blend } : { format }] },
    primitive: { topology: 'triangle-list' },
  });
}
