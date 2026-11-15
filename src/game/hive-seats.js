// Hives (stage 3) game-side work, taking the Game as context like versus-seats.js: capture from the
// seats' ships each Playing update, the hold win, the gate table rows the simulation and the gate
// renderer get, the feeding ground growth and the HUD view. The pure state is hives.js; the mode
// switch that creates it is versus-seats.js. Outside hives every function returns what plain versus
// (or co-op) would have, so no other mode gains a call or a field.
import { RunPhase } from './run.js';
import { feedingGrowth, hiveTarget } from './hives.js';
import { endMatch } from './match-end.js';

// A captured hive ripples the warp grid this hard.
const HIVE_CAPTURE_IMPULSE_STRENGTH = 0.4;

// The match's Hives in hives mode, else null.
export function hivesOf(game) {
  return game.versusMatch?.hives ?? null;
}

// Capture from the live ships in each hive's disc, then the hold: a seat that has held every hive
// for the hold time wins (the run's one death at the loser's swarm, as an elimination ends it).
// Playing only, never once the match is over.
export function updateHives(game, deltaSeconds) {
  const hives = hivesOf(game);
  if (hives === null || game.run.phase !== RunPhase.Playing || game.versusMatch.over) return;
  const { captured, winner } = hives.update(game.seats.map((seat) => seat.swarm.slots), deltaSeconds);
  captured.forEach(({ hive }) => game.queueImpulse(hives.hives[hive].x, hives.hives[hive].y, HIVE_CAPTURE_IMPULSE_STRENGTH, false));
  if (winner === null) return;
  const result = game.versusMatch.awardHold(winner);
  if (result === null) return;
  const loser = game.seats[1 - winner];
  const point = loser.aliveCount > 0 ? loser.centroid : loser.point;
  endMatch(game, result, game.simulation.frameSequence, { x: point.x, y: point.y });
}

// The step's gate table: in hives every row (one per hive, SpawnDirector fixed sites) also carries
// its hive's owner, the seat its spawns seek (hiveTarget) and its capture state for the renderer;
// anything else is the table as it came.
export function hiveGateTable(game, table) {
  const hives = hivesOf(game);
  if (hives === null || table === null) return table;
  const gates = table.gates.map((row) => {
    const hive = hives.hives[row.site];
    if (hive === undefined) return row;
    return { ...row, owner: hive.owner, target: hiveTarget(hive.owner), hive: { owner: hive.owner, capturer: hive.capturer, progress: hive.progress } };
  });
  return { ...table, gates };
}

// Seat index's growth from a stats frame's owned kills: in hives its feeding ground kills count
// double (feedingGrowth); elsewhere the owned kills alone.
export function hiveGrowth(game, stats, index, ownerKills) {
  if (hivesOf(game) === null) return ownerKills;
  return feedingGrowth(ownerKills, stats.feedingKillsSinceLastRead?.[index] ?? 0);
}

// The HUD's hive readout ({ hives, holder, holdRemainingSeconds, holdSecondsToWin }), or null outside hives.
export function hiveView(game) {
  return hivesOf(game)?.view ?? null;
}
