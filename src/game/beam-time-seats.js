// Game-side beam shard and beam time work: where shards spawn, what collecting one does, and how
// beam time starts, runs, ends and reaches the seats. Each function takes the Game as context, so
// game.js keeps only the hooks in its frame order.

import { BEAM_TIME_TIER } from './beam-time.js';
import { placeShard } from './beam-shards.js';
import { BEAM_SHARD_TYPE } from './weaponTypes.js';
import { pickupAnchor } from './seats.js';

// The shockwave of the shard that opens beam time (a bloom boosted full strength one).
export const BEAM_TIME_IMPULSE_STRENGTH = 1;

// Asks the shard cadence for a shard after the director's update and places it when one is due.
// Only a Playing run outside the lab's watch mode yields shards.
export function spawnShardsForWaves(game) {
  if (game.watching) return;
  const requested = game.beamShards.onWaves(game.spawnDirector.waveSequence, {
    waiting: game.pickups.waitingShards,
    beamTimeActive: game.beamTime.active,
  });
  for (let index = 0; index < requested; index += 1) {
    const { x, y } = placeShard({
      bounds: game.worldBounds,
      view: game.ringView,
      anchor: pickupAnchor(game.seats),
      gates: game.spawnDirector.gates,
      shards: game.pickups.pickups.filter((pickup) => pickup.type === BEAM_SHARD_TYPE),
      densityAt: game.densityAt ?? null,
    }, game.random);
    game.pickups.spawnShard(x, y);
  }
}

// Re-bases the shard cadence where the spawn director resets (its wave counter restarts at 0), so
// a reset yields neither a burst nor a skipped interval.
export function rebaseShardCadence(game) {
  game.beamShards.rebase();
}

// A shard reached this seat. Returns true when it opened beam time (the caller queues the stronger
// shockwave). A shard collected while beam time runs is consumed with no effect: the shipped rules
// never place one then, so only a lowered shard count reaches it.
export function collectShardFor(game, seat) {
  if (game.beamTime.active) return false;
  const seatArguments = game.seats.length > 1 ? [seat.index] : [];
  const { completed } = game.beamShards.collect();
  if (completed) startBeamTime(game);
  game.effects?.pickup?.(completed ? 'beamtime' : 'beamshard', ...seatArguments);
  return completed;
}

// Beam time begins: a full window, and every seat that is not down arms the beam.
export function startBeamTime(game) {
  game.beamTime.start();
  for (const seat of game.seats) {
    if (!seat.down) seat.weapons.beginBeamTime(BEAM_TIME_TIER);
  }
}

// Counts the window in real time; the update in which it runs out ends it with the expiry cue.
export function tickBeamTime(game, deltaSeconds) {
  if (game.beamTime.update(deltaSeconds)) endBeamTime(game);
}

// The window ran out: every seat gets its loadout back, the count resets and the expiry cue plays.
export function endBeamTime(game) {
  game.beamTime.end();
  for (const seat of game.seats) seat.weapons.endBeamTime();
  game.beamShards.finish();
  game.spawnPressure.setSurge(1);
  game.effects?.expiry?.();
}

// Death, a new run or a quit: beam time and the count end with no cue (the weapons are dropped or
// reset by the caller).
export function cancelBeamTime(game) {
  game.beamTime.end();
  game.beamShards.finish();
  game.spawnPressure.setSurge(1);
}

// A seat revived while beam time runs fires the beam for the remainder.
export function joinBeamTime(game, seat) {
  seat.weapons.beginBeamTime(BEAM_TIME_TIER);
}
