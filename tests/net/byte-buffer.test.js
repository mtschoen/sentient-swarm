import assert from 'node:assert/strict';
import test from 'node:test';
import { ByteReader, ByteWriter, dequantize, quantize } from '../../src/net/byte-buffer.js';

test('every width round trips and the writer grows past its first allocation', () => {
  const writer = new ByteWriter();
  for (let index = 0; index < 400; index += 1) writer.u8(index % 256);
  writer.u16(65535);
  writer.u32(4000000000);
  writer.f32(1.5);
  writer.f64(Math.PI);
  const reader = new ByteReader(writer.bytes());
  for (let index = 0; index < 400; index += 1) assert.equal(reader.u8(), index % 256);
  assert.equal(reader.u16(), 65535);
  assert.equal(reader.u32(), 4000000000);
  assert.equal(reader.f32(), 1.5);
  assert.equal(reader.f64(), Math.PI);
  assert.equal(reader.remaining, 0);
});

test('values are little-endian', () => {
  const writer = new ByteWriter();
  writer.u16(0x0102);
  assert.deepEqual([...writer.bytes()], [2, 1]);
});

test('a read past the end throws RangeError and a subarray view reads from its own start', () => {
  const reader = new ByteReader(Uint8Array.of(1, 2, 3));
  assert.throws(() => reader.u32(), RangeError);
  const view = new ByteReader(Uint8Array.of(9, 9, 7, 0).subarray(2));
  assert.equal(view.u16(), 7);
});

test('quantize and dequantize round trip within half a step', () => {
  const code = quantize(10.3, 0, 32, 16);
  assert.ok(Math.abs(dequantize(code, 0, 32, 16) - 10.3) <= 32 / 65535 / 2 + 1e-9);
  assert.equal(quantize(-3, -3, 3, 8), 0);
  assert.equal(dequantize(255, -3, 3, 8), 3);
});
