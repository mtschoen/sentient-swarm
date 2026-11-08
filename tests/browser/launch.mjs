// Launches Chromium with WebGPU enabled and collects console errors on the page.
// Flags were verified in headless Chromium on Windows by a sibling spike.
import { chromium } from 'playwright';

const WEBGPU_FLAGS = [
  '--headless=new',
  '--enable-unsafe-webgpu',
  '--use-angle=d3d11',
  '--ignore-gpu-blocklist',
  // Without this, requestDevice fails here: dxcompiler.dll cannot load (Windows Error 87).
  '--disable-dawn-features=use_dxc',
  // The smoke's mouse-down unlocks the page's audio; keep browser checks silent.
  '--mute-audio',
];
const UNCAPPED_FRAME_FLAGS = ['--disable-gpu-vsync', '--disable-frame-rate-limit'];

function isWebGpuError(text) {
  const lowered = text.toLowerCase();
  return lowered.includes('webgpu') && lowered.includes('error');
}

// contextOptions (viewport, hasTouch, isMobile, deviceScaleFactor) opens the page in its own context.
export async function launchWebGpuBrowser({ measuring = false, contextOptions = null } = {}) {
  const argumentsList = measuring ? [...WEBGPU_FLAGS, ...UNCAPPED_FRAME_FLAGS] : WEBGPU_FLAGS;
  const browser = await chromium.launch({ headless: true, args: argumentsList });
  const page = contextOptions ? await (await browser.newContext(contextOptions)).newPage() : await browser.newPage();
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
