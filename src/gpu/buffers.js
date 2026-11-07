// GPU buffer helpers and the readback staging ring.

const BYTE_ALIGNMENT = 16;

function alignBytes(bytes) {
  return Math.ceil(bytes / BYTE_ALIGNMENT) * BYTE_ALIGNMENT;
}

export function createStorageBuffer(device, bytes, label, { copySource = true } = {}) {
  let usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  if (copySource) usage |= GPUBufferUsage.COPY_SRC;
  return device.createBuffer({ label, size: alignBytes(bytes), usage });
}

export function createUniformBuffer(device, bytes, label) {
  return device.createBuffer({
    label,
    size: alignBytes(bytes),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

// Ring of MAP_READ buffers so readback never stalls the frame; results may arrive late.
export class StagingRing {
  constructor(device, bytes, depth = 3) {
    const size = alignBytes(bytes);
    this.sequence = 0;
    this.slots = [];
    for (let index = 0; index < depth; index += 1) {
      const buffer = device.createBuffer({
        label: 'staging-' + index,
        size,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      this.slots.push({ buffer, state: 'free', order: 0 });
    }
  }

  copyFrom(encoder, sourceBuffer) {
    const slot = this.slots.find((candidate) => candidate.state === 'free');
    if (!slot) return;
    encoder.copyBufferToBuffer(sourceBuffer, 0, slot.buffer, 0, slot.buffer.size);
    slot.state = 'copied';
  }

  markSubmitted() {
    for (const slot of this.slots) {
      if (slot.state !== 'copied') continue;
      slot.state = 'mapping';
      this.sequence += 1;
      slot.order = this.sequence;
      slot.buffer.mapAsync(GPUMapMode.READ).then(
        () => { slot.state = 'ready'; },
        () => { slot.state = 'free'; },
      );
    }
  }

  tryRead() {
    let oldest = null;
    for (const slot of this.slots) {
      if (slot.state === 'ready' && (oldest === null || slot.order < oldest.order)) oldest = slot;
    }
    if (oldest === null) return null;
    const data = oldest.buffer.getMappedRange().slice(0);
    oldest.buffer.unmap();
    oldest.state = 'free';
    return data;
  }

  // A slot still mapping rejects its mapAsync, which marks it free; nothing is left pending.
  destroy() {
    this.slots.forEach((slot) => slot.buffer.destroy());
  }
}
