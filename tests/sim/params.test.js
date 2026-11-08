import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COMFORT_RADIUS, DEFAULT_KILL_BURST_PARTICLES, DEFAULT_KILL_FRAGMENT_PARTICLES, DEFAULT_SPAWN_BAND_WIDTH,
  DEFAULT_SPAWN_DENSITY_BIAS, DEFAULT_WALL_MARGIN, DEFAULT_WALL_STIFFNESS, MAXIMUM_COMFORT_RADIUS, MAXIMUM_DEATH_FLOOD_PARTICLES,
  MAXIMUM_KILL_BURST_PARTICLES, MAXIMUM_KILL_FRAGMENT_PARTICLES, MAXIMUM_WALL_MARGIN, MAXIMUM_WALL_STIFFNESS, SIM_PARAMS_BYTES,
  packSimParams, validatedComfortRadius, validatedDeathFloodParticles, validatedKillBurstParticles, validatedKillFragmentParticles,
  validatedSpawnBandWidth, validatedSpawnDensityBias, validatedWallMargin, validatedWallStiffness,
} from '../../src/sim/params.js';

test('packSimParams produces the 240-byte uniform layout', () => {
  const buffer = packSimParams({
    dt: 0.5,
    gridColumns: 160,
    cellSize: 0.25,
    capacity: 4096,
    frameSequence: 7,
    playerPosition: [3, 4],
    spawnPerSpecies: [1, 2, 3, 4, 5],
  });
  assert.equal(SIM_PARAMS_BYTES, 240);
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
    // Same-species cohesion defaults to on the seek scale to 1 (full seek), the spawn distance to
    // 0.25 of the arena width, and the kill burst, spawn band and density bias to their defaults.
    if (offset === 108) assert.equal(view.getFloat32(offset, true), 1);
    else if (offset === 36) assert.equal(view.getFloat32(offset, true), 0.25);
    else if (offset === 112) assert.equal(view.getUint32(offset, true), DEFAULT_KILL_BURST_PARTICLES);
    else if (offset === 116) assert.equal(view.getFloat32(offset, true), Math.fround(DEFAULT_SPAWN_BAND_WIDTH));
    else if (offset === 120) assert.equal(view.getFloat32(offset, true), Math.fround(DEFAULT_SPAWN_DENSITY_BIAS));
    else if (offset === 124) assert.equal(view.getUint32(offset, true), DEFAULT_KILL_FRAGMENT_PARTICLES);
    else if (offset === 220) assert.equal(view.getFloat32(offset, true), DEFAULT_WALL_MARGIN);
    else if (offset === 224) assert.equal(view.getFloat32(offset, true), DEFAULT_WALL_STIFFNESS);
    else if (offset === 228) assert.equal(view.getFloat32(offset, true), DEFAULT_COMFORT_RADIUS);
    else if (offset === 232) assert.equal(view.getUint32(offset, true), 1);
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

test('packSimParams writes spawnDistanceFraction as f32 at byte offset 36', () => {
  assert.equal(new DataView(packSimParams({ spawnDistanceFraction: 0.375 })).getFloat32(36, true), 0.375);
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
  assert.equal(validatedSpawnBandWidth(4.5), 4.5);
  for (const bad of [0, -1, 4.6, Number.NaN]) assert.throws(() => validatedSpawnBandWidth(bad), RangeError);
  assert.equal(validatedSpawnDensityBias(0), 0);
  assert.equal(validatedSpawnDensityBias(1), 1);
  for (const bad of [-0.1, 1.1, Number.NaN]) assert.throws(() => validatedSpawnDensityBias(bad), RangeError);
});
