// Applies one fixed step of player input to the player point and the simulation: moves and
// clamps the player, publishes it, and arms the debug kill at killTargetFor's point.
import { killTargetFor } from '../input/input.js';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../sim/layout.js';

export const PLAYER_SPEED = 6;
export const DEBUG_KILL_RADIUS = 0.6;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

// Moves player (in place) by state.move at PLAYER_SPEED for fixedStep seconds, inside the arena.
export function movePlayer(player, state, fixedStep) {
  player.x = clamp(player.x + state.move.x * PLAYER_SPEED * fixedStep, 0, ARENA_WIDTH);
  player.y = clamp(player.y + state.move.y * PLAYER_SPEED * fixedStep, 0, ARENA_HEIGHT);
}

// simulation needs setPlayer(x, y) and setDebugKill(x, y, radius); the kill arm lasts one step.
export function applyControlsToSimulation(simulation, state, player) {
  simulation.setPlayer(player.x, player.y);
  const target = killTargetFor(state, player);
  if (target) simulation.setDebugKill(target.x, target.y, DEBUG_KILL_RADIUS);
}
