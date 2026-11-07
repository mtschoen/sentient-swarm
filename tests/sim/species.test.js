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
