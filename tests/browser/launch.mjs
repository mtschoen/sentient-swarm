// Launches Chromium with WebGPU enabled and collects console errors on the page.
// The win32 flags were verified in headless Chromium on Windows by a sibling spike.
import { chromium } from 'playwright';

const WIN32_FLAGS = [
  '--headless=new',
  '--enable-unsafe-webgpu',
  '--use-angle=d3d11',
  '--ignore-gpu-blocklist',
  // Without this, requestDevice fails here: dxcompiler.dll cannot load (Windows Error 87).
  '--disable-dawn-features=use_dxc',
  // The smoke's mouse-down unlocks the page's audio; keep browser checks silent.
  '--mute-audio',
];
// Chrome's Linux WebGPU guidance: Vulkan through ANGLE, no Vulkan surface when headless.
const LINUX_FLAGS = [
  '--headless=new',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=vulkan',
  '--disable-vulkan-surface',
  '--ignore-gpu-blocklist',
  '--mute-audio',
];
const UNCAPPED_FRAME_FLAGS = ['--disable-gpu-vsync', '--disable-frame-rate-limit'];

export function webGpuFlagsFor({ platform = process.platform, measuring = false } = {}) {
  const base = platform === 'win32' ? WIN32_FLAGS : LINUX_FLAGS;
  return measuring ? [...base, ...UNCAPPED_FRAME_FLAGS] : [...base];
}

// WEBGPU_ADAPTER=fallback forces the software adapter (test-side only, never the default).
export function fallbackAdapterInitScript(environment = process.env) {
  if (environment.WEBGPU_ADAPTER !== 'fallback') return null;
  return `(() => {
  if (!navigator.gpu) return;
  const original = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = (options = {}) => original({ ...options, forceFallbackAdapter: true });
})();`;
}

function isWebGpuError(text) {
  const lowered = text.toLowerCase();
  return lowered.includes('webgpu') && lowered.includes('error');
}

// contextOptions (viewport, hasTouch, isMobile, deviceScaleFactor) opens the page in its own context.
export async function launchWebGpuBrowser({ measuring = false, contextOptions = null } = {}) {
  const argumentsList = webGpuFlagsFor({ platform: process.platform, measuring });
  const browser = await chromium.launch({ headless: true, args: argumentsList });
  const page = contextOptions ? await (await browser.newContext(contextOptions)).newPage() : await browser.newPage();
  const initScript = fallbackAdapterInitScript();
  if (initScript) await page.addInitScript(initScript);
  page.consoleErrors = [];
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' || isWebGpuError(text)) {
      page.consoleErrors.push(`console.${message.type()}: ${text}`);
    }
  });
  page.on('pageerror', (error) => {
    page.consoleErrors.push(`pageerror: ${error.message}`);
  });
  return { browser, page };
}
