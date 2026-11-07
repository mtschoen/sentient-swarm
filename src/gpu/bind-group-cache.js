// Caches bind groups per set of buffer objects, so a caller that alternates buffers every frame
// (agentsIn and agentsOut ping-pong) builds each set's bind groups once and then reuses them.
export class BindGroupCache {
  // create(buffers) returns the bind groups for that buffer list.
  constructor(create) {
    this.create = create;
    this.identities = new WeakMap();
    this.nextIdentity = 0;
    this.entries = new Map();
    this.creationCount = 0;
  }

  identityOf(buffer) {
    if (!this.identities.has(buffer)) {
      this.identities.set(buffer, this.nextIdentity);
      this.nextIdentity += 1;
    }
    return this.identities.get(buffer);
  }

  get(buffers) {
    const key = buffers.map((buffer) => this.identityOf(buffer)).join(',');
    if (!this.entries.has(key)) {
      this.entries.set(key, this.create(buffers));
      this.creationCount += 1;
    }
    return this.entries.get(key);
  }
}
