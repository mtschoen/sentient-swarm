import { SPECIES_COUNT } from './layout.js';

export const SPECIES_FIELDS = ['seek', 'cohesion', 'alignment', 'separation', 'maximumSpeed', 'maximumTurn', 'orbitRadius', 'flee', 'pressure', 'targetDensity', 'hue', 'reserved1'];
export const SPECIES_NAMES = ['Chaser', 'Orbiter', 'Skittish', 'Lattice', 'Predator'];

const FIELD_COUNT = SPECIES_FIELDS.length;
const MATRIX_PADDED_FLOATS = 32;

// Numbers are starting points; the lab retunes them.
const DEFAULT_ROWS = [
  // Chaser: strong seek and cohesion, medium alignment; forms the river.
  { name: 'Chaser', hue: 0.02, glyph: 0, seek: 1.0, cohesion: 0.9, alignment: 0.5, separation: 0.3, maximumSpeed: 4.0, maximumTurn: 0.6, orbitRadius: 0, flee: 0, pressure: 0.5, targetDensity: 60 },
  // Orbiter: medium seek, holds 2.4 units (15 percent of arena width), strong alignment.
  { name: 'Orbiter', hue: 0.55, glyph: 1, seek: 0.5, cohesion: 0.3, alignment: 0.9, separation: 0.3, maximumSpeed: 3.0, maximumTurn: 0.5, orbitRadius: 2.4, flee: 0, pressure: 0.2, targetDensity: 40 },
  // Skittish: medium seek, strong cohesion, very strong flee from fire.
  { name: 'Skittish', hue: 0.15, glyph: 2, seek: 0.5, cohesion: 0.9, alignment: 0.4, separation: 0.3, maximumSpeed: 5.0, maximumTurn: 0.8, orbitRadius: 0, flee: 2.0, pressure: 0.5, targetDensity: 80 },
  // Lattice: weak seek, very strong separation, strong alignment, slow.
  { name: 'Lattice', hue: 0.75, glyph: 3, seek: 0.15, cohesion: 0.1, alignment: 0.9, separation: 1.8, maximumSpeed: 2.0, maximumTurn: 0.3, orbitRadius: 0, flee: 0, pressure: 1.0, targetDensity: 150 },
  // Predator: weak seek; cross-species behaviour comes from the matrix.
  { name: 'Predator', hue: 0.92, glyph: 4, seek: 0.2, cohesion: 0.2, alignment: 0.3, separation: 0.4, maximumSpeed: 4.5, maximumTurn: 0.7, orbitRadius: 0, flee: 0, pressure: 0.2, targetDensity: 30 },
];

export function defaultSpecies() {
  return DEFAULT_ROWS.map((row) => ({ reserved1: 0, ...row }));
}

export function defaultMatrix() {
  const matrix = new Float32Array(SPECIES_COUNT * SPECIES_COUNT);
  const predator = SPECIES_NAMES.indexOf('Predator');
  matrix[predator * SPECIES_COUNT + SPECIES_NAMES.indexOf('Chaser')] = 0.8;
  matrix[predator * SPECIES_COUNT + SPECIES_NAMES.indexOf('Skittish')] = 0.8;
  matrix[predator * SPECIES_COUNT + SPECIES_NAMES.indexOf('Lattice')] = -0.6;
  return matrix;
}

export function packSpeciesTable(rows, matrix) {
  const table = new Float32Array(SPECIES_COUNT * FIELD_COUNT + MATRIX_PADDED_FLOATS);
  rows.slice(0, SPECIES_COUNT).forEach((row, index) => {
    SPECIES_FIELDS.forEach((field, fieldIndex) => {
      table[index * FIELD_COUNT + fieldIndex] = row[field] ?? 0;
    });
  });
  table.set(matrix, SPECIES_COUNT * FIELD_COUNT);
  return table;
}

export function normalizeShares(shares) {
  const clamped = Float32Array.from(shares, (share) => Math.max(0, share));
  const total = clamped.reduce((sum, share) => sum + share, 0);
  if (total === 0) return new Float32Array(clamped.length).fill(1 / clamped.length);
  return clamped.map((share) => share / total);
}
