// A deterministic value in [0, 1) for a slot and a salt (an integer hash, no shared state).
export function slotHash(slot, salt) {
  let value = Math.imul(slot + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}
