// The end of a versus or hives match, taking the Game as context: the run's one death at the losing
// seat (the death clear there, then game over), with every seat's weapons dropped, the time warp and
// beam time ended and the multiplier reset as in co-op. versus-seats.js ends a match by elimination,
// hive-seats.js by an all-hives hold.
import { cancelBeamTime } from './beam-time-seats.js';
import { MAXIMUM_PLAYER_SEATS } from '../sim/layout.js';

// The seat whose fall the death clear marks: the loser, or seat 2 for a draw.
export function losingSeat(result) {
  return result.draw ? MAXIMUM_PLAYER_SEATS - 1 : 1 - result.winner;
}

// result: the VersusMatch result just set; point: where the death clear happens. A death the run
// refuses (a stale frame) clears the result so the match runs on; returns whether the match ended.
export function endMatch(game, result, frameSequence, point) {
  const seatIndex = losingSeat(result);
  if (!game.run.playerHit(frameSequence, point)) {
    game.versusMatch.result = null;
    return false;
  }
  game.lastWipedSeat = seatIndex;
  game.seats.forEach((seat) => seat.weapons.dropAll());
  game.timeWarp.end();
  cancelBeamTime(game);
  game.score.recordHit();
  game.effects?.death();
  return true;
}
