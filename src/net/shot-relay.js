// Shot replay: every projectile the local seat fires goes to the other machine as one `shots` event
// per update, stamped with the sender's match time; the receiver queues each one aged by how long
// it has been in flight (moved along its velocity, its lifetime cut), so a remote shot is where the
// sender's copy is now. The receiver's hits against its own ships are then judged where they fall.

// The spawn age seconds after it was fired, or null when its lifetime is spent. A negative age
// counts as 0.
export function ageSpawn(spawn, ageSeconds) {
  const age = Math.max(0, ageSeconds);
  const lifetime = spawn.lifetime - age;
  if (lifetime <= 0) return null;
  return { ...spawn, x: spawn.x + spawn.velocityX * age, y: spawn.y + spawn.velocityY * age, lifetime };
}

export class ShotRelay {
  // One update's spawns of owner as a shots event stamped matchSeconds, or null when there are none.
  record(owner, spawns, matchSeconds) {
    if (spawns.length === 0) return null;
    return { type: 'shots', owner, matchSeconds, spawns: [...spawns] };
  }

  // Queues each spawn of a received shots event aged to remoteMatchNow (the sender's match time
  // now), with the event's owner; returns how many were queued.
  replay(event, remoteMatchNow, projectiles) {
    let queued = 0;
    for (const spawn of event.spawns) {
      const aged = ageSpawn(spawn, remoteMatchNow - event.matchSeconds);
      if (aged === null) continue;
      projectiles.queueSpawn(aged, event.owner);
      queued += 1;
    }
    return queued;
  }
}
