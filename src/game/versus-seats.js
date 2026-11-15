// Versus (stage 2) game-side work, taking the Game as context like seats.js: the mode switch, the
// swarm growth from kills (co-op's rule too), the per-seat kill credit, the hits (no down and revive), ship to ship contact and the match end. The
// pure match state is versus.js; ship contact pairing is ship-contact.js.
//
// The mode switch (setGameMode) acts only on a change, so a solo or co-op game that never enters
// versus makes no call the co-op game did not make. Entering versus hands the simulation the
// projectile buffer (the versus hit pass, versus_hits.wgsl) and takes the time warp out of the pickup
// rotation; leaving undoes both. Beam shards are not placed in versus (game.js spawnCounts) and the
// escalation stays neutral (escalation-step.js).
// Hives (stage 3) is versus with a Hives state on the match (hive-seats.js): entering it also turns
// the spawn director's gates into the three fixed hive sites, leaving it back into roaming gates;
// switching between versus and hives keeps the versus projectiles and rotation as they are.
import { GameMode, VERSUS_PICKUP_ROTATION, VersusMatch, validatedMode } from './versus.js';
import { Hives, hiveSites } from './hives.js';
import { hiveGrowth, hivesOf, updateHives } from './hive-seats.js';
import { endMatch, losingSeat } from './match-end.js';
import { contactPairs } from './ship-contact.js';
import { PICKUP_TYPE_NAMES } from './weaponTypes.js';
import { SWARM_SHIP_RADIUS } from './player-swarm.js';
import { RunPhase } from './run.js';
import { SEAT_START_OFFSET, reviveSeats, seatStarts } from './seats.js';
import { MAXIMUM_PLAYER_SEATS } from '../sim/layout.js';

// Opposing ships this close (their two contact radii) touch.
export const SHIP_CONTACT_DISTANCE = 2 * SWARM_SHIP_RADIUS;
// Versus seats start this far either side of the world's center on x (20 apart in the 32-unit world),
// so neither swarm is in the other's fire when the match begins; co-op keeps SEAT_START_OFFSET.
export const VERSUS_START_OFFSET = 10;
// A lost swarm ship ripples the warp grid this hard (as in seats.js).
const SHIP_LOSS_IMPULSE_STRENGTH = 0.12;

// Co-op, versus or hives, in Ready only; versus and hives need two seats. Throws RangeError for an
// unknown mode or versus or hives with one seat, Error outside Ready.
export function setGameMode(game, mode) {
  validatedMode(mode);
  if (game.run.phase !== RunPhase.Ready) throw new Error('the game mode changes only in Ready');
  if (mode !== GameMode.Coop && game.seats.length !== MAXIMUM_PLAYER_SEATS) throw new RangeError(`${mode} needs two seats`);
  applyMode(game, mode);
}

// The game's mode: co-op without a match, hives when the match has hives, else versus.
export function gameModeOf(game) {
  if (game.versusMatch === null) return GameMode.Coop;
  return game.versusMatch.hives === null ? GameMode.Versus : GameMode.Hives;
}

// Back to co-op from any phase (quit to title, the lab, one seat); nothing happens outside versus.
export function leaveVersus(game) {
  applyMode(game, GameMode.Coop);
}

function applyMode(game, mode) {
  if (mode === game.mode) return;
  const versus = mode !== GameMode.Coop;
  const versusChanges = versus !== game.versus;
  const hadHives = hivesOf(game) !== null;
  const hives = mode === GameMode.Hives ? new Hives(hiveSites(game.worldBounds, VERSUS_START_OFFSET)) : null;
  game.versusMatch = versus ? new VersusMatch({ hives }) : null;
  if (versusChanges) {
    game.simulation.setVersusProjectiles(versus ? game.projectiles.buffer : null);
    game.pickups.setRotation(versus ? VERSUS_PICKUP_ROTATION : PICKUP_TYPE_NAMES);
  }
  if (hadHives || hives !== null) game.spawnDirector.setFixedSites(hives === null ? null : hives.hives.map(({ x, y, radius }) => ({ x, y, radius })));
}

// The versus work of a Playing update after the flock step: ship contact, then (hives) capture.
export function stepVersus(game, deltaSeconds) {
  applyShipContact(game);
  updateHives(game, deltaSeconds);
}

// Each seat's start point for the game's mode and seat count.
export function startsFor(game) {
  return seatStarts(game.seats.length, game.worldBounds, game.versus ? VERSUS_START_OFFSET : SEAT_START_OFFSET);
}

// A scored stats frame's kills: in co-op they grow every seat that is not down and count toward
// each down seat's revive; in versus they grow only the seat whose projectiles made them (in hives,
// with its feeding ground kills counted double, hiveGrowth). Online each machine grows its own seat
// (game.online).
export function growSwarms(game, stats) {
  if (game.online) return game.online.growSwarms(game, stats);
  if (!game.versus) {
    for (const seat of game.seats) if (!seat.down) seat.swarm.addKills(stats.killsSinceLastRead);
    reviveSeats(game, stats.killsSinceLastRead);
    return;
  }
  const credit = stats.ownerKillsSinceLastRead ?? [];
  game.seats.forEach((seat, index) => {
    const kills = hiveGrowth(game, stats, index, credit[index] ?? 0);
    if (kills > 0) seat.swarm.addKills(kills);
  });
}

// The GPU's hits (agents and opposing projectiles alike) kill the hit ships; a seat at 0 ships is
// out and the match is judged. Online each machine applies its own seat's mask (game.online).
export function applyVersusHits(game, stats) {
  if (game.online) return game.online.applyHits(game, stats);
  const losses = game.seats.map((seat) => {
    const result = seat.applyHits(stats);
    result.killed.forEach((ship) => game.queueImpulse(ship.x, ship.y, SHIP_LOSS_IMPULSE_STRENGTH, false));
    return result.last;
  });
  judgeMatch(game, stats.frameSequence, losses);
}

// Touching opposing ships both die (Playing only, never while either seat is invulnerable).
export function applyShipContact(game) {
  if (game.run.phase !== RunPhase.Playing || game.run.invulnerable || game.debugInvulnerableValue) return;
  if (game.seats.some((seat) => game.debugInvulnerableSeats.has(seat.index))) return;
  const [first, second] = game.seats;
  const pairs = contactPairs(first.swarm.ships, second.swarm.ships, SHIP_CONTACT_DISTANCE);
  if (pairs.length === 0) return;
  const losses = [null, null];
  for (const pair of pairs) {
    const killed = [first.swarm.killShip(pair.first), second.swarm.killShip(pair.second)];
    killed.forEach((ship, index) => {
      game.queueImpulse(ship.x, ship.y, SHIP_LOSS_IMPULSE_STRENGTH, false);
      losses[index] = ship;
    });
  }
  judgeMatch(game, game.simulation.frameSequence, losses);
}

// lastLosses: each seat's last ship lost just now, or null. A seat left with no ships ends the
// match (endMatch: the run's one death, the death clear at the last wiped seat, seat 2's when both
// fell, then game over). A death the run refuses (a stale frame) leaves the match running.
function judgeMatch(game, frameSequence, lastLosses) {
  const result = game.versusMatch.judge(game.seats.map((seat) => seat.aliveCount));
  if (result === null) return;
  const seatIndex = losingSeat(result);
  endMatch(game, result, frameSequence, lastLosses[seatIndex] ?? game.seats[seatIndex].point);
}
