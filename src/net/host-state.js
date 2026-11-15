// The host's shared match state (HostState, in every HOST_STATE_UPDATE_INTERVAL-th host snapshot):
// each hive's owner, capturer and progress, the all-hives hold, and the one score, multiplier and
// bomb pool. The guest applies a state only when its sequence is above the last one applied, so a
// state lost or reordered on the unordered state channel never steps the guest's hives back.

import { hivesOf } from '../game/hive-seats.js';

export function buildHostState(game, sequence) {
  const hives = hivesOf(game);
  return {
    sequence,
    hives: hives === null ? null : hives.hives.map(({ owner, capturer, progress }) => ({ owner, capturer, progress })),
    holder: hives === null ? null : hives.hold.holder,
    holdSeconds: hives === null ? 0 : hives.hold.seconds,
    score: game.score.score,
    multiplier: game.score.multiplier,
    bombs: game.run.bombs,
  };
}

// Writes the state's hives and hold into the game's (hives mode only); returns the sequence now
// applied: the state's, or lastSequence when the state is not newer.
export function applyHostState(game, state, lastSequence) {
  if (state.sequence <= lastSequence) return lastSequence;
  const hives = hivesOf(game);
  if (hives !== null && state.hives !== null) {
    state.hives.forEach((source, index) => {
      const hive = hives.hives[index];
      if (hive === undefined) return;
      hive.owner = source.owner;
      hive.capturer = source.capturer;
      hive.progress = source.progress;
    });
    hives.hold.holder = state.holder;
    hives.hold.seconds = state.holdSeconds;
  }
  return state.sequence;
}
