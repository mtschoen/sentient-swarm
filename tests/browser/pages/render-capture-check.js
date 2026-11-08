// Deterministic render capture (tests/browser/render-capture.mjs). A 65536-slot Simulation, never
// stepped, gets a fixed agent pattern written straight into its buffers: AGENT_COUNT alive agents
// of all five species from the projectiles page's seeded sequence (mulberry32, seed 12345), their
// per-cell counts as the coarse field (plus a radial threat), so the glyph attenuation and the warp
// grid sample a non-empty field, a ring of live particles and one open spawn gate. The renderer
// draws one fixed scene (the ship, one projectile of each kind, one pickup) at time and sceneTime
// 1.0, timeWarp 0, alpha 0 and trails off, once per bloom quality, and publishes the composited
// RGBA frames as window.__renderCapture = { pass, detail, width, height, qualities: [{ quality,
// width, height, pixelsBase64, pngDataUrl }] }.
import { createGpuContext } from '/src/gpu/device.js';
import { createStorageBuffer } from '/src/gpu/buffers.js';
import { packProjectile, PROJECTILE_STRIDE_BYTES } from '/src/game/projectiles.js';
import { PROJECTILE_KINDS } from '/src/game/weaponTypes.js';
import { BLOOM_DIVISORS } from '/src/render/bloom.js';
import { Renderer } from '/src/render/renderer.js';
import { Viewport } from '/src/render/viewport.js';
import {
  AGENT_FLAG_ALIVE, AGENT_OFFSETS, AGENT_STRIDE_BYTES, ARENA_HEIGHT, ARENA_WIDTH, COARSE_CHANNELS, COARSE_COLUMNS, COARSE_ROWS, SPECIES_COUNT,
} from '/src/sim/layout.js';
import { PARTICLE_HEADER_BYTES, PARTICLE_STRIDE_BYTES } from '/src/sim/particles.js';
import { Simulation } from '/src/sim/simulation.js';
import { normalizeShares } from '/src/sim/species.js';

const CAPACITY = 65536;
const AGENT_COUNT = 6000;
const RENDER_TIME = 1.0;
const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const PARTICLE_COUNT = 24;
const TAU = Math.PI * 2;
const THREAT_CENTER = [9, 5];
const THREAT_PEAK = 6;

// The projectiles page's generator (mulberry32), so every run sees the same layout.
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Writes the agents into both agent buffers and returns their per-coarse-cell, per-species counts.
function seedAgents(device, simulation, random) {
  const bytes = new ArrayBuffer(CAPACITY * AGENT_STRIDE_BYTES);
  const view = new DataView(bytes);
  const counts = new Float32Array(COARSE_COLUMNS * COARSE_ROWS * SPECIES_COUNT);
  for (let slot = 0; slot < AGENT_COUNT; slot += 1) {
    const x = 0.05 + random() * (ARENA_WIDTH - 0.1);
    const y = 0.05 + random() * (ARENA_HEIGHT - 0.1);
    const heading = random() * TAU;
    const speed = 0.5 + random();
    const species = slot % SPECIES_COUNT;
    const base = slot * AGENT_STRIDE_BYTES;
    view.setFloat32(base + AGENT_OFFSETS.position, x, true);
    view.setFloat32(base + AGENT_OFFSETS.position + 4, y, true);
    view.setFloat32(base + AGENT_OFFSETS.velocity, Math.cos(heading) * speed, true);
    view.setFloat32(base + AGENT_OFFSETS.velocity + 4, Math.sin(heading) * speed, true);
    view.setUint32(base + AGENT_OFFSETS.species, species, true);
    view.setUint32(base + AGENT_OFFSETS.flags, AGENT_FLAG_ALIVE, true);
    view.setFloat32(base + AGENT_OFFSETS.phase, random() * TAU, true);
    view.setFloat32(base + AGENT_OFFSETS.hueJitter, random() * 2 - 1, true);
    const column = Math.min(COARSE_COLUMNS - 1, Math.floor((x / ARENA_WIDTH) * COARSE_COLUMNS));
    const row = Math.min(COARSE_ROWS - 1, Math.floor((y / ARENA_HEIGHT) * COARSE_ROWS));
    counts[(row * COARSE_COLUMNS + column) * SPECIES_COUNT + species] += 1;
  }
  device.queue.writeBuffer(simulation.agentsBuffer, 0, bytes);
  device.queue.writeBuffer(simulation.previousAgentsBuffer, 0, bytes);
  return counts;
}

// The coarse field as the blurred buffer holds it: per cell, five species densities, the threat
// and two padding channels.
function seedField(device, simulation, counts) {
  const field = new Float32Array(COARSE_COLUMNS * COARSE_ROWS * COARSE_CHANNELS);
  for (let row = 0; row < COARSE_ROWS; row += 1) {
    for (let column = 0; column < COARSE_COLUMNS; column += 1) {
      const cell = row * COARSE_COLUMNS + column;
      for (let species = 0; species < SPECIES_COUNT; species += 1) {
        field[cell * COARSE_CHANNELS + species] = counts[cell * SPECIES_COUNT + species];
      }
      const x = ((column + 0.5) / COARSE_COLUMNS) * ARENA_WIDTH;
      const y = ((row + 0.5) / COARSE_ROWS) * ARENA_HEIGHT;
      const distance = Math.hypot(x - THREAT_CENTER[0], y - THREAT_CENTER[1]);
      field[cell * COARSE_CHANNELS + SPECIES_COUNT] = THREAT_PEAK * Math.exp(-distance * distance);
    }
  }
  device.queue.writeBuffer(simulation.fieldBuffer, 0, field);
}

// A ring of live particles (Particle in common.wgsl), every fourth a heavy fragment.
function seedParticles(device, simulation, random) {
  const bytes = new ArrayBuffer(PARTICLE_COUNT * PARTICLE_STRIDE_BYTES);
  const view = new DataView(bytes);
  for (let index = 0; index < PARTICLE_COUNT; index += 1) {
    const base = index * PARTICLE_STRIDE_BYTES;
    const angle = (index / PARTICLE_COUNT) * TAU;
    view.setFloat32(base, 6 + Math.cos(angle) * 0.6, true);
    view.setFloat32(base + 4, 6.5 + Math.sin(angle) * 0.6, true);
    view.setFloat32(base + 8, Math.cos(angle), true);
    view.setFloat32(base + 12, Math.sin(angle), true);
    view.setUint32(base + 16, 0xff40a0ff, true);
    view.setFloat32(base + 20, random() * 0.3, true);
    view.setFloat32(base + 24, 1, true);
    view.setFloat32(base + 28, index % 4 === 0 ? 2.6 : 1, true);
  }
  device.queue.writeBuffer(simulation.particlePool.buffers.particles, PARTICLE_HEADER_BYTES, bytes);
}

// One alive projectile of each kind in its own slot (slot 0 stays dead); the beam's previous
// direction is unset (no fan) and its lifetime 1 (full reach).
function createProjectiles(device) {
  const spawns = [
    { kind: PROJECTILE_KINDS.bullet, x: 2, y: 1.5, velocityX: 10, velocityY: 0, radius: 0.07, lifetime: 1 },
    { kind: PROJECTILE_KINDS.scatter, x: 4, y: 1.5, velocityX: 8, velocityY: 3, radius: 0.05, lifetime: 1, seed: 0.3 },
    { kind: PROJECTILE_KINDS.rail, x: 7, y: 1.5, velocityX: 30, velocityY: 0, radius: 0.05, lifetime: 0.3, seed: 0.5 },
    { kind: PROJECTILE_KINDS.pulseOrb, x: 9, y: 1.5, velocityX: 6, velocityY: 0, radius: 0.12, lifetime: 1, seed: 0.7 },
    { kind: PROJECTILE_KINDS.pulseRing, x: 11.5, y: 2, velocityX: 0, velocityY: 0, radius: 0.8, lifetime: 0.3, seed: 0.1 },
    { kind: PROJECTILE_KINDS.sidewinder, x: 14, y: 1.5, velocityX: 5, velocityY: 2, radius: 0.06, lifetime: 1, seed: 0.9 },
    { kind: PROJECTILE_KINDS.beam, x: 3, y: 6, velocityX: 1, velocityY: 0.2, radius: 0.06, lifetime: 1 },
  ];
  const capacity = spawns.length + 1;
  const bytes = new ArrayBuffer(capacity * PROJECTILE_STRIDE_BYTES);
  const view = new DataView(bytes);
  spawns.forEach((spawn, index) => packProjectile(view, (index + 1) * PROJECTILE_STRIDE_BYTES, spawn));
  const buffer = createStorageBuffer(device, bytes.byteLength, 'render-capture-projectiles');
  device.queue.writeBuffer(buffer, 0, bytes);
  return { buffer, capacity };
}

function toBase64(pixels) {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < pixels.length; offset += chunk) {
    binary += String.fromCharCode(...pixels.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function toPngDataUrl({ width, height, pixels }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height), 0, 0);
  return canvas.toDataURL('image/png');
}

async function run() {
  const canvas = document.getElementById('canvas');
  const gpu = await createGpuContext(canvas);
  const { device } = gpu;
  const viewport = new Viewport();
  viewport.setCanvasSize(CANVAS_WIDTH, CANVAS_HEIGHT, 1);
  const simulation = await Simulation.create(gpu, { capacity: CAPACITY, shares: normalizeShares([1, 1, 1, 1, 1]) });
  const random = seededRandom(12345);
  seedField(device, simulation, seedAgents(device, simulation, random));
  seedParticles(device, simulation, random);
  // The gate table a step would have recorded (Simulation.spawnGates); this page never steps.
  simulation.spawnGatesValue = { gates: [{ x: 13, y: 6.5, radius: 0.8, species: 2, open: 1, emit: 1, telegraph: 0 }], speciesBias: null };
  const renderer = await Renderer.create(gpu, { simulation, viewport });
  renderer.settings.trailDecay = 0;
  const scene = {
    projectiles: createProjectiles(device),
    pickups: [{ x: 13, y: 4, type: 'scatter', fade: 1 }],
    ship: { x: 3, y: 6, velocityX: 0, velocityY: 0, facing: 0.2, charge: 0.6, armed: 'pulse', invulnerable: false, railTurrets: 3 },
  };
  const qualities = [];
  for (const quality of Object.keys(BLOOM_DIVISORS)) {
    renderer.setBloomQuality(quality);
    const captured = renderer.captureNextFrame();
    const encoder = device.createCommandEncoder({ label: 'render-capture' });
    renderer.render(encoder, { alpha: 0, time: RENDER_TIME, sceneTime: RENDER_TIME, deltaSeconds: 1 / 60, scene, timeWarp: 0 });
    device.queue.submit([encoder.finish()]);
    renderer.afterSubmit();
    const frame = await captured;
    qualities.push({ quality, width: frame.width, height: frame.height, pixelsBase64: toBase64(frame.pixels), pngDataUrl: toPngDataUrl(frame) });
  }
  const { width, height } = qualities[0];
  return { pass: true, detail: `${qualities.length} qualities at ${width}x${height}`, width, height, qualities };
}

run().then((result) => { window.__renderCapture = result; }, (error) => {
  window.__renderCapture = { pass: false, detail: error.message, qualities: [] };
});
