// Versus hits case for player-check.js (versus_hits.wgsl and the owner kill credit in
// projectiles_collide.wgsl). A 16384-slot Simulation whose species never move, with its own
// Projectiles; nothing spawns. Every step uploads seat 1 and seat 2 tables like the game does:
// seat 1 ship 2 at OWN, seat 2 ships 7 at TARGET and 9 and 10 both at PAIR. Then:
// (v1) co-op (no versus projectiles set): a seat 1 owned bullet on seat 2's ship 7 sets no bit and
//      flies on;
// (v2) versus on, an unowned bullet (what co-op fires) on ship 7: no bit, flies on;
// (v3) versus on, a seat 1 bullet on its own seat's ship 2: no bit in the first mask, flies on;
// (v4) versus on, a seat 1 bullet on ship 7: bit 7 of the second mask, the bullet is dead; a seat 1
//      bullet on the two ships at PAIR kills exactly one of them (one bit of 9 and 10) and stops;
// (v5) a seat 2 bullet through one neutral agent at AGENT: one scored kill, credited to seat 2
//      (ownerKillsSinceLastRead [0, 1]); an unowned bullet through another credits no seat;
// (v6) a seat 1 pulse ring whose band covers seat 2's ships 20 and 21 kills exactly one of them in
//      the step and lives on; a seat 1 beam along a ray through ships 30 (near) and 31 (far) kills
//      ship 30 within BEAM_HIT_STEP_INTERVAL steps while ship 31 still lives;
// (v7) the hives feeding ground: with a gate row owned by seat 2 at AGENT (radius 1.5, so a reach of
//      3), seat 2 bullets through an agent at AGENT and one at SECOND_AGENT (4 away) credit seat 2 two
//      owner kills and one feeding kill (feedingKillsSinceLastRead [0, 1]); without the row, none;
// (v8) the sparring dummy (neutralImmune on seat 2): a neutral agent on a plain seat 2 ship sets its
//      bit (control); on a neutral-immune ship it sets none, yet a seat 1 bullet on that ship still
//      claims it and stops; a fully invulnerable seat 2 ship is safe from the agent and the bullet.
import { AGENT_FLAG_ALIVE, AGENT_OFFSETS, AGENT_STRIDE_BYTES, MAXIMUM_SWARM_SHIPS, PROJECTILE_FLAG_ALIVE } from '/src/sim/layout.js';
import { Simulation } from '/src/sim/simulation.js';
import { Projectiles, PROJECTILE_STRIDE_BYTES } from '/src/game/projectiles.js';
import { PROJECTILE_KINDS } from '/src/game/weaponTypes.js';
import { SWARM_SHIP_RADIUS } from '/src/game/player-swarm.js';
import { defaultSpecies, normalizeShares } from '/src/sim/species.js';

const CAPACITY = 16384;
const STEP_SECONDS = 1 / 60;
const READBACK_ATTEMPTS = 20;
const SPOTS = {
  own: [4, 9], target: [8, 9], pair: [12, 9], agent: [16, 9], secondAgent: [20, 9],
  ringEast: [24.55, 4], ringWest: [23.45, 4], beamNear: [8, 14], beamFar: [12, 14],
  controlShip: [28, 3], immuneShip: [28, 7], invulnerableShip: [28, 12],
};
const RING_CENTER = [24, 4];
const BEAM_ORIGIN = [4, 14];
const BEAM_HIT_STEP_INTERVAL = 6;
const SEAT_TWO_SHIPS = { 7: 'target', 9: 'pair', 10: 'pair', 20: 'ringEast', 21: 'ringWest', 30: 'beamNear', 31: 'beamFar' };

// The seat 2 table and upload options of the step in progress (the (v8) cases change them).
let seatTwoShips = SEAT_TWO_SHIPS;
let seatTwoOptions = {};

async function readBuffer(device, source) {
  const staging = device.createBuffer({ size: source.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const encoder = device.createCommandEncoder({ label: 'versus-check-readback' });
  encoder.copyBufferToBuffer(source, 0, staging, 0, source.size);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const copy = staging.getMappedRange().slice(0);
  staging.unmap();
  staging.destroy();
  return copy;
}

function maskBits(mask) {
  const bits = [];
  mask.forEach((word, wordIndex) => {
    for (let bit = 0; bit < 32; bit += 1) if (((word >>> bit) & 1) === 1) bits.push(wordIndex * 32 + bit);
  });
  return bits;
}

function table(ships, fresh) {
  return Array.from({ length: MAXIMUM_SWARM_SHIPS }, (_, slot) => {
    const spot = ships[slot];
    if (spot === undefined) return { x: 0, y: 0, alive: false, fresh: false };
    return { x: SPOTS[spot][0], y: SPOTS[spot][1], alive: true, fresh };
  });
}

// A slow bullet sitting on a spot, so its one-step capsule covers the spot.
function bulletAt(spot) {
  const [x, y] = SPOTS[spot];
  return { x: x - 0.01, y, velocityX: 1, velocityY: 0, radius: 0.05, lifetime: 1, kind: PROJECTILE_KINDS.bullet };
}

export async function runVersusCase(gpu) {
  const { device } = gpu;
  const species = defaultSpecies().map((row) => ({ ...row, maximumSpeed: 0 }));
  const simulation = await Simulation.create(gpu, { capacity: CAPACITY, species, shares: normalizeShares([1, 1, 1, 1, 1]) });
  const projectiles = await Projectiles.create(gpu);
  const removePass = simulation.registerPass((encoder, context) => projectiles.encode(encoder, context));
  const collected = new Map();
  let first = true;
  const step = async (spawnGates = null) => {
    simulation.setPlayerState({ x: 1, y: 1 });
    simulation.setSwarmShips(table({ 2: 'own' }, first), SWARM_SHIP_RADIUS);
    simulation.setSwarmShips(table(seatTwoShips, first), SWARM_SHIP_RADIUS, { seat: 1, ...seatTwoOptions });
    first = false;
    const encoder = device.createCommandEncoder({ label: 'versus-check-frame' });
    simulation.step(encoder, STEP_SECONDS, undefined, spawnGates);
    device.queue.submit([encoder.finish()]);
    simulation.afterSubmit();
    await device.queue.onSubmittedWorkDone();
    const sequence = simulation.frameSequence;
    for (let attempt = 0; attempt < READBACK_ATTEMPTS && !collected.has(sequence); attempt += 1) {
      for (const stats of simulation.readAllStats()) collected.set(stats.frameSequence, stats);
      if (!collected.has(sequence)) await device.queue.onSubmittedWorkDone();
    }
    const stats = collected.get(sequence);
    if (stats === undefined) throw new Error(`no stats for frame ${sequence}`);
    return stats;
  };
  const projectileAlive = async (slots) => {
    const view = new DataView(await readBuffer(device, projectiles.buffer));
    return slots.map((slot) => (view.getUint32(slot * PROJECTILE_STRIDE_BYTES + 36, true) & PROJECTILE_FLAG_ALIVE) !== 0);
  };
  const verdicts = [];

  // (v1) co-op: versus projectiles unset.
  let slot = projectiles.queueSpawn(bulletAt('target'), 0);
  let stats = await step();
  let [alive] = await projectileAlive([slot]);
  verdicts.push([maskBits(stats.secondSwarmHitMask).length === 0 && alive, `(v1) co-op owned bullet: second mask bits ${maskBits(stats.secondSwarmHitMask).join(',')}, alive ${alive} (need none and true)`]);
  projectiles.clear();

  // (v2) and (v3) versus on, an unowned bullet on seat 2's ship and a seat 1 bullet on its own.
  simulation.setVersusProjectiles(projectiles.buffer);
  const unowned = projectiles.queueSpawn(bulletAt('target'));
  const ownShip = projectiles.queueSpawn(bulletAt('own'), 0);
  stats = await step();
  const [unownedAlive, ownAlive] = await projectileAlive([unowned, ownShip]);
  verdicts.push([maskBits(stats.secondSwarmHitMask).length === 0 && unownedAlive, `(v2) unowned bullet: second mask bits ${maskBits(stats.secondSwarmHitMask).join(',')}, alive ${unownedAlive} (need none and true)`]);
  verdicts.push([maskBits(stats.swarmHitMask).length === 0 && ownAlive, `(v3) own seat bullet: first mask bits ${maskBits(stats.swarmHitMask).join(',')}, alive ${ownAlive} (need none and true)`]);
  projectiles.clear();

  // (v4) seat 1 bullets on seat 2's ships.
  slot = projectiles.queueSpawn(bulletAt('target'), 0);
  const pairSlot = projectiles.queueSpawn(bulletAt('pair'), 0);
  stats = await step();
  [alive] = await projectileAlive([slot]);
  const [pairAlive] = await projectileAlive([pairSlot]);
  const bits = maskBits(stats.secondSwarmHitMask);
  const pairHits = bits.filter((bit) => bit === 9 || bit === 10).length;
  verdicts.push([bits.includes(7) && !alive, `(v4) seat 1 bullet on ship 7: second mask bits ${bits.join(',')}, alive ${alive} (need 7 included and false)`]);
  verdicts.push([pairHits === 1 && !pairAlive && maskBits(stats.swarmHitMask).length === 0, `(v4) one bullet on two ships: ${pairHits} of 9 and 10 hit, alive ${pairAlive}, first mask bits ${maskBits(stats.swarmHitMask).join(',')} (need 1, false and none)`]);
  projectiles.clear();

  // (v5) kill credit: one agent at each agent spot.
  const bytes = new ArrayBuffer(CAPACITY * AGENT_STRIDE_BYTES);
  const view = new DataView(bytes);
  ['agent', 'secondAgent'].forEach((spot, index) => {
    const base = index * AGENT_STRIDE_BYTES;
    view.setFloat32(base + AGENT_OFFSETS.position, SPOTS[spot][0], true);
    view.setFloat32(base + AGENT_OFFSETS.position + 4, SPOTS[spot][1], true);
    view.setUint32(base + AGENT_OFFSETS.flags, AGENT_FLAG_ALIVE, true);
  });
  device.queue.writeBuffer(simulation.agentsBuffer, 0, bytes);
  projectiles.queueSpawn(bulletAt('agent'), 1);
  projectiles.queueSpawn(bulletAt('secondAgent'));
  stats = await step();
  const credit = stats.ownerKillsSinceLastRead.join(',');
  verdicts.push([stats.killsSinceLastRead === 2 && credit === '0,1', `(v5) kills ${stats.killsSinceLastRead}, owner credit ${credit} (need 2 and 0,1)`]);
  verdicts.push([stats.feedingKillsSinceLastRead.join(',') === '0,0', `(v5) feeding credit without hives ${stats.feedingKillsSinceLastRead.join(',')} (need 0,0)`]);

  projectiles.clear();

  // (v7) the feeding ground of a hive seat 2 owns.
  device.queue.writeBuffer(simulation.agentsBuffer, 0, bytes);
  const hive = { gates: [{ x: SPOTS.agent[0], y: SPOTS.agent[1], radius: 1.5, emit: 0, species: 0, owner: 1, target: 0 }], speciesBias: 0 };
  projectiles.queueSpawn(bulletAt('agent'), 1);
  projectiles.queueSpawn(bulletAt('secondAgent'), 1);
  stats = await step(hive);
  const feeding = stats.feedingKillsSinceLastRead.join(',');
  verdicts.push([stats.ownerKillsSinceLastRead.join(',') === '0,2' && feeding === '0,1', `(v7) owner credit ${stats.ownerKillsSinceLastRead.join(',')}, feeding credit ${feeding} (need 0,2 and 0,1)`]);
  projectiles.clear();

  // (v6) a ring and a beam.
  const ring = projectiles.queueSpawn({ x: RING_CENTER[0], y: RING_CENTER[1], velocityX: 0, velocityY: 0, radius: 0.5, lifetime: 0.5, kind: PROJECTILE_KINDS.pulseRing, extra: 6 }, 0);
  stats = await step();
  const [ringAlive] = await projectileAlive([ring]);
  const ringHits = maskBits(stats.secondSwarmHitMask).filter((bit) => bit === 20 || bit === 21).length;
  verdicts.push([ringHits === 1 && ringAlive, `(v6) ring: ${ringHits} of 20 and 21 hit, alive ${ringAlive} (need 1 and true)`]);
  projectiles.clear();
  projectiles.setBeam({ x: BEAM_ORIGIN[0], y: BEAM_ORIGIN[1], directionX: 1, directionY: 0, halfWidth: 0.1 }, 0, 0);
  let beamBits = [];
  for (let index = 0; index < BEAM_HIT_STEP_INTERVAL && !beamBits.includes(30); index += 1) {
    stats = await step();
    beamBits = maskBits(stats.secondSwarmHitMask);
  }
  verdicts.push([beamBits.includes(30) && !beamBits.includes(31), `(v6) beam: second mask bits ${beamBits.join(',')} (need 30 and not 31)`]);
  projectiles.setBeam(null, 0);

  // (v8) the sparring dummy.
  const onlyAgentAt = (spot) => {
    const agentBytes = new ArrayBuffer(CAPACITY * AGENT_STRIDE_BYTES);
    const agentView = new DataView(agentBytes);
    agentView.setFloat32(AGENT_OFFSETS.position, SPOTS[spot][0], true);
    agentView.setFloat32(AGENT_OFFSETS.position + 4, SPOTS[spot][1], true);
    agentView.setUint32(AGENT_OFFSETS.flags, AGENT_FLAG_ALIVE, true);
    device.queue.writeBuffer(simulation.agentsBuffer, 0, agentBytes);
  };
  seatTwoShips = { 42: 'controlShip' };
  seatTwoOptions = {};
  onlyAgentAt('controlShip');
  stats = await step();
  verdicts.push([maskBits(stats.secondSwarmHitMask).includes(42), `(v8) control, agent on a plain seat 2 ship: second mask bits ${maskBits(stats.secondSwarmHitMask).join(',')} (need 42 included)`]);
  seatTwoShips = { 43: 'immuneShip' };
  seatTwoOptions = { neutralImmune: true };
  onlyAgentAt('immuneShip');
  stats = await step();
  stats = await step();
  verdicts.push([maskBits(stats.secondSwarmHitMask).length === 0, `(v8) agent on a neutral-immune ship: second mask bits ${maskBits(stats.secondSwarmHitMask).join(',')} (need none)`]);
  slot = projectiles.queueSpawn(bulletAt('immuneShip'), 0);
  stats = await step();
  [alive] = await projectileAlive([slot]);
  verdicts.push([maskBits(stats.secondSwarmHitMask).includes(43) && !alive, `(v8) seat 1 bullet on the neutral-immune ship: second mask bits ${maskBits(stats.secondSwarmHitMask).join(',')}, alive ${alive} (need 43 included and false)`]);
  projectiles.clear();
  seatTwoShips = { 44: 'invulnerableShip' };
  seatTwoOptions = { neutralImmune: true, invulnerable: true };
  onlyAgentAt('invulnerableShip');
  slot = projectiles.queueSpawn(bulletAt('invulnerableShip'), 0);
  stats = await step();
  [alive] = await projectileAlive([slot]);
  verdicts.push([maskBits(stats.secondSwarmHitMask).length === 0 && alive, `(v8) invulnerable ship under an agent and a bullet: second mask bits ${maskBits(stats.secondSwarmHitMask).join(',')}, alive ${alive} (need none and true)`]);
  projectiles.clear();
  seatTwoShips = SEAT_TWO_SHIPS;
  seatTwoOptions = {};

  removePass();
  projectiles.destroy();
  simulation.destroy();
  return verdicts;
}
