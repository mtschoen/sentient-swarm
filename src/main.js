import { createGpuContext, describeUnsupported, WebGpuUnavailableError } from './gpu/device.js';

window.__murmuration = { ready: false, frame: 0, stats: null };

async function boot() {
  const canvas = document.getElementById('arena');
  try {
    await createGpuContext(canvas);
  } catch (error) {
    if (error instanceof WebGpuUnavailableError) {
      const message = document.getElementById('message');
      message.textContent = describeUnsupported(error);
      message.hidden = false;
      return;
    }
    throw error;
  }
  const tick = () => {
    window.__murmuration.frame += 1;
    window.__murmuration.ready = true;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

boot();
