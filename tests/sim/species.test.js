import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPECIES_FIELDS, SPECIES_NAMES, defaultSpecies, defaultMatrix, packSpeciesTable, normalizeShares } from '../../src/sim/species.js';

test('packSpeciesTable is 92 floats with the matrix after the rows', () => {
  const table = packSpeciesTable(defaultSpecies(), defaultMatrix());
  assert.equal(table.length, 92);
  assert.equal(table[60 + 4 * 5 + 0], Math.fround(0.8)); // Predator row, Chaser column
});

test('default species follow the field and name tables', () => {
  const rows = defaultSpecies();
  assert.equal(SPECIES_FIELDS.length, 12);
  assert.deepEqual(rows.map((row) => row.name), SPECIES_NAMES);
  assert.deepEqual(rows.map((row) => row.glyph), [0, 1, 2, 3, 4]);
  for (const row of rows) { assert.equal(row.reserved1, 0); }
});

test('normalizeShares sums to one and handles all zeros', () => {
  const shares = normalizeShares([2, 2, 0, 0, 0]);
  assert.equal(shares[0], 0.5);
  assert.equal(normalizeShares([0, 0, 0, 0, 0])[3], Math.fround(0.2));
});

test('normalizeShares clamps negative entries to zero', () => {
  const shares = normalizeShares([-3, 1, 1, 0, 0]);
  assert.equal(shares[0], 0);
  assert.equal(shares[1], 0.5);
});

test('packSpeciesTable packs each row hue at field index 10', () => {
  const table = packSpeciesTable(defaultSpecies(), defaultMatrix());
  defaultSpecies().forEach((row, index) => assert.equal(table[index * 12 + 10], Math.fround(row.hue)));
});

test('normalizeShares treats NaN and non-finite shares as zero and falls back to equal shares when all are zero', () => {
  const mixed = normalizeShares([NaN, 1, Infinity, 3, -Infinity]);
  assert.deepEqual(Array.from(mixed), [0, 0.25, 0, 0.75, 0]);
  assert.deepEqual(Array.from(normalizeShares([NaN, Infinity, -Infinity, NaN, undefined])), Array(5).fill(Math.fround(0.2)));
  assert.deepEqual(Array.from(normalizeShares([0, 0, 0, 0, 0])), Array(5).fill(Math.fround(0.2)));
});

test('every default species row has finite numeric fields, a unit hue and positive speed limits', () => {
  for (const row of defaultSpecies()) {
    for (const field of SPECIES_FIELDS) {
      assert.equal(typeof row[field], 'number', `${row.name} ${field}`);
      assert.ok(Number.isFinite(row[field]), `${row.name} ${field}`);
    }
    assert.ok(row.hue >= 0 && row.hue < 1, `${row.name} hue`);
    assert.ok(row.maximumSpeed > 0 && row.maximumTurn > 0 && row.targetDensity > 0, row.name);
    assert.ok(row.seek >= 0 && row.separation >= 0, row.name);
  }
});

test('the packed default table and the default matrix are finite', () => {
  const table = packSpeciesTable(defaultSpecies(), defaultMatrix());
  assert.ok(Array.from(table).every(Number.isFinite));
  assert.ok(Array.from(defaultMatrix()).every(Number.isFinite));
  assert.equal(defaultMatrix().length, 25);
});

test('the default rows pin their starting numbers', () => {
  const pinned = {
    Chaser: [0.02, 0.6, 0.5, 1.4, 0.9, 4.5, 0.9, 0, 0.4, 0.6, 120],
    Orbiter: [0.55, 0.5, 0.3, 0.9, 0.3, 3.0, 0.5, 2.4, 0, 0.2, 90],
    Skittish: [0.15, 0.5, 0.9, 0.4, 0.3, 5.0, 0.8, 0, 2.0, 0.5, 150],
    Lattice: [0.75, 0.15, 0.1, 0.9, 1.8, 2.0, 0.3, 0, 0, 1.0, 120],
    Predator: [0.92, 0.2, 0.2, 0.3, 0.4, 4.5, 0.7, 0, 0, 0.5, 80],
  };
  const fields = ['hue', 'seek', 'cohesion', 'alignment', 'separation', 'maximumSpeed', 'maximumTurn', 'orbitRadius', 'flee', 'pressure', 'targetDensity'];
  for (const row of defaultSpecies()) assert.deepEqual(fields.map((field) => row[field]), pinned[row.name], row.name);
});

test('the default matrix has the predator rows only', () => {
  const matrix = defaultMatrix();
  const nonzero = Array.from(matrix).map((value, index) => [index, value]).filter(([, value]) => value !== 0);
  assert.deepEqual(nonzero.map(([index]) => index), [20, 22, 23]);
  assert.deepEqual(nonzero.map(([, value]) => value), [0.8, 0.8, -0.6].map(Math.fround));
});
