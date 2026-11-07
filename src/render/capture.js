// Swapchain capture for the smoke test: copies one composited frame into a MAP_READ buffer and
// resolves with tightly packed RGBA pixels without stalling the frame loop.
const BYTES_PER_PIXEL = 4;
const ROW_ALIGNMENT = 256;

export function paddedBytesPerRow(width) {
  return Math.ceil((width * BYTES_PER_PIXEL) / ROW_ALIGNMENT) * ROW_ALIGNMENT;
}

// Drops row padding and swaps blue and red for bgra8unorm, so the result is always RGBA.
export function unpackRows(bytes, { width, height, bytesPerRow, format }) {
  const pixels = new Uint8Array(width * height * BYTES_PER_PIXEL);
  const swapRedBlue = format.startsWith('bgra');
  for (let row = 0; row < height; row += 1) {
    const sourceRow = row * bytesPerRow;
    const targetRow = row * width * BYTES_PER_PIXEL;
    for (let column = 0; column < width; column += 1) {
      const source = sourceRow + column * BYTES_PER_PIXEL;
      const target = targetRow + column * BYTES_PER_PIXEL;
      pixels[target] = bytes[source + (swapRedBlue ? 2 : 0)];
      pixels[target + 1] = bytes[source + 1];
      pixels[target + 2] = bytes[source + (swapRedBlue ? 0 : 2)];
      pixels[target + 3] = bytes[source + 3];
    }
  }
  return pixels;
}

// Mean of (0.2126 R + 0.7152 G + 0.0722 B) / 255 over rect, for RGBA pixels of the given width.
export function meanLuminance(pixels, width, rect) {
  let total = 0;
  for (let row = rect.y; row < rect.y + rect.height; row += 1) {
    for (let column = rect.x; column < rect.x + rect.width; column += 1) {
      const index = (row * width + column) * BYTES_PER_PIXEL;
      total += 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
    }
  }
  const count = rect.width * rect.height;
  return count === 0 ? 0 : total / 255 / count;
}

export class FrameCapture {
  constructor(device, format) {
    this.device = device;
    this.format = format;
    this.waiting = [];
    this.copied = null;
  }

  // Resolves with { width, height, format: 'rgba8unorm', sourceFormat, pixels, details } from the
  // next frame that encodes a copy; sourceFormat is the swapchain format (bgra8unorm or
  // rgba8unorm) and details is what that frame passed to encode (for example its arena rect).
  request() {
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  // Encodes the copy only when a request is waiting and no earlier copy is still in flight.
  // details is a snapshot taken with the copy, so a resize while the map is pending cannot pair
  // these pixels with a newer frame's layout.
  encode(encoder, texture, details = {}) {
    if (this.waiting.length === 0 || this.copied !== null) return;
    const { width, height } = texture;
    const bytesPerRow = paddedBytesPerRow(width);
    const buffer = this.device.createBuffer({
      label: 'frame-capture',
      size: bytesPerRow * height,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
    this.copied = { buffer, width, height, bytesPerRow, details, requests: this.waiting };
    this.waiting = [];
  }

  // Call after the command buffer holding encode() is submitted; mapping resolves later.
  afterSubmit() {
    if (this.copied === null) return;
    const { buffer, width, height, bytesPerRow, details, requests } = this.copied;
    this.copied = null;
    buffer.mapAsync(GPUMapMode.READ).then(() => {
      const bytes = new Uint8Array(buffer.getMappedRange());
      const pixels = unpackRows(bytes, { width, height, bytesPerRow, format: this.format });
      buffer.destroy();
      requests.forEach(({ resolve }) => resolve({ width, height, format: 'rgba8unorm', sourceFormat: this.format, pixels, details }));
    }, (error) => {
      buffer.destroy();
      requests.forEach(({ reject }) => reject(error));
    });
  }

  // Rejects every request not yet mapped and destroys a copy encoded but not yet submitted. A copy
  // already mapping settles on its own (destroying its buffer elsewhere rejects the map).
  destroy() {
    const error = new Error('FrameCapture was destroyed before the frame was read back');
    const pending = [...this.waiting, ...(this.copied?.requests ?? [])];
    this.copied?.buffer.destroy();
    this.copied = null;
    this.waiting = [];
    pending.forEach(({ reject }) => reject(error));
  }
}
