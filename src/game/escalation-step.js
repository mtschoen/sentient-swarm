// The escalation's per-step application, taking the Game as context (like seats.js): sets the spawn
// pressure's and the spawn director's multipliers and returns the shares this step spawns by. Only a
// Playing run outside watch mode and versus escalates; everything else (Ready, Dying, Respawning, Game
// over, the lab's Watch, a versus match, which the horde must not end) gets NEUTRAL_ESCALATION, so
// every value is exactly the unescalated one.
import { NEUTRAL_ESCALATION, escalatedShares } from './escalation.js';
import { RunPhase } from './run.js';

// pressure: the spawn pressure in effect (Game.activeSpawnPressure). Stores the levels on
// game.escalationLevels (the seek multiplier is applied when the step's seek scale is set).
export function applyEscalation(game, pressure) {
  const active = game.run.phase === RunPhase.Playing && !game.watching && !game.versus;
  const levels = active ? game.escalation.levels(pressure.secondsPastRamp, pressure.ramp.ceilingFraction) : NEUTRAL_ESCALATION;
  pressure.setEscalation({ targetMultiplier: levels.targetMultiplier, refillMultiplier: levels.refillMultiplier });
  game.spawnDirector.setEscalation({ wavePeriodMultiplier: levels.wavePeriodMultiplier, burstMultiplier: levels.burstMultiplier });
  game.escalationLevels = levels;
  return escalatedShares(game.simulation.shares, levels.predatorShift);
}
