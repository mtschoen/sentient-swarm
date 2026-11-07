// Launches Chromium with WebGPU enabled and collects console errors on the page.
// Flags were verified in headless Chromium on Windows by a sibling spike.
import { chromium } from 'playwright';

const WEBGPU_FLAGS = [
  '--headless=new',
  '--enable-unsafe-webgpu',
  '--use-angle=d3d11',
  '--ignore-gpu-blocklist',
];
const UNCAPPED_FRAME_FLAGS = ['--disable-gpu-vsync', '--disable-frame-rate-limit'];

function isWebGpuError(text) {
  const lowered = text.toLowerCase();
  return lowered.includes('webgpu') && lowered.includes('error');
}

export async function launchWebGpuBrowser({ measuring = false } = {}) {
  const args = measuring ? [...WEBGPU_FLAGS, ...UNCAPPED_FRAME_FLAGS] : WEBGPU_FLAGS;
  const browser = await chromium.launch({ headless: true, args });
  const page = await browser.newPage();
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
