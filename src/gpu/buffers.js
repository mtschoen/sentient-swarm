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
// copyFrom skips a frame when every slot is busy (counted in skippedCopies); readAll drains every
// ready slot each call, so a backlog from several steps in one frame does not persist.
export class StagingRing {
  constructor(device, bytes, depth = 3) {
    const size = alignBytes(bytes);
    this.sequence = 0;
    this.skippedCopies = 0;
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
    if (!slot) {
      this.skippedCopies += 1;
      return;
    }
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

  // Every ready slot's bytes, oldest first, stopping at the first older slot still mapping so the
  // result is always in submission order; those slots become free.
  readAll() {
    const pending = this.slots
      .filter((slot) => slot.state === 'ready' || slot.state === 'mapping')
      .sort((first, second) => first.order - second.order);
    const results = [];
    for (const slot of pending) {
      if (slot.state !== 'ready') break;
      results.push(slot.buffer.getMappedRange().slice(0));
      slot.buffer.unmap();
      slot.state = 'free';
    }
    return results;
  }

  // A slot still mapping rejects its mapAsync, which marks it free; nothing is left pending.
  destroy() {
    this.slots.forEach((slot) => slot.buffer.destroy());
  }
}
