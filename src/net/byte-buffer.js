// Little-endian byte writer and reader for the online wire formats, plus the clamped quantizers.

const INITIAL_CAPACITY = 256;

export class ByteWriter {
  #bytes = new Uint8Array(INITIAL_CAPACITY);
  #view = new DataView(this.#bytes.buffer);
  #length = 0;

  #reserve(count) {
    const needed = this.#length + count;
    if (needed <= this.#bytes.length) return;
    let capacity = this.#bytes.length;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.#bytes.subarray(0, this.#length));
    this.#bytes = grown;
    this.#view = new DataView(grown.buffer);
  }

  u8(value) {
    this.#reserve(1);
    this.#view.setUint8(this.#length, value);
    this.#length += 1;
  }

  u16(value) {
    this.#reserve(2);
    this.#view.setUint16(this.#length, value, true);
    this.#length += 2;
  }

  u32(value) {
    this.#reserve(4);
    this.#view.setUint32(this.#length, value, true);
    this.#length += 4;
  }

  f32(value) {
    this.#reserve(4);
    this.#view.setFloat32(this.#length, value, true);
    this.#length += 4;
  }

  f64(value) {
    this.#reserve(8);
    this.#view.setFloat64(this.#length, value, true);
    this.#length += 8;
  }

  bytes() {
    return this.#bytes.slice(0, this.#length);
  }
}

export class ByteReader {
  #view;
  #offset = 0;

  constructor(bytes) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining() {
    return this.#view.byteLength - this.#offset;
  }

  #take(count) {
    if (count > this.remaining) throw new RangeError(`read of ${count} bytes past the end (${this.remaining} remaining)`);
    const offset = this.#offset;
    this.#offset += count;
    return offset;
  }

  u8() {
    return this.#view.getUint8(this.#take(1));
  }

  u16() {
    return this.#view.getUint16(this.#take(2), true);
  }

  u32() {
    return this.#view.getUint32(this.#take(4), true);
  }

  f32() {
    return this.#view.getFloat32(this.#take(4), true);
  }

  f64() {
    return this.#view.getFloat64(this.#take(8), true);
  }
}

// Maps value in [minimum, maximum] to an integer code in [0, 2^bits - 1]; outside values clamp.
export function quantize(value, minimum, maximum, bits) {
  const levels = 2 ** bits - 1;
  const fraction = (value - minimum) / (maximum - minimum);
  return Math.round(Math.min(1, Math.max(0, fraction)) * levels);
}

export function dequantize(code, minimum, maximum, bits) {
  return minimum + (code / (2 ** bits - 1)) * (maximum - minimum);
}
