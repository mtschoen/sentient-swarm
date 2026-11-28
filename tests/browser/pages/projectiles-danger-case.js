// (r) Danger splat for projectiles-check.js: after a live bullet has moved, the blurred coarse field
// holds danger (channel 6) ahead of it and none behind it, and the splat's total is the sum of the
// look-ahead weights; every kind but the beam and the rings does it; a pulse ring, the beam and a
// projectile that has expired add none, and nothing lingers after the projectiles are gone.
// The splat made in one step is folded and blurred by the next, so the field is read after two steps.
import { COARSE_CHANNELS, COARSE_COLUMNS, COARSE_ROWS } from '/src/sim/layout.js';
import { PROJECTILE_KINDS } from '/src/game/weaponTypes.js';

const DANGER_CHANNEL = 6;
const CELL_SIZE = 0.25;
const SPEED = 8;
const START = [5, 4.5];
const STEP_SECONDS = 1 / 60;
// ceil(SPEED * 0.5 / CELL_SIZE) samples, weights falling linearly from 1 to 0.25, each splatted across
// 7 cells weighted 1, 0.75, 0.5, 0.25 outward (sum 4).
const SAMPLE_COUNT = 16;
const SIDE_CELLS = 3;
const SIDE_WEIGHT_SUM = 1 + 2 * (0.75 + 0.5 + 0.25);
const EXPECTED_TOTAL = ((SAMPLE_COUNT * (1 + 0.25)) / 2) * SIDE_WEIGHT_SUM;
const TOTAL_TOLERANCE = 0.3;

function spawnOf(kind, overrides = {}) {
  return { x: START[0], y: START[1], velocityX: SPEED, velocityY: 0, radius: 0.05, lifetime: 2, kind, extra: 0, ...overrides };
}

// Danger per cell, from the blurred field after the harness steps `steps` times.
async function dangerAfter(harness, steps) {
  await harness.steps(steps);
  const field = await harness.simulation.readCoarseField();
  const cells = COARSE_COLUMNS * COARSE_ROWS;
  return Array.from({ length: cells }, (unused, cell) => field[cell * COARSE_CHANNELS + DANGER_CHANNEL]);
}

const total = (danger) => danger.reduce((sum, value) => sum + value, 0);
const columnOf = (cell) => cell % COARSE_COLUMNS;

export async function runDangerCase(harness) {
  const verdicts = [];
  const check = (ok, text) => verdicts.push([ok, `(r) ${text}`]);

  harness.seedPositions([]);
  harness.projectiles.queueSpawn(spawnOf(PROJECTILE_KINDS.bullet));
  const danger = await dangerAfter(harness, 2);
  const headColumn = Math.floor((START[0] + SPEED * STEP_SECONDS) / CELL_SIZE);
  const occupied = danger.map((value, cell) => [value, cell]).filter(([value]) => value > 1e-6).map(([, cell]) => columnOf(cell));
  const row = Math.floor(START[1] / CELL_SIZE);
  check(Math.abs(total(danger) - EXPECTED_TOTAL) <= TOTAL_TOLERANCE, `a bullet's splat totals ${total(danger).toFixed(3)} (need ${EXPECTED_TOTAL} within ${TOTAL_TOLERANCE})`);
  const occupiedRows = danger.map((value, cell) => [value, cell]).filter(([value]) => value > 1e-6).map(([, cell]) => Math.floor(cell / COARSE_COLUMNS));
  check(Math.min(...occupiedRows) >= row - SIDE_CELLS - 1 && Math.max(...occupiedRows) <= row + SIDE_CELLS + 1 && Math.max(...occupiedRows) - Math.min(...occupiedRows) >= 2 * SIDE_CELLS, `the ridge is ${SIDE_CELLS} cells wide each side: rows ${Math.min(...occupiedRows)} to ${Math.max(...occupiedRows)} around row ${row}`);
  check(Math.min(...occupied) >= headColumn - 1, `nothing behind the bullet: least column ${Math.min(...occupied)} (head column ${headColumn}, one cell of blur allowed)`);
  check(Math.max(...occupied) >= headColumn + SAMPLE_COUNT - 3, `danger reaches ahead: greatest column ${Math.max(...occupied)} (need >= ${headColumn + SAMPLE_COUNT - 3})`);
  const near = danger[row * COARSE_COLUMNS + headColumn + 1];
  const far = danger[row * COARSE_COLUMNS + headColumn + SAMPLE_COUNT - 2];
  check(near > far && far > 0, `danger falls with distance ahead: near ${near.toFixed(3)} then far ${far.toFixed(3)}`);

  for (const [name, spawn] of [
    ['scatter', spawnOf(PROJECTILE_KINDS.scatter)],
    ['rail', spawnOf(PROJECTILE_KINDS.rail)],
    ['pulse orb', spawnOf(PROJECTILE_KINDS.pulseOrb, { extra: 1000 })],
    ['sidewinder', spawnOf(PROJECTILE_KINDS.sidewinder, { extra: 1 })],
  ]) {
    harness.seedPositions([]);
    harness.projectiles.queueSpawn(spawn);
    const kindTotal = total(await dangerAfter(harness, 2));
    check(kindTotal > 1, `a ${name} splats danger (${kindTotal.toFixed(2)})`);
  }

  harness.seedPositions([]);
  harness.projectiles.queueSpawn(spawnOf(PROJECTILE_KINDS.pulseRing, { velocityX: 0, radius: 0.5, lifetime: 1, extra: 2 }));
  check(total(await dangerAfter(harness, 3)) === 0, 'a pulse ring splats no danger');

  harness.seedPositions([]);
  harness.projectiles.setBeam({ x: START[0], y: START[1], directionX: 1, directionY: 0, halfWidth: 0.05 });
  const beamDanger = total(await dangerAfter(harness, 3));
  harness.projectiles.setBeam(null);
  check(beamDanger === 0, `the beam splats no danger (${beamDanger})`);

  harness.seedPositions([]);
  harness.projectiles.queueSpawn(spawnOf(PROJECTILE_KINDS.bullet, { lifetime: 0.05 }));
  check(total(await dangerAfter(harness, 10)) === 0, 'no danger lingers once the bullet has expired (undecayed, refreshed per step)');
  await harness.step();
  return { pass: verdicts.every(([ok]) => ok), detail: verdicts.map(([ok, text]) => `${ok ? 'PASS' : 'FAIL'} ${text}`).join('; ') };
}
