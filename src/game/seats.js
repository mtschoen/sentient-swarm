// Seat-list logic for the game's one or two player seats. The first half is pure helpers over the
// list: which seats are live, where the neutral swarm seeks, where pickups gather, who the spawn
// director keeps clear of, what the camera frames and where each seat starts a run. A seat is live
// while it is not down and still has ships. The second half is the game-side seat work that takes
// the Game as context (swarm upload, firing, hits, down and revive), kept here so game.js stays the
// frame order.

import { SWARM_SHIP_RADIUS } from './player-swarm.js';
import { REVIVE_SHIPS, revivePoint } from './seat-revival.js';

// Two seats start this far either side of the bounds center on x.
export const SEAT_START_OFFSET = 1.5;

export function isSeatLive(seat) {
  return !seat.down && seat.aliveCount > 0;
}

export function liveSeats(seats) {
  return seats.filter(isSeatLive);
}

// The first live seat, or the first seat when none is live (the point everything falls back to).
export function primarySeat(seats) {
  return liveSeats(seats)[0] ?? seats[0];
}

// The neutral swarm's seek points: the first live seat's point (seat 1's when none is live) and the
// second live seat's, or null for one live seat.
export function seekTargets(seats) {
  const live = liveSeats(seats);
  const primary = (live[0] ?? seats[0]).point;
  const secondary = live.length > 1 ? live[1].point : null;
  return { primary: { x: primary.x, y: primary.y }, secondary: secondary === null ? null : { x: secondary.x, y: secondary.y } };
}

// Where a pickup counts as being near the players: the midpoint of the live seats' points (seat 1's
// point when none is live).
export function pickupAnchor(seats) {
  const live = liveSeats(seats);
  if (live.length === 0) return { x: seats[0].point.x, y: seats[0].point.y };
  const x = live.reduce((sum, seat) => sum + seat.point.x, 0) / live.length;
  const y = live.reduce((sum, seat) => sum + seat.point.y, 0) / live.length;
  return { x, y };
}

// The second live seat as the spawn director's partner, or null when fewer than two are live.
export function partnerFor(seats) {
  const second = liveSeats(seats)[1];
  if (second === undefined) return null;
  return { x: second.point.x, y: second.point.y, aimX: second.player.aim.x, aimY: second.player.aim.y };
}

// Where each seat's point starts: the bounds center for one seat; for two, the center less and
// plus SEAT_START_OFFSET on x.
export function seatStarts(count, bounds) {
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  if (count === 1) return [{ x: centerX, y: centerY }];
  return [{ x: centerX - SEAT_START_OFFSET, y: centerY }, { x: centerX + SEAT_START_OFFSET, y: centerY }];
}

// What the camera frames: the live seats' camera focuses, or seat 1's when none is live.
export function framedFocuses(seats) {
  const live = liveSeats(seats);
  return live.length === 0 ? [seats[0].cameraFocus] : live.map((seat) => seat.cameraFocus);
}

// Game-side seat work: each function takes the game as context.

// A lost swarm ship ripples the warp grid this hard.
const SWARM_SHIP_LOSS_IMPULSE_STRENGTH = 0.12;

// The neutral swarm's seek points. When no seat is live the primary is the seat wiped last, so the
// death flood appears where the last swarm died.
export function gameSeekTargets(game) {
  const targets = seekTargets(game.seats);
  if (game.lastWipedSeat !== null && liveSeats(game.seats).length === 0) {
    const { x, y } = game.seats[game.lastWipedSeat].point;
    targets.primary = { x, y };
  }
  return targets;
}

// Each seat's ships for the next step's contact pass. One seat calls exactly the solo upload.
export function uploadSwarms(game) {
  const sequence = game.simulation.frameSequence + 1;
  if (game.seats.length === 1) {
    game.simulation.setSwarmShips(game.seats[0].swarm.contactShips(sequence), SWARM_SHIP_RADIUS);
    return;
  }
  for (const seat of game.seats) {
    game.simulation.setSwarmShips(seat.swarm.contactShips(sequence), SWARM_SHIP_RADIUS, { seat: seat.index, invulnerable: game.debugInvulnerableSeats.has(seat.index) || seat.invulnerableSeconds > 0 });
  }
}

// Every seat that is not down fires: its shots and turret spawns are queued, its beam set in its
// own slot (a two-seat game only), and at most one weaponFire cue plays per update, seat 1 first.
export function fireSeats(game, deltaSeconds, playing, inputs, controls) {
  const { projectiles, effects } = game;
  let cued = false;
  game.seats.forEach((seat, index) => {
    if (seat.down) return;
    // The kind and tier this frame fires at; the update itself drops to base on expiry.
    const { fire, shots, kind, tier, railTier } = seat.fire(deltaSeconds, { playing, firing: controls[index].firing });
    // The fire log (?debug=fire, main.js): why seat 1's swarm is silent while fire is held.
    if (index === 0) {
      game.fireLog?.sample(deltaSeconds, {
        phase: game.run.phase, inputFiring: controls[0].firing, armed: kind, report: seat.swarmFire.report,
        aimX: seat.swarmControls.aimX, aimY: seat.swarmControls.aimY, moveX: inputs[0].move.x, moveY: inputs[0].move.y,
      });
    }
    shots.spawns.forEach((spawn) => projectiles.queueSpawn(spawn));
    shots.turretSpawns.forEach((spawn) => projectiles.queueSpawn(spawn));
    const beam = fire.expired ? null : shots.beam;
    if (game.seats.length > 1) projectiles.setBeam(beam, seat.index);
    else projectiles.setBeam(beam);
    if (!cued && (fire.spawns.length > 0 || (fire.beam !== null && !fire.expired))) {
      effects?.weaponFire?.(kind, tier);
      cued = true;
    } else if (!cued && fire.turretSpawns.length > 0) {
      effects?.weaponFire?.('rail', railTier);
      cued = true;
    }
    if (fire.expired) effects?.expiry?.();
  });
}

// Swarm ships the GPU reported hit die (a small shockwave each). A seat that loses its last ship
// while another seat still has ships goes down; when no seat is left it is the run's one death:
// the death clear, then game over. A lost ship does not reset the multiplier.
export function applySwarmHits(game, stats) {
  const wiped = [];
  for (const seat of game.seats) {
    if (seat.down) continue;
    const result = seat.applyHits(stats);
    result.killed.forEach((ship) => game.queueImpulse(ship.x, ship.y, SWARM_SHIP_LOSS_IMPULSE_STRENGTH, false));
    if (result.wiped) wiped.push({ seat, last: result.last });
  }
  if (wiped.length === 0) return;
  const latest = wiped[wiped.length - 1];
  game.lastWipedSeat = latest.seat.index;
  if (game.seats.some((seat) => !seat.down && seat.aliveCount > 0)) {
    wiped.forEach(({ seat, last }) => seatGoesDown(game, seat, last));
  } else if (game.run.playerHit(stats.frameSequence, latest.last)) {
    game.seats.forEach((seat) => seat.weapons.dropAll());
    game.timeWarp.end();
    game.score.recordHit();
    game.effects?.death();
  }
}

// A wiped seat while the other lives: out of the run with no weapons, a shockwave at its last ship.
function seatGoesDown(game, seat, last) {
  seat.down = true;
  game.revival.down(seat.index);
  seat.weapons.dropAll();
  game.score.recordHit();
  game.effects?.seatDown?.(seat.index);
  game.queueImpulse(last.x, last.y, 1, true);
  game.projectiles.setBeam(null, seat.index);
}

// Scored kills count toward every down seat's revive; a seat that reaches the count comes back with
// REVIVE_SHIPS ships beside the first live seat, with a small shockwave. Needs a live seat to stand beside.
export function reviveSeats(game, kills) {
  const survivor = liveSeats(game.seats)[0];
  if (survivor === undefined || kills <= 0) return;
  for (const index of game.revival.addKills(kills)) {
    const seat = game.seats[index];
    const point = revivePoint(survivor.point, game.worldBounds, seat.player.radius);
    seat.revive(point, REVIVE_SHIPS);
    game.queueImpulse(point.x, point.y, REVIVE_IMPULSE_STRENGTH, false);
  }
}

const REVIVE_IMPULSE_STRENGTH = 0.5;

// Counts every seat's revive immunity down by game time (after the step's contact upload).
export function tickInvulnerability(seats, deltaSeconds) {
  for (const seat of seats) seat.tickInvulnerability(deltaSeconds);
}
