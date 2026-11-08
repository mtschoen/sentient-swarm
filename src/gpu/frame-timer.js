// Frame time for the quality probe. Game brackets every simulation step and the render with
// beginSection(encoder) and endSection(encoder), then calls endFrame(encoder) on the render
// encoder before finishing it and afterFrameSubmit() after submitting it; onFrame(milliseconds)
// fires later, once the frame's GPU work is done.
//   CpuFrameTimer: performance.now deltas from the frame's first section to
//     queue.onSubmittedWorkDone, so CPU encoding and GPU execution both count.
//   TimestampFrameTimer (timestamp-query): the GPU time inside every section, summed per frame,
//     from timestamps written by empty compute passes at each section's edges.
// createFrameTimer picks the timestamp one when the device has the feature, unless ?timer=cpu.
const MAXIMUM_SECTIONS = 8;
const QUERY_COUNT = MAXIMUM_SECTIONS * 2;
const TIMESTAMP_BYTES = 8;
const READBACK_SLOTS = 3;
const NANOSECONDS_PER_MILLISECOND = 1e6;

export class CpuFrameTimer {
  // now: milliseconds (injected; performance.now in the page).
  constructor({ queue, now, onFrame }) {
    this.queue = queue;
    this.now = now;
    this.onFrame = onFrame;
    this.frameStart = null;
  }

  beginSection() {
    if (this.frameStart === null) this.frameStart = this.now();
  }

  endSection() {}

  endFrame() {}

  afterFrameSubmit() {
    const start = this.frameStart ?? this.now();
    this.frameStart = null;
    this.queue.onSubmittedWorkDone().then(() => this.onFrame(this.now() - start), () => {});
  }

  destroy() {}
}

// Sums (end - begin) over the resolved section pairs; a pair whose end does not follow its begin
// (a timestamp reset or a quantized zero) adds nothing.
export function sumSectionNanoseconds(timestamps, sectionCount) {
  let total = 0n;
  for (let section = 0; section < sectionCount; section += 1) {
    const begin = timestamps[section * 2];
    const end = timestamps[section * 2 + 1];
    if (end > begin) total += end - begin;
  }
  return Number(total);
}

export class TimestampFrameTimer {
  constructor({ device, onFrame }) {
    this.device = device;
    this.onFrame = onFrame;
    this.querySet = device.createQuerySet({ label: 'frame-timer', type: 'timestamp', count: QUERY_COUNT });
    this.resolveBuffer = device.createBuffer({
      label: 'frame-timer-resolve',
      size: QUERY_COUNT * TIMESTAMP_BYTES,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.readbacks = Array.from({ length: READBACK_SLOTS }, (unused, index) => ({
      buffer: device.createBuffer({ label: 'frame-timer-readback-' + index, size: QUERY_COUNT * TIMESTAMP_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      free: true,
      sectionCount: 0,
    }));
    this.sectionCount = 0;
    this.pendingReadback = null;
  }

  // An empty compute pass writes one timestamp; sections past MAXIMUM_SECTIONS are not timed.
  writeTimestamp(encoder, writes) {
    const pass = encoder.beginComputePass({ label: 'frame-timer', timestampWrites: { querySet: this.querySet, ...writes } });
    pass.end();
  }

  beginSection(encoder) {
    if (this.sectionCount >= MAXIMUM_SECTIONS) return;
    this.writeTimestamp(encoder, { beginningOfPassWriteIndex: this.sectionCount * 2 });
  }

  endSection(encoder) {
    if (this.sectionCount >= MAXIMUM_SECTIONS) return;
    this.writeTimestamp(encoder, { endOfPassWriteIndex: this.sectionCount * 2 + 1 });
    this.sectionCount += 1;
  }

  // Resolves this frame's timestamps into a free readback slot; a frame with none free is dropped.
  endFrame(encoder) {
    const sectionCount = this.sectionCount;
    this.sectionCount = 0;
    const readback = this.readbacks.find((slot) => slot.free);
    if (!readback || sectionCount === 0) return;
    const bytes = sectionCount * 2 * TIMESTAMP_BYTES;
    encoder.resolveQuerySet(this.querySet, 0, sectionCount * 2, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, readback.buffer, 0, bytes);
    readback.free = false;
    readback.sectionCount = sectionCount;
    this.pendingReadback = readback;
  }

  afterFrameSubmit() {
    const readback = this.pendingReadback;
    this.pendingReadback = null;
    if (readback === null) return;
    const bytes = readback.sectionCount * 2 * TIMESTAMP_BYTES;
    readback.buffer.mapAsync(GPUMapMode.READ, 0, bytes).then(() => {
      const timestamps = new BigUint64Array(readback.buffer.getMappedRange(0, bytes));
      const nanoseconds = sumSectionNanoseconds(timestamps, readback.sectionCount);
      readback.buffer.unmap();
      readback.free = true;
      this.onFrame(nanoseconds / NANOSECONDS_PER_MILLISECOND);
    }, () => { readback.free = true; });
  }

  destroy() {
    this.querySet.destroy();
    this.resolveBuffer.destroy();
    this.readbacks.forEach((slot) => slot.buffer.destroy());
  }
}

// ?timer=cpu forces the CPU timer on a device with timestamp-query (quality.mjs measures it).
export function frameTimerKindFromSearch(search) {
  return new URLSearchParams(search).get('timer') === 'cpu' ? 'cpu' : 'auto';
}

// kind: 'auto' (timestamps when the device has the feature) or 'cpu'.
export function createFrameTimer(gpu, { now, onFrame, kind = 'auto' }) {
  if (gpu.hasTimestampQuery && kind !== 'cpu') return new TimestampFrameTimer({ device: gpu.device, onFrame });
  return new CpuFrameTimer({ queue: gpu.device.queue, now, onFrame });
}
