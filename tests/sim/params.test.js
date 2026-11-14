import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COMFORT_RADIUS, DEFAULT_DEATH_FLOOD_PARTICLES, SIM_PARAMS_GATES, DEFAULT_KILL_BURST_PARTICLES, DEFAULT_KILL_FRAGMENT_PARTICLES, DEFAULT_SPAWN_BAND_WIDTH,
  DEFAULT_SPAWN_DENSITY_BIAS, DEFAULT_SPAWN_DISTANCE, DEFAULT_WALL_MARGIN, DEFAULT_WALL_STIFFNESS, MAXIMUM_COMFORT_RADIUS, MAXIMUM_DEATH_FLOOD_PARTICLES,
  MAXIMUM_KILL_BURST_PARTICLES, MAXIMUM_KILL_FRAGMENT_PARTICLES, MAXIMUM_WALL_MARGIN, MAXIMUM_WALL_STIFFNESS, SIM_PARAMS_BYTES,
  packSimParams, validatedComfortRadius, validatedDeathFloodParticles, validatedKillBurstParticles, validatedKillFragmentParticles,
  validatedWorldBounds, validatedSpawnBandWidth, validatedSpawnDensityBias, validatedWallMargin, validatedWallStiffness,
} from '../../src/sim/params.js';
import { WORLD_HEIGHT, WORLD_WIDTH, WORLD_BOUNDS } from '../../src/sim/layout.js';
import { centeredViewBounds } from './centered-view-bounds.js';

test('packSimParams produces the 256-byte uniform layout', () => {
  const buffer = packSimParams({
    dt: 0.5,
    gridColumns: 160,
    cellSize: 0.25,
    capacity: 4096,
    frameSequence: 7,
    playerPosition: [3, 4],
    spawnPerSpecies: [1, 2, 3, 4, 5],
  });
  assert.equal(SIM_PARAMS_BYTES, 256);
  assert.equal(SIM_PARAMS_BYTES % 16, 0);
  assert.equal(buffer.byteLength, SIM_PARAMS_BYTES);
  const view = new DataView(buffer);
  assert.equal(view.getFloat32(0, true), 0.5);
  assert.equal(view.getUint32(20, true), 160);
  assert.equal(view.getFloat32(28, true), 0.25);
  assert.equal(view.getUint32(32, true), 4096);
  assert.equal(view.getUint32(84, true), 7);
  assert.equal(view.getFloat32(8, true), 3);
  assert.equal(view.getFloat32(12, true), 4);
  assert.deepEqual([48, 52, 56, 60, 64].map((offset) => view.getUint32(offset, true)), [1, 2, 3, 4, 5]);
});

test('packSimParams defaults missing fields to zero', () => {
  const view = new DataView(packSimParams({}));
  for (let offset = 0; offset < SIM_PARAMS_BYTES; offset += 4) {
    // Same-species cohesion defaults to on, the seek scale to 1 (full seek), the spawn distance to
    // a quarter of the 16:9 view width (world units), and the kill burst, spawn band and density bias to their defaults.
    if (offset === 108) assert.equal(view.getFloat32(offset, true), 1);
    else if (offset === 36) assert.equal(view.getFloat32(offset, true), DEFAULT_SPAWN_DISTANCE);
    else if (offset === 112) assert.equal(view.getUint32(offset, true), DEFAULT_KILL_BURST_PARTICLES);
    else if (offset === 116) assert.equal(view.getFloat32(offset, true), Math.fround(DEFAULT_SPAWN_BAND_WIDTH));
    else if (offset === 120) assert.equal(view.getFloat32(offset, true), Math.fround(DEFAULT_SPAWN_DENSITY_BIAS));
    else if (offset === 124) assert.equal(view.getUint32(offset, true), DEFAULT_KILL_FRAGMENT_PARTICLES);
    else if (offset === 220) assert.equal(view.getFloat32(offset, true), DEFAULT_WALL_MARGIN);
    else if (offset === 224) assert.equal(view.getFloat32(offset, true), DEFAULT_WALL_STIFFNESS);
    else if (offset === 228) assert.equal(view.getFloat32(offset, true), DEFAULT_COMFORT_RADIUS);
    else if (offset === 232) assert.equal(view.getUint32(offset, true), 1);
    else if (offset === 248) assert.equal(view.getFloat32(offset, true), WORLD_WIDTH);
    else if (offset === 252) assert.equal(view.getFloat32(offset, true), WORLD_HEIGHT);
    else assert.equal(view.getUint32(offset, true), offset === 88 ? 1 : 0);
  }
});

test('packSimParams writes sameSpeciesCohesion at byte offset 88', () => {
  assert.equal(new DataView(packSimParams({ sameSpeciesCohesion: 0 })).getUint32(88, true), 0);
  assert.equal(new DataView(packSimParams({ sameSpeciesCohesion: 1 })).getUint32(88, true), 1);
  assert.equal(new DataView(packSimParams({})).getUint32(88, true), 1);
});

test('packSimParams rejects more spawn counts than species', () => {
  assert.throws(() => packSimParams({ spawnPerSpecies: [1, 1, 1, 1, 1, 1] }), /at most 5 species/);
});

test('packSimParams writes the player contact and kill-all fields', () => {
  const view = new DataView(packSimParams({ playerRadius: 0.25, playerInvulnerable: 1, acknowledgedHitSequence: 77, killAllRequested: 1 }));
  assert.equal(view.getFloat32(92, true), 0.25);
  assert.equal(view.getUint32(96, true), 1);
  assert.equal(view.getUint32(100, true), 77);
  assert.equal(view.getUint32(104, true), 1);
});

test('packSimParams writes seekScale as f32 at byte offset 108', () => {
  assert.equal(new DataView(packSimParams({ seekScale: 0.25 })).getFloat32(108, true), 0.25);
  assert.equal(new DataView(packSimParams({ seekScale: 0 })).getFloat32(108, true), 0);
});

test('packSimParams writes spawnDistance (world units) as f32 at byte offset 36', () => {
  assert.equal(new DataView(packSimParams({ spawnDistance: 0.375 })).getFloat32(36, true), 0.375);
});

test('the kill burst defaults to about a dozen particles (owner ruling R12)', () => {
  assert.equal(DEFAULT_KILL_BURST_PARTICLES, 12);
});

test('packSimParams writes killBurstParticles as u32 at byte offset 112', () => {
  assert.equal(new DataView(packSimParams({ killBurstParticles: 5 })).getUint32(112, true), 5);
  assert.equal(new DataView(packSimParams({ killBurstParticles: 0 })).getUint32(112, true), 0);
});

test('packSimParams writes spawnBandWidth and spawnDensityBias as f32 at byte offsets 116 and 120', () => {
  const view = new DataView(packSimParams({ spawnBandWidth: 1.5, spawnDensityBias: 0.25 }));
  assert.equal(view.getFloat32(116, true), 1.5);
  assert.equal(view.getFloat32(120, true), 0.25);
});

test('packSimParams writes killFragmentParticles at 124 and deathFloodParticles at 216 as u32', () => {
  const view = new DataView(packSimParams({ killFragmentParticles: 5, deathFloodParticles: 300 }));
  assert.equal(view.getUint32(124, true), 5);
  assert.equal(view.getUint32(216, true), 300);
  assert.equal(view.getUint32(236, true), 0);
});

test('the wall, comfort and coarse-field defaults are the shader constants they replaced', () => {
  // integrate.wgsl WALL_MARGIN 0.5 and WALL_STIFFNESS 40, steer.wgsl COMFORT_RADIUS 1, and the
  // pressure term always on.
  assert.equal(DEFAULT_WALL_MARGIN, 0.5);
  assert.equal(DEFAULT_WALL_STIFFNESS, 40);
  assert.equal(DEFAULT_COMFORT_RADIUS, 1);
  assert.equal(new DataView(packSimParams({})).getUint32(232, true), 1);
});

test('packSimParams writes wallMargin, wallStiffness, comfortRadius (f32) and coarseFieldPressure (u32) from 220', () => {
  const view = new DataView(packSimParams({ wallMargin: 1.25, wallStiffness: 80, comfortRadius: 2.5, coarseFieldPressure: 0 }));
  assert.equal(view.getFloat32(220, true), 1.25);
  assert.equal(view.getFloat32(224, true), 80);
  assert.equal(view.getFloat32(228, true), 2.5);
  assert.equal(view.getUint32(232, true), 0);
  assert.equal(new DataView(packSimParams({ wallMargin: 0, comfortRadius: 0 })).getFloat32(220, true), 0);
});

test('the wall and comfort setters accept their ranges and reject the rest', () => {
  for (const [validate, maximum] of [[validatedWallMargin, MAXIMUM_WALL_MARGIN], [validatedWallStiffness, MAXIMUM_WALL_STIFFNESS], [validatedComfortRadius, MAXIMUM_COMFORT_RADIUS]]) {
    assert.equal(validate(0), 0);
    assert.equal(validate(maximum), maximum);
    for (const bad of [-0.01, maximum + 0.01, Number.NaN]) assert.throws(() => validate(bad), RangeError);
  }
  assert.deepEqual([MAXIMUM_WALL_MARGIN, MAXIMUM_COMFORT_RADIUS], [2, 4]);
});

test('packSimParams writes the gate table: rows from 128, species from 192, count at 208, bias at 212', () => {
  const view = new DataView(packSimParams({
    spawnGates: {
      gates: [{ x: 1, y: 2, radius: 0.5, emit: 1, species: 3 }, { x: 4, y: 5, radius: 0.75, emit: 0, species: 1 }],
      speciesBias: 0.5,
    },
  }));
  assert.deepEqual([128, 132, 136, 140, 144, 148, 152, 156].map((offset) => view.getFloat32(offset, true)), [1, 2, 0.5, 1, 4, 5, 0.75, 0]);
  assert.deepEqual([192, 196].map((offset) => view.getUint32(offset, true)), [3, 1]);
  assert.equal(view.getUint32(208, true), 2);
  assert.equal(view.getFloat32(212, true), 0.5);
  assert.throws(() => packSimParams({ spawnGates: { gates: new Array(5).fill({ x: 0, y: 0, radius: 1, emit: 1, species: 0 }) } }), /at most 4/);
});

test('the fragment and death flood setters accept their ranges and reject the rest', () => {
  assert.equal(validatedKillFragmentParticles(0), 0);
  assert.equal(validatedKillFragmentParticles(MAXIMUM_KILL_FRAGMENT_PARTICLES), MAXIMUM_KILL_FRAGMENT_PARTICLES);
  for (const bad of [-1, 1.5, MAXIMUM_KILL_FRAGMENT_PARTICLES + 1]) assert.throws(() => validatedKillFragmentParticles(bad), RangeError);
  assert.equal(validatedDeathFloodParticles(MAXIMUM_DEATH_FLOOD_PARTICLES), MAXIMUM_DEATH_FLOOD_PARTICLES);
  for (const bad of [-1, 0.5, MAXIMUM_DEATH_FLOOD_PARTICLES + 1]) assert.throws(() => validatedDeathFloodParticles(bad), RangeError);
});

test('the spawn and burst setters accept their ranges and reject the rest', () => {
  assert.equal(validatedKillBurstParticles(0), 0);
  assert.equal(validatedKillBurstParticles(MAXIMUM_KILL_BURST_PARTICLES), MAXIMUM_KILL_BURST_PARTICLES);
  for (const bad of [-1, 2.5, MAXIMUM_KILL_BURST_PARTICLES + 1, Number.NaN]) assert.throws(() => validatedKillBurstParticles(bad), RangeError);
  assert.equal(validatedSpawnBandWidth(WORLD_HEIGHT / 2), WORLD_HEIGHT / 2);
  for (const bad of [0, -1, WORLD_HEIGHT / 2 + 0.1, Number.NaN]) assert.throws(() => validatedSpawnBandWidth(bad), RangeError);
  assert.equal(validatedSpawnDensityBias(0), 0);
  assert.equal(validatedSpawnDensityBias(1), 1);
  for (const bad of [-0.1, 1.1, Number.NaN]) assert.throws(() => validatedSpawnDensityBias(bad), RangeError);
});

// Owner ruling R31: the projectiles step on their own (unscaled) time during a time warp.
test('packSimParams writes projectileDt as f32 at byte offset 236, defaulting to dt', () => {
  assert.equal(new DataView(packSimParams({ dt: 0.25, projectileDt: 0.5 })).getFloat32(236, true), 0.5);
  assert.equal(new DataView(packSimParams({ dt: 0.25 })).getFloat32(236, true), 0.25);
});

test('every packSimParams field lands at its pinned byte offset with its type', () => {
  const view = new DataView(packSimParams({
    dt: 1.5, time: 2.5, neighborRadius: 3.5, cellSize: 4.5, debugKillRadius: 5.5, playerRadius: 6.5,
    gridColumns: 7, gridRows: 8, capacity: 9, frameSequence: 10,
    playerInvulnerable: 1, acknowledgedHitSequence: 11, killAllRequested: 1,
    playerPosition: [12.5, 13.5], debugKillPosition: [14.5, 15.5],
    sameSpeciesCohesion: 0, seekScale: 0.25, spawnDistance: 0.375, killBurstParticles: 16,
    spawnBandWidth: 1.25, spawnDensityBias: 0.75, killFragmentParticles: 17, deathFloodParticles: 18,
    wallMargin: 1.5, wallStiffness: 20.5, comfortRadius: 2.25, coarseFieldPressure: 0, projectileDt: 0.125,
    spawnPerSpecies: [21, 22, 23, 24, 25],
  }));
  const floats = { 0: 1.5, 4: 2.5, 16: 3.5, 28: 4.5, 80: 5.5, 92: 6.5, 8: 12.5, 12: 13.5, 40: 14.5, 44: 15.5, 108: 0.25, 36: 0.375, 116: 1.25, 120: 0.75, 220: 1.5, 224: 20.5, 228: 2.25, 236: 0.125 };
  const unsigned = { 20: 7, 24: 8, 32: 9, 84: 10, 96: 1, 100: 11, 104: 1, 88: 0, 112: 16, 124: 17, 216: 18, 232: 0, 48: 21, 52: 22, 56: 23, 60: 24, 64: 25 };
  for (const [offset, value] of Object.entries(floats)) assert.equal(view.getFloat32(Number(offset), true), value, `float at ${offset}`);
  for (const [offset, value] of Object.entries(unsigned)) assert.equal(view.getUint32(Number(offset), true), value, `u32 at ${offset}`);
});

test('the unwritten bytes stay zero: 68 to 79 padding, 160 and 164 to 191 gate rows when no gates are given, and the tail past 256 does not exist', () => {
  const view = new DataView(packSimParams({ spawnPerSpecies: [1, 1, 1, 1, 1] }));
  for (let offset = 68; offset < 80; offset += 4) assert.equal(view.getUint32(offset, true), 0, `offset ${offset}`);
  for (let offset = 128; offset < 208; offset += 4) assert.equal(view.getUint32(offset, true), 0, `offset ${offset}`);
  assert.equal(view.byteLength, 256);
  assert.throws(() => view.getUint32(256, true), RangeError);
});

test('the packed defaults when nothing is given pin the omitted-field values by offset', () => {
  const view = new DataView(packSimParams({}));
  assert.equal(view.getUint32(88, true), 1, 'sameSpeciesCohesion');
  assert.equal(view.getFloat32(108, true), 1, 'seekScale');
  assert.equal(view.getFloat32(36, true), 4, 'spawnDistance');
  assert.equal(view.getUint32(112, true), 12, 'killBurstParticles');
  assert.equal(view.getFloat32(116, true), Math.fround(0.6), 'spawnBandWidth');
  assert.equal(view.getFloat32(120, true), 0.5, 'spawnDensityBias');
  assert.equal(view.getUint32(124, true), 3, 'killFragmentParticles');
  assert.equal(view.getUint32(216, true), 0, 'deathFloodParticles');
  assert.equal(view.getFloat32(220, true), 0.5, 'wallMargin');
  assert.equal(view.getFloat32(224, true), 40, 'wallStiffness');
  assert.equal(view.getFloat32(228, true), 1, 'comfortRadius');
  assert.equal(view.getUint32(232, true), 1, 'coarseFieldPressure');
  assert.equal(view.getFloat32(236, true), 0, 'projectileDt follows dt');
  assert.equal(DEFAULT_DEATH_FLOOD_PARTICLES, 480);
  assert.equal(SIM_PARAMS_GATES, 4);
});

test('projectileDt follows dt when omitted and an explicit zero is kept', () => {
  assert.equal(new DataView(packSimParams({ dt: 0.02 })).getFloat32(236, true), Math.fround(0.02));
  assert.equal(new DataView(packSimParams({ dt: 0.02, projectileDt: 0 })).getFloat32(236, true), 0);
  assert.equal(new DataView(packSimParams({ dt: 0.02, projectileDt: 0.05 })).getFloat32(236, true), Math.fround(0.05));
});

test('the gate table packs four rows in order and a species per gate', () => {
  const gates = [0, 1, 2, 3].map((index) => ({ x: index + 0.5, y: index + 10, radius: 0.25 * (index + 1), emit: index % 2, species: 4 - index }));
  const view = new DataView(packSimParams({ spawnGates: { gates, speciesBias: 0.25 } }));
  gates.forEach((gate, index) => {
    assert.deepEqual([0, 4, 8, 12].map((component) => view.getFloat32(128 + index * 16 + component, true)), [gate.x, gate.y, gate.radius, gate.emit]);
    assert.equal(view.getUint32(192 + index * 4, true), gate.species);
  });
  assert.equal(view.getUint32(208, true), 4);
  assert.equal(view.getFloat32(212, true), 0.25);
});

test('the range constants and defaults are pinned by value', () => {
  assert.deepEqual(
    [DEFAULT_KILL_BURST_PARTICLES, MAXIMUM_KILL_BURST_PARTICLES, DEFAULT_KILL_FRAGMENT_PARTICLES, MAXIMUM_KILL_FRAGMENT_PARTICLES, MAXIMUM_DEATH_FLOOD_PARTICLES],
    [12, 64, 3, 16, 4096],
  );
  assert.deepEqual(
    [DEFAULT_WALL_MARGIN, MAXIMUM_WALL_MARGIN, DEFAULT_WALL_STIFFNESS, MAXIMUM_WALL_STIFFNESS, DEFAULT_COMFORT_RADIUS, MAXIMUM_COMFORT_RADIUS],
    [0.5, 2, 40, 160, 1, 4],
  );
  assert.deepEqual([DEFAULT_SPAWN_BAND_WIDTH, DEFAULT_SPAWN_DENSITY_BIAS], [0.6, 0.5]);
});

test('packSimParams packs the world bounds as a vec4f at 240, the whole world when omitted', () => {
  const read = (view) => [240, 244, 248, 252].map((offset) => view.getFloat32(offset, true));
  assert.deepEqual(read(new DataView(packSimParams({}))), [0, 0, WORLD_WIDTH, WORLD_HEIGHT]);
  assert.deepEqual(read(new DataView(packSimParams({ worldBounds: WORLD_BOUNDS }))), [0, 0, WORLD_WIDTH, WORLD_HEIGHT]);
  const narrow = centeredViewBounds(1);
  assert.deepEqual(read(new DataView(packSimParams({ worldBounds: narrow }))), [narrow.minX, narrow.minY, narrow.maxX, narrow.maxY]);
  // The bounds leave every earlier field where it was.
  const view = new DataView(packSimParams({ worldBounds: { minX: 1.25, minY: 0.5, maxX: 14.75, maxY: 8.5 }, projectileDt: 0.125 }));
  assert.deepEqual(read(view), [1.25, 0.5, 14.75, 8.5]);
  assert.equal(view.getFloat32(236, true), 0.125);
});

test('validatedWorldBounds accepts rectangles inside the world and rejects the rest', () => {
  assert.deepEqual(validatedWorldBounds(WORLD_BOUNDS), { ...WORLD_BOUNDS });
  assert.deepEqual(validatedWorldBounds({ minX: 2, minY: 1, maxX: 6, maxY: 4 }), { minX: 2, minY: 1, maxX: 6, maxY: 4, width: 4, height: 3 });
  for (const bounds of [
    undefined, {}, { minX: 0, minY: 0, maxX: Number.NaN, maxY: 9 }, { minX: 0, minY: 0, maxX: Infinity, maxY: 9 },
    { minX: 4, minY: 0, maxX: 4, maxY: 9 }, { minX: 0, minY: 5, maxX: 16, maxY: 2 },
    { minX: -0.5, minY: 0, maxX: 16, maxY: 9 }, { minX: 0, minY: 0, maxX: WORLD_WIDTH + 0.5, maxY: 9 }, { minX: 0, minY: 0, maxX: 16, maxY: WORLD_HEIGHT + 0.5 },
  ]) {
    assert.throws(() => validatedWorldBounds(bounds), RangeError, JSON.stringify(bounds));
  }
});
