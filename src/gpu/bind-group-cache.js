// Caches bind groups per set of buffer objects, so a caller that alternates buffers every frame
// (agentsIn and agentsOut ping-pong) builds each set's bind groups once and then reuses them.
export class BindGroupCache {
  // create(buffers) returns the bind groups for that buffer list.
  constructor(create) {
    this.create = create;
    this.identities = new WeakMap();
    this.nextIdentity = 0;
    this.entries = new Map();
    this.entryIdentities = new Map();
    this.creationCount = 0;
  }

  identityOf(buffer) {
    if (!this.identities.has(buffer)) {
      this.identities.set(buffer, this.nextIdentity);
      this.nextIdentity += 1;
    }
    return this.identities.get(buffer);
  }

  // Forgets every cached bind group, for an owner whose buffers were replaced (a new Simulation);
  // the old bind groups then become garbage instead of being held for the page's lifetime.
  clear() {
    this.entries.clear();
    this.entryIdentities.clear();
    this.identities = new WeakMap();
    this.nextIdentity = 0;
  }

  // Drops every entry that names the buffer, for an owner that destroyed and replaced it (a
  // resized particle pool) while its other buffers live on.
  evict(buffer) {
    if (!this.identities.has(buffer)) return;
    const identity = this.identities.get(buffer);
    this.entryIdentities.forEach((members, key) => {
      if (!members.includes(identity)) return;
      this.entries.delete(key);
      this.entryIdentities.delete(key);
    });
  }

  get(buffers) {
    const members = buffers.map((buffer) => this.identityOf(buffer));
    const key = members.join(',');
    if (!this.entries.has(key)) {
      this.entryIdentities.set(key, members);
      this.entries.set(key, this.create(buffers));
      this.creationCount += 1;
    }
    return this.entries.get(key);
  }
}
