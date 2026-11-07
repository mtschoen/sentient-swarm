// Loads render WGSL from src/render/shaders/ and prepends a header (common.wgsl or fullscreen.wgsl).
import { loadShader, prependCommon } from '../gpu/shaders.js';

const RENDER_SHADER_DIRECTORY = new URL('./shaders/', import.meta.url);

export async function loadRenderShader(name, header = '') {
  const source = await loadShader(name, { baseUrl: RENDER_SHADER_DIRECTORY });
  return header === '' ? source : prependCommon(source, header);
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
