# Plan A: Swarm Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser WebGPU page that simulates hundreds of thousands of flocking enemies of five species entirely on the GPU, renders them as distinct neon glyphs over a reactive warp grid with trails and bloom, follows a player point driven by mouse, gamepad or touch, and lets a click kill agents in a radius with splash particles. No weapons, score, audio or menus yet; those are Plans B and C.

**Architecture:** Plain JavaScript ES modules plus WGSL, no engine. Each frame: CPU writes a small uniform (player position, dt, spawn requests, debug kill), then GPU passes run in order: spawn, grid count, prefix scan, scatter, coarse-field downsample and blur, steering (fine 3x3 pass with capped neighbor sample plus coarse-field gradients), integrate with soft walls, debug kill, particle step, then render passes (warp grid, trails decay, glyphs, particles, bloom, composite). A stats buffer is read back through a three-deep staging ring. Capacity is fixed per `Simulation` instance; changing it builds a new instance and copies live agents over.

**Tech Stack:** WebGPU (WGSL), JavaScript ES modules, Vite (dev server and static build only), node:test for CPU logic, Playwright with Chromium for browser smoke, GitHub Pages via a workflow copied from the owner's PolyPhase repo.

**Spec:** `docs/superpowers/specs/2026-11-06-murmuration-design.md`

## Global Constraints

- Plain JavaScript ES modules and WGSL. No TypeScript. No runtime dependencies. Vite and Playwright are dev dependencies only.
- Shaders are loaded with `fetch(new URL('./shaders/<name>.wgsl', import.meta.url))` so the page also runs from any static server without Vite.
- Full-word identifiers (`maximum`, not `max`; `position`, not `pos`) in JavaScript. WGSL may use `vec2f` style built-in names but user identifiers follow the same rule.
- No em-dashes (U+2014) anywhere, including comments and docs.
- Every source file under about 500 lines, or carrying a one-line note at the top saying why.
- No hard-coded machine paths. No wall-clock assertions in tests; inject time.
- Mobile WebGPU limits are designed for: at most 8 storage buffers bound per shader stage; agent data interleaved in 16-byte aligned structs with no `vec3` in storage layouts; `@workgroup_size` at most 256; workgroup memory at most 16 KB; timestamp queries optional.
- Neighbor contributions are averaged, never summed. Per-agent fine-pass neighbor sampling is capped at `MAXIMUM_NEIGHBOR_SAMPLES = 32`.
- Arena is 16 by 9 world units, bounded, fully in view, letterboxed; renderer works in device pixels.
- Species count is 5. Coarse field is 64 by 36 cells with 8 float channels (5 species densities, 1 threat, 2 padding).
- Commit after every task with a message in the imperative; end commit messages with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

Inputs the spec implies but no task's tests fully exercise, most likely to bite first:

1. A browser without WebGPU (Firefox stable, older Safari) must show a plain message naming the requirement, not a blank canvas or a console exception. Pinned in Task 3.
2. Resizing the window or rotating the phone mid-run must re-letterbox without losing agents or leaving stale render targets. Pinned in Task 13.
3. Capacity change mid-run (the Plan C probe will do this) must preserve alive agents and not exceed `maxStorageBufferBindingSize`. Pinned in Task 9.
4. Thousands of agents converging into one grid cell must not stall the frame or lose the device; the neighbor cap must actually bound the loop. Pinned in Task 8.
5. The debug kill and the stats readback must agree with a one-frame delay and never block the loop. Pinned in Task 11.

---

## Phase 0: Scaffold

### Task 1: Repository scaffold and test runners

**Files:**
- Create: `package.json`, `vite.config.js`, `index.html`, `src/main.js`, `tests/sanity.test.js`, `README.md`, `AGENTS.md`

**Interfaces:**
- Produces: `npm run dev` serves on 127.0.0.1:5174; `npm test` runs `node --test tests/`; `npm run smoke` runs `node tests/browser/smoke.mjs` (Task 2); `npm run build` writes `dist/` with `--base` taken from `PAGES_BASE` env, default `/`.

- [ ] **Step 1: Write the failing test** in `tests/sanity.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('package declares ES modules and no runtime dependencies', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.dependencies ?? {}, {});
});
```

- [ ] **Step 2: Run `node --test tests/` and confirm it fails** (no package.json yet).
- [ ] **Step 3: Create `package.json`** (`"type": "module"`, scripts `dev`, `build`, `preview`, `test`, `smoke`; devDependencies `vite` and `playwright`), `vite.config.js` (reads `process.env.PAGES_BASE ?? '/'` into `base`, `server.port = 5174`, `server.strictPort = true`), `index.html` (a full-viewport `<canvas id="arena">`, a `<div id="message" hidden>`, dark background, `<script type="module" src="/src/main.js">`), `src/main.js` (logs `murmuration boot` and nothing else yet), `README.md` (one paragraph: what this is, how to run, how to test), `AGENTS.md` (the Global Constraints list above, verbatim, plus the three npm commands).
- [ ] **Step 4: Run `npm install`, `npm test`; expect PASS. Run `npm run dev` briefly and confirm the page serves.**
- [ ] **Step 5: Commit** `Scaffold project with Vite dev server and node test runner`.

### Task 2: Browser smoke harness

**Files:**
- Create: `tests/browser/smoke.mjs`, `tests/browser/launch.mjs`

**Interfaces:**
- Produces: `launchWebGpuBrowser() -> { browser, page }` in `launch.mjs`, launching Chromium with `--headless=new --enable-unsafe-webgpu --use-angle=d3d11 --ignore-gpu-blocklist` (the flags the spike verified on this Windows machine; `--disable-gpu-vsync --disable-frame-rate-limit` only when measuring), collecting console errors into `page.consoleErrors` (array of strings). `smoke.mjs` starts `vite preview` or uses `SMOKE_URL` if set, loads the page, waits for `window.__murmuration?.ready === true` (10 s timeout), asserts `consoleErrors` is empty, prints `smoke: ok` and exits 0, or prints the errors and exits 1.
- `src/main.js` sets `window.__murmuration = { ready: false, stats: null }` on boot and `ready = true` once the first frame has rendered (Task 3 wires this).

- [ ] **Step 1: Write `launch.mjs` and `smoke.mjs` as specified.** `smoke.mjs` also takes `--frames N` (default 120) and waits until `window.__murmuration.frame >= N` after ready.
- [ ] **Step 2: Run `npm run smoke` and confirm it FAILS** (ready never set; message says timed out waiting for ready).
- [ ] **Step 3: Set `window.__murmuration = { ready: true, frame: 0 }` in `src/main.js` temporarily** so the harness passes; Task 3 replaces this with the real flag.
- [ ] **Step 4: Run `npm run smoke`; expect `smoke: ok`.** If headless Chromium cannot get a WebGPU adapter on this machine, record the exact failure text in `README.md` under "Smoke test" and make `smoke.mjs` exit 2 with that explanation rather than silently passing.
- [ ] **Step 5: Commit** `Add Playwright smoke harness for WebGPU page`.

### Task 3: GPU context and unsupported-browser message

**Files:**
- Create: `src/gpu/device.js`, `tests/gpu/device.test.js`
- Modify: `src/main.js`

**Interfaces:**
- Produces: `export class WebGpuUnavailableError extends Error {}`; `export async function createGpuContext(canvas, { navigatorObject = navigator } = {}) -> { adapter, device, context, format, limits, hasTimestampQuery }`. Requests the device with `requiredLimits` asking for `maxStorageBufferBindingSize` and `maxBufferSize` equal to the adapter's supported values and `requiredFeatures: ['timestamp-query']` only if supported. Configures the canvas context with `alphaMode: 'opaque'`.
- Produces: `export function describeUnsupported(error) -> string` returning the user-facing copy: `This game needs WebGPU. Use Chrome or Edge on desktop or Android, or Safari on iOS 26 or later.`

- [ ] **Step 1: Write failing tests** in `tests/gpu/device.test.js`:

```js
test('createGpuContext rejects with WebGpuUnavailableError when navigator.gpu is missing', async () => {
  await assert.rejects(createGpuContext({}, { navigatorObject: {} }), WebGpuUnavailableError);
});
test('describeUnsupported names WebGPU and the supported browsers', () => {
  const text = describeUnsupported(new WebGpuUnavailableError('x'));
  assert.match(text, /WebGPU/); assert.match(text, /Safari on iOS 26/);
});
```

- [ ] **Step 2: Run `npm test`; expect FAIL (module not found).**
- [ ] **Step 3: Implement `src/gpu/device.js`.** In `src/main.js`: call `createGpuContext`; on `WebGpuUnavailableError` unhide `#message` with `describeUnsupported(error)` and stop; on success set `window.__murmuration.ready = true` after the first `requestAnimationFrame` and increment `window.__murmuration.frame` each frame.
- [ ] **Step 4: Run `npm test` and `npm run smoke`; expect PASS and `smoke: ok`.**
- [ ] **Step 5: Commit** `Add WebGPU context creation with unsupported-browser message`.

### Task 4: Pages deployment workflow

**Files:**
- Create: `.github/workflows/pages.yml`, `.github/workflows/pages-check.yml`, `.github/scripts/assemble-pages.sh`, `tests/pages_assembly_test.py`

**Interfaces:**
- Produces: production site at `/<repo>/` from `main`, previews at `/<repo>/pr-preview/pr-N/` for same-repo pull requests, removal on close. Mirrors `~/polyphase/.github/` with the repo name parameterized: the workflow derives the base path from `github.event.repository.name`, never a literal.

- [ ] **Step 1: Copy `assemble-pages.sh`, `pages.yml`, `pages-check.yml`, and `tests/pages_assembly_test.py` from `~/polyphase/.github/` and `~/polyphase/tests/`.** Replace every `polyphase` literal with a derived value (`${{ github.event.repository.name }}` in YAML, a `REPO_NAME` argument in the script, read from `GITHUB_REPOSITORY` in the test). Build step is `PAGES_BASE=/<repo>/ npm run build`.
- [ ] **Step 2: Run `python3 tests/pages_assembly_test.py`; expect PASS** (rsync is available in Git Bash; if not, the test must skip with a clear message, not fail).
- [ ] **Step 3: Grep the four files for the string `polyphase`; expect zero hits.**
- [ ] **Step 4: Commit** `Add GitHub Pages deployment with pull request previews`.

## Phase 1: GPU Simulation

### Task 5: Layout constants and species table

**Files:**
- Create: `src/sim/layout.js`, `src/sim/species.js`, `tests/sim/layout.test.js`, `tests/sim/species.test.js`

**Interfaces:**
- Produces in `layout.js`: `ARENA_WIDTH = 16`, `ARENA_HEIGHT = 9`, `SPECIES_COUNT = 5`, `AGENT_STRIDE_BYTES = 32`, `COARSE_COLUMNS = 64`, `COARSE_ROWS = 36`, `COARSE_CHANNELS = 8`, `MAXIMUM_NEIGHBOR_SAMPLES = 32`, `WORKGROUP_SIZE = 256`; `gridDimensions(neighborRadius) -> { columns, rows, cellSize, cellCount }` where `cellSize = neighborRadius` and `columns = Math.ceil(ARENA_WIDTH / cellSize)`; `agentBufferBytes(capacity) -> number`.
- Agent struct (32 bytes): `position: vec2f` (0), `velocity: vec2f` (8), `species: u32` (16), `flags: u32` (20; bit 0 alive, bits 8..15 spawn-in frames remaining), `phase: f32` (24), `hueJitter: f32` (28).
- Produces in `species.js`: `SPECIES_FIELDS = ['seek','cohesion','alignment','separation','maximumSpeed','maximumTurn','orbitRadius','flee','pressure','targetDensity','reserved0','reserved1']` (12 floats, three `vec4f` per row; the two reserved slots stay 0); `SPECIES_NAMES = ['Chaser','Orbiter','Skittish','Lattice','Predator']`; `defaultSpecies() -> Array<{name, hue, glyph, ...fields}>`; `defaultMatrix() -> Float32Array(25)` row-major, signed, with Predator rows attracted to Chaser and Skittish (+0.8) and repelled by Lattice (-0.6), all else 0; `packSpeciesTable(rows, matrix) -> Float32Array` laying out 5 rows of 12 floats then the matrix padded to 32 floats (92 floats total); `normalizeShares(shares) -> Float32Array` summing to 1 (all-zero input becomes equal shares).

- [ ] **Step 1: Write failing tests:**

```js
test('agent stride is 32 bytes and buffer bytes scale linearly', () => {
  assert.equal(AGENT_STRIDE_BYTES, 32); assert.equal(agentBufferBytes(1024), 32768);
});
test('gridDimensions covers the arena', () => {
  const g = gridDimensions(0.1); assert.equal(g.columns, 160); assert.equal(g.rows, 90); assert.equal(g.cellCount, 14400);
});
test('packSpeciesTable is 92 floats with the matrix after the rows', () => {
  const table = packSpeciesTable(defaultSpecies(), defaultMatrix());
  assert.equal(table.length, 92); assert.equal(table[60 + 4 * 5 + 0], 0.8); // Predator row, Chaser column
});
test('normalizeShares sums to one and handles all zeros', () => {
  const shares = normalizeShares([2, 2, 0, 0, 0]); assert.equal(shares[0], 0.5);
  assert.equal(normalizeShares([0,0,0,0,0])[3], 0.2);
});
```

- [ ] **Step 2: Run `npm test`; expect FAIL.**
- [ ] **Step 3: Implement both modules.** Default rows follow the spec's five descriptions; numbers are yours to pick and the lab will retune them.
- [ ] **Step 4: Run `npm test`; expect PASS.**
- [ ] **Step 5: Commit** `Add agent layout constants and species table packing`.

### Task 6: Shader loading and agent buffers

**Files:**
- Create: `src/gpu/shaders.js`, `src/gpu/buffers.js`, `src/sim/shaders/common.wgsl`, `tests/gpu/shaders.test.js`

**Interfaces:**
- Produces: `loadShader(name, { fetchFunction = fetch } = {}) -> Promise<string>` reading `src/sim/shaders/<name>.wgsl` relative to `import.meta.url`; `substituteConstants(source, constants) -> string` replacing each `__NAME__` token with its value and throwing if any `__[A-Z_]+__` token remains; `prependCommon(source, common) -> string`.
- Produces in `buffers.js`: `createStorageBuffer(device, bytes, label, { copySource = true } = {})`, `createUniformBuffer(device, bytes, label)`, `class StagingRing { constructor(device, bytes, depth = 3); copyFrom(encoder, sourceBuffer); async tryRead() -> ArrayBuffer | null }` where `tryRead` maps the oldest unmapped slot if its copy has been submitted and returns null when nothing is ready, never awaiting inside the frame.
- `common.wgsl` defines `struct Agent { position: vec2f, velocity: vec2f, species: u32, flags: u32, phase: f32, hueJitter: f32 }`, `struct SimParams` (dt, time, playerPosition, neighborRadius, gridColumns, gridRows, cellSize, capacity, aliveTarget, spawnPerSpecies: array<u32,5> packed into vec4u pairs, debugKillPosition, debugKillRadius, frameSequence), constants injected via `__WORKGROUP_SIZE__`, `__SPECIES_COUNT__`, `__MAXIMUM_NEIGHBOR_SAMPLES__`, `__COARSE_COLUMNS__`, `__COARSE_ROWS__`, `__COARSE_CHANNELS__`, and helpers `isAlive(flags)`, `spawnFramesRemaining(flags)`, `cellIndexFor(position, params)`.

- [ ] **Step 1: Write failing tests** for `substituteConstants` (replaces tokens; throws on a leftover `__UNKNOWN__`) and `loadShader` (uses an injected `fetchFunction` and returns its text).
- [ ] **Step 2: Run `npm test`; expect FAIL.**
- [ ] **Step 3: Implement the modules and `common.wgsl`.**
- [ ] **Step 4: Run `npm test`; expect PASS.**
- [ ] **Step 5: Commit** `Add shader loading with constant substitution and GPU buffer helpers`.

### Task 7: Spatial grid: count, scan, scatter

**Files:**
- Create: `src/sim/grid.js`, `src/sim/shaders/grid_count.wgsl`, `src/sim/shaders/grid_scan.wgsl`, `src/sim/shaders/grid_scatter.wgsl`, `tests/browser/grid.mjs`

**Interfaces:**
- Produces: `class SpatialGrid { constructor(gpu, { columns, rows, capacity, common }); async initialize(); encode(encoder, agentsBuffer, paramsBuffer); buffers: { cellCounts, cellOffsets, sortedIndices, cellCursor } }`. After `encode`, `sortedIndices[cellOffsets[c] .. cellOffsets[c] + cellCounts[c])` holds the indices of alive agents in cell `c`. Dead agents are skipped.
- Scan is a two-level workgroup prefix sum (256-wide blocks, then a block-sum pass, then an add-back pass) over `cellCount` entries, so no single workgroup exceeds 256 threads or 16 KB of workgroup memory.

- [ ] **Step 1: Write the browser check `tests/browser/grid.mjs`** (run with `node tests/browser/grid.mjs`): loads a test page `tests/browser/pages/grid.html` that seeds 4096 agents at known positions (all alive, 64 per cell in 64 cells), runs one `encode`, reads back `cellCounts` and `sortedIndices`, and posts `window.__gridCheck = { pass, detail }`. Asserts every seeded cell has count 64 and every index appears exactly once.
- [ ] **Step 2: Run it; expect FAIL (page or module missing).**
- [ ] **Step 3: Implement the three shaders and `grid.js`.** `grid_count` clears happen via `encoder.clearBuffer` on `cellCounts` and `cellCursor` before dispatch; count uses `atomicAdd` per alive agent; scatter uses `atomicAdd` on `cellCursor` to claim a slot at `cellOffsets[c]`.
- [ ] **Step 4: Run `node tests/browser/grid.mjs`; expect pass. Also run `npm run smoke`; expect ok.**
- [ ] **Step 5: Commit** `Add GPU spatial grid with counting sort`.

### Task 8: Coarse field and steering

**Files:**
- Create: `src/sim/field.js`, `src/sim/steer.js`, `src/sim/shaders/field_downsample.wgsl`, `src/sim/shaders/field_blur.wgsl`, `src/sim/shaders/steer.wgsl`, `src/sim/shaders/integrate.wgsl`, `tests/browser/steer.mjs`

**Interfaces:**
- Produces: `class CoarseField { constructor(gpu, { grid, common }); encode(encoder, agentsBuffer, gridBuffers, paramsBuffer); buffers: { raw, blurred, threatAccumulator } }` where `raw` and `blurred` are `COARSE_COLUMNS * COARSE_ROWS * COARSE_CHANNELS` floats; channel `s < 5` is species density, channel 5 is threat, channels 6 and 7 are padding. WGSL has no floating-point atomics, so threat is accumulated by writers (the debug kill in Task 10, weapons in Plan B) with `atomicAdd` into `threatAccumulator: array<atomic<u32>>` of `COARSE_COLUMNS * COARSE_ROWS` entries in fixed point (1 unit = 1/256). `field_downsample` reads each accumulator entry, converts to float, writes `channel 5 = previousThreat * 0.85 + accumulated`, and zeroes the entry. `common.wgsl` exposes `THREAT_FIXED_POINT_SCALE = 256.0` and `coarseCellIndexFor(position)`.
- Produces: `class Steering { constructor(gpu, { common }); encode(encoder, agentsIn, agentsOut, gridBuffers, fieldBuffer, speciesTableBuffer, paramsBuffer) }` running `steer` then `integrate`.
- `steer.wgsl` per alive agent: iterate the 3x3 cells; take at most `__MAXIMUM_NEIGHBOR_SAMPLES__` neighbors total with a stride of `ceil(totalInCells / MAXIMUM)` so the sample spans the neighborhood; average separation over all sampled neighbors and alignment over same-species sampled neighbors; read the coarse field at the agent's position and the four axis neighbors to form gradients; cohesion steers up its own species' gradient but saturates: its weight is multiplied by `clamp(1 - density / targetDensity, 0, 1)` so it fades to nothing as the local crowd reaches the comfortable density (the spike showed unsaturated field cohesion acting as self-gravity and collapsing every species into balls one blur kernel wide), the matrix row steers along the signed sum of other species' gradients, flee steers down the threat gradient; seek toward `playerPosition`, or toward the tangent of a circle of `orbitRadius` when `orbitRadius > 0`; pressure: when the total density at the agent's coarse cell exceeds `targetDensity`, steer down the total-density gradient with weight `pressure * (density - targetDensity)`, so a swarm has a comfortable density and does not collapse into a ball under seek (the spike showed pure seek collapsing like gravity, and damping seek instead froze everything); clamp acceleration to `maximumTurn * maximumSpeed` and speed to `maximumSpeed`. Agents in spawn-in frames do not steer.
- `field_downsample.wgsl` must not loop one thread over a cell's agents: a dense ball made one thread walk tens of thousands of agents in the spike (8 ms). Run one thread per agent, accumulate into a workgroup-shared histogram keyed by coarse cell (sorted agents in a workgroup mostly share one coarse cell), and flush with a handful of atomic adds per workgroup into a fixed-point `array<atomic<u32>>` (reuse the `THREAT_FIXED_POINT_SCALE` convention for density), then a tiny pass converts to float and applies the blur.
- `integrate.wgsl`: `position += velocity * dt`; soft walls: inside a margin of 0.5 world units from any edge add a push toward the arena center proportional to penetration; decrement spawn-in frames; advance `phase`.
- Total storage buffers bound in `steer`: agentsIn, agentsOut, cellCounts, cellOffsets, sortedIndices, field, speciesTable (7), plus the uniform.

- [ ] **Step 1: Write `tests/browser/steer.mjs`** against `tests/browser/pages/steer.html`: (a) 20000 Chasers seeded uniformly, player at center, 120 steps: assert the mean distance to the player decreased by at least 30 percent and no position lies outside the arena; (b) all 20000 agents seeded into one cell, 10 steps: assert each step's `queue.onSubmittedWorkDone` resolves within 250 ms of wall time measured only as an upper bound guard (this is a performance ceiling, not a timing assertion on game logic); (c) Lattice species seeded in a square: after 120 steps the mean nearest-neighbor distance is within 25 percent of the separation target; (d) 65536 Chasers with `pressure > 0` and a small `targetDensity`, player at center, 600 steps: the agents' bounding radius around the player stays above 1.5 world units (no collapse into a single ball), while with `pressure = 0` it drops below 0.8.
- [ ] **Step 2: Run it; expect FAIL.**
- [ ] **Step 3: Implement the shaders and modules.**
- [ ] **Step 4: Run `node tests/browser/steer.mjs`; expect pass.**
- [ ] **Step 5: Commit** `Add coarse species field and capped-neighbor steering`.

### Task 9: Spawning and the Simulation facade

**Files:**
- Create: `src/sim/spawner.js`, `src/sim/spawn.js`, `src/sim/shaders/spawn.wgsl`, `src/sim/simulation.js`, `tests/sim/spawner.test.js`, `tests/browser/simulation.mjs`

**Interfaces:**
- Produces in `spawner.js` (pure CPU): `class SpawnPressure { constructor({ capacity, rampSeconds = 90, floorFraction = 0.05, ceilingFraction = 0.9 }); update(deltaSeconds, aliveCount, shares) -> Uint32Array(5) }` returning how many agents of each species to spawn this frame so that alive count approaches `targetAlive(elapsed) = capacity * lerp(floorFraction, ceilingFraction, clamp(elapsed / rampSeconds))`, split by `shares`, capped at `capacity / 60` per frame. `reset()` sets elapsed to 0. `get targetAlive`.
- Produces in `spawn.js`: `class Spawner { constructor(gpu, { common }); encode(encoder, agentsBuffer, paramsBuffer, randomBuffer) }`. `spawn.wgsl`: one thread per agent slot; a dead slot claims one unit from the per-species budget in a small atomic buffer (`spawnBudget`, 5 atomics, written from `spawnPerSpecies` each frame by a tiny prologue pass or by `queue.writeBuffer`) and becomes alive at a random position at least `ARENA_WIDTH / 4` from the player (reject and retry up to 4 times using a hash of slot and frameSequence), with 30 spawn-in frames, species set, phase and hueJitter randomized.
- Produces in `simulation.js`: `class Simulation { static async create(gpu, { capacity, neighborRadius = 0.1, species = defaultSpecies(), matrix = defaultMatrix(), shares = normalizeShares([...]) }) ; get capacity; setPlayer(x, y); setDebugKill(x, y, radius) ; setSpecies(rows, matrix) ; setShares(shares) ; step(encoder, deltaSeconds) ; get agentsBuffer (the current output) ; get fieldBuffer ; get statsBuffer ; async readStats() -> { aliveTotal, alivePerSpecies: Uint32Array(5), killsThisFrame, frameSequence } | null ; async recreateWithCapacity(newCapacity) -> Simulation }` which copies the first `min(old, new)` agent slots with `copyBufferToBuffer` and destroys the old buffers. `step` increments `frameSequence`, writes params, and encodes: spawn, grid, field, steer+integrate, debug kill (Task 10 adds), stats, staging ring copy.
- Stats buffer: `[aliveTotal, alive0..alive4, kills, frameSequence]` as u32, accumulated with workgroup reduction then one atomic per workgroup.

- [ ] **Step 1: Write failing tests** in `tests/sim/spawner.test.js`: target alive at elapsed 0 equals `capacity * 0.05`; at 90 s equals `capacity * 0.9`; a frame's total spawn never exceeds `capacity / 60`; shares `[1,0,0,0,0]` spawn only species 0; `reset()` returns elapsed to 0.
- [ ] **Step 2: Run `npm test`; expect FAIL.**
- [ ] **Step 3: Implement `spawner.js`; run `npm test`; expect PASS.**
- [ ] **Step 4: Write `tests/browser/simulation.mjs`** against `tests/browser/pages/simulation.html`: create at capacity 65536 with equal shares, step 300 frames at dt 1/60 with `SpawnPressure`; assert `readStats()` eventually reports `aliveTotal` between 0.6 and 0.95 of target, each species alive within 10 percent of its share, and `frameSequence` lags the CPU frame count by at most 3. Then `recreateWithCapacity(131072)` and assert `aliveTotal` after one step is at least 95 percent of the previous value.
- [ ] **Step 5: Implement `spawn.js`, `spawn.wgsl`, `simulation.js`. Run the browser check; expect pass.**
- [ ] **Step 6: Commit** `Add GPU spawning, spawn pressure, and the Simulation facade`.

### Task 10: Debug kill and particle pool

**Files:**
- Create: `src/sim/particles.js`, `src/sim/shaders/kill_debug.wgsl`, `src/sim/shaders/particles_step.wgsl`
- Modify: `src/sim/simulation.js`

**Interfaces:**
- Produces: `class ParticlePool { constructor(gpu, { capacity, common }); buffers: { particles, cursor }; encodeStep(encoder, paramsBuffer) }`. Particle struct 32 bytes: `position: vec2f, velocity: vec2f, color: u32 (packed rgba8), age: f32, lifetime: f32, padding: f32`. Spawning is done by whichever pass kills an agent: it claims `n` slots with one `atomicAdd` on `cursor` (wrapping modulo capacity) and writes particles radiating from the agent's position with the agent's species hue. `kill_debug.wgsl`: for alive agents within `debugKillRadius` of `debugKillPosition`, clear the alive bit with `atomicAnd` on the agent's `flags` (bound as `atomic<u32>` in this pass) and count the kill only if the old value had the alive bit, so concurrent killers never double count; add 1 to the kills stat (workgroup-reduced), write 6 particles, and `atomicAdd` 256 (one threat unit) into `threatAccumulator` at the agent's coarse cell.
- `Simulation.setDebugKill(x, y, radius)` arms a one-frame kill; `radius = 0` disarms. `Simulation.particlePool` is exposed for the renderer.

- [ ] **Step 1: Extend `tests/browser/simulation.mjs`:** after agents are alive, arm a debug kill of radius 2 at the player (center) and step once; assert `killsThisFrame > 0` within 3 frames and `aliveTotal` dropped by at least that many.
- [ ] **Step 2: Run it; expect FAIL.**
- [ ] **Step 3: Implement. Run the browser check; expect pass.**
- [ ] **Step 4: Commit** `Add debug kill pass and GPU particle pool`.

## Phase 2: Rendering and the demo slice

### Task 11: Frame loop, input, and stats readback wiring

**Files:**
- Create: `src/game/loop.js`, `src/input/pointer.js`, `src/input/gamepad.js`, `src/input/touch.js`, `src/input/input.js`, `tests/game/loop.test.js`, `tests/input/input.test.js`
- Modify: `src/main.js`

**Interfaces:**
- Produces: `class FrameLoop { constructor({ update, render, now = performance.now.bind(performance), requestFrame = requestAnimationFrame, fixedStep = 1 / 60, maximumSubsteps = 4 }); start(); stop(); frameCount }` with an accumulator calling `update(fixedStep)` zero or more times then `render(alpha)`.
- Produces: `class InputState { move: {x, y}, aim: {x, y}, firing: boolean, bomb: boolean, pointerWorld: {x, y} | null }`; `createInput(canvas, viewport) -> { state, update(), dispose() }` merging pointer (mouse position to world via `viewport.screenToWorld`), gamepad (left stick move, right stick aim with 0.2 dead zone, firing when right stick magnitude > 0.5), and touch (left half of the screen moves, right half aims, floating origin at first contact, firing while right thumb is down). `viewport` comes from Task 13: `{ screenToWorld(px, py) -> {x, y} }`.
- `src/main.js` creates `Simulation` at capacity 262144 (desktop default for this plan), runs the loop, moves the player point with `move` at 6 world units per second clamped to the arena, arms a debug kill of radius 0.6 at `pointerWorld` while the left mouse button is held, reads stats each frame and publishes `window.__murmuration.stats`.

- [ ] **Step 1: Write failing tests:** `FrameLoop` with injected `now` and a manual `requestFrame` runs `update` 3 times for a 50 ms gap at a 1/60 step and clamps to `maximumSubsteps` for a 1 s gap; `createInput` touch mapping: a touch starting at 20 percent of width then moving 40 px right yields `move.x > 0`, a touch on the right half sets `firing = true` and an aim vector, releasing clears both; gamepad dead zone zeroes a 0.1 stick.
- [ ] **Step 2: Run `npm test`; expect FAIL.**
- [ ] **Step 3: Implement. Wire `main.js`.**
- [ ] **Step 4: Run `npm test`, `npm run smoke -- --frames 300`; expect PASS and `smoke: ok`, and the smoke script additionally asserts `window.__murmuration.stats.aliveTotal > 1000` at the end.**
- [ ] **Step 5: Commit** `Add fixed-step frame loop, unified input, and stats publishing`.

### Task 12: Glyph rendering with trails and bloom

**Files:**
- Create: `src/render/renderer.js`, `src/render/glyphs.js`, `src/render/trails.js`, `src/render/bloom.js`, `src/render/composite.js`, `src/render/shaders/glyphs.wgsl`, `src/render/shaders/trails_decay.wgsl`, `src/render/shaders/bloom_downsample.wgsl`, `src/render/shaders/bloom_blur.wgsl`, `src/render/shaders/composite.wgsl`, `src/render/shaders/fullscreen.wgsl`

**Interfaces:**
- Produces: `class Renderer { static async create(gpu, { simulation, viewport }); resize(widthDevicePixels, heightDevicePixels); render(encoder, { alpha, time }) ; settings: { glyphDevicePixels = 4, glowScale = 2, trailDecay = 0.90, bloomStrength = 0.8 } }`.
- Scene target `rgba16float` at device resolution, two of them for trail ping-pong. Frame: `trails_decay` copies previous scene times `trailDecay` into the current scene; `glyphs` draws one instance per agent slot (vertex pulling from the agent storage buffer; dead agents emit a degenerate quad) as a quad of `glyphDevicePixels * glowScale` size, fragment shader evaluating a signed distance for the species glyph (0 triangle, 1 diamond, 2 cross, 3 chevron, 4 pentagon outline) with a soft glow falloff, additive blend, color from species hue plus `hueJitter`, pulsing with `phase`, and alpha attenuated by `1 / (1 + 0.02 * localDensity)` where `localDensity` is read from the coarse field; spawn-in agents render at half alpha with a stronger pulse. `bloom` downsamples to half resolution, blurs separably, and `composite` adds bloom times `bloomStrength` to the scene, applies a tonemap (Reinhard or ACES-fitted; the spike showed additive blending at four million agents saturating the center to pure white, so the tonemap is load-bearing, not polish), and writes the swapchain, letterboxing the 16:9 arena with black bands. The smoke luminance ceiling in Step 1 is the check for this.
- `viewport` (Task 13) provides `arenaRectDevicePixels`.

- [ ] **Step 1: Extend `tests/browser/smoke.mjs`** to screenshot the canvas after 300 frames to `artifacts/smoke.png` (gitignored) and assert the mean luminance of the arena region is above 0.02 and below 0.6 (something is drawn, and it is not a white smear).
- [ ] **Step 2: Run smoke; expect FAIL on luminance (nothing drawn yet).**
- [ ] **Step 3: Implement the renderer and wire it in `main.js`.**
- [ ] **Step 4: Run `npm run smoke -- --frames 300`; expect ok. Open the page in Chrome and look: five glyph shapes should be distinguishable at 1x zoom when you hold the right mouse button (temporary 4x zoom for inspection, implemented in `viewport`).**
- [ ] **Step 5: Commit** `Render agents as neon glyphs with trails and bloom`.

### Task 13: Viewport, letterboxing, and resize

**Files:**
- Create: `src/render/viewport.js`, `tests/render/viewport.test.js`
- Modify: `src/main.js`, `src/render/renderer.js`

**Interfaces:**
- Produces: `class Viewport { constructor({ arenaWidth = ARENA_WIDTH, arenaHeight = ARENA_HEIGHT }); setCanvasSize(widthDevicePixels, heightDevicePixels); arenaRectDevicePixels -> { x, y, width, height }; screenToWorld(px, py, devicePixelRatio) -> { x, y }; worldToClip(x, y) -> { x, y }; inspectZoom: number }`.
- `main.js` observes `ResizeObserver` on the canvas with `device-pixel-content-box` where supported, sets `canvas.width/height` in device pixels, calls `viewport.setCanvasSize` and `renderer.resize`.

- [ ] **Step 1: Write failing tests:** a 2000 by 1000 canvas letterboxes the 16:9 arena to width 1777 (rounded) centered; a 1000 by 1000 canvas letterboxes to height 562; `screenToWorld` of the arena rect center is `(8, 4.5)`; a point in the band returns coordinates outside `[0, 16]`.
- [ ] **Step 2: Run `npm test`; expect FAIL.**
- [ ] **Step 3: Implement, wire resize. Renderer recreates its render targets on `resize` and the trail history is cleared.**
- [ ] **Step 4: Run `npm test`; extend `smoke.mjs` to resize the viewport from 1280 by 720 to 800 by 1200 after 60 frames and assert no console errors and `aliveTotal` unchanged within 5 percent across the resize. Run smoke; expect ok.**
- [ ] **Step 5: Commit** `Add viewport letterboxing and resize handling`.

### Task 14: Warp grid and particles rendering

**Files:**
- Create: `src/render/warpgrid.js`, `src/render/particles.js`, `src/render/shaders/warpgrid.wgsl`, `src/render/shaders/particles.wgsl`
- Modify: `src/render/renderer.js`

**Interfaces:**
- Produces: `class WarpGrid { constructor(gpu, { columns = 96, rows = 54, viewport }); encode(pass, fieldBuffer, time) }` drawing a line list; each vertex is displaced in the vertex shader by the gradient of `density * densityWeight + threat * threatWeight` sampled from the blurred coarse field, so masses dent the grid and the debug kill punches it. Line color is a dim neon blue brightened by local displacement magnitude. Drawn first, before trails decay is applied, so it does not smear.
- Produces: `class ParticleRenderer { constructor(gpu, { pool, viewport }); encode(pass) }` drawing points as small additive quads fading with `age / lifetime`.
- Settings on `Renderer`: `warpDensityWeight = 0.15`, `warpThreatWeight = 0.6`.

- [ ] **Step 1: Extend `smoke.mjs`:** hold a synthetic mouse-down at the arena center for 30 frames, then screenshot; assert mean luminance within a 60 by 60 device-pixel box around the center is higher than the frame before the click began (particles and grid flash) and that no console errors occurred.
- [ ] **Step 2: Run smoke; expect FAIL.**
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run smoke; expect ok. Look at it in Chrome: the grid should visibly dent under the densest mass and ripple when you click.**
- [ ] **Step 5: Commit** `Render reactive warp grid and kill particles`.

### Task 15: Demo controls panel and documentation

**Files:**
- Create: `src/ui/debugPanel.js`
- Modify: `src/main.js`, `README.md`, `AGENTS.md`

**Interfaces:**
- Produces: `createDebugPanel({ simulation, renderer, spawnPressure, onCapacityChange }) -> { element, dispose() }`: a collapsible panel (toggle with the backquote key or a corner button) with capacity select (65536, 262144, 1048576, 4194304) calling `onCapacityChange` which runs `recreateWithCapacity`, five share sliders, per-species sliders for the eight fields, the 5 by 5 matrix as number inputs, a `samespecies cohesion` toggle (passes a flag in `SimParams`), renderer sliders (trail decay, bloom strength, warp weights), and a live readout of frames per second and alive counts from `window.__murmuration.stats`. This panel is the seed of Plan C's lab mode and is kept.

- [ ] **Step 1: Implement the panel and wire it.** Manual verification: change capacity to 1048576 on the 4090 and confirm frames per second stays above 60 with alive agents above 900000 after the ramp; record the number in `README.md` under "Measured".
- [ ] **Step 2: Run `npm test` and `npm run smoke`; expect PASS and ok.**
- [ ] **Step 3: Update docs affected by this plan:** run the docs-update check across `README.md`, `AGENTS.md`, and inline comments; `README.md` describes the demo slice controls (move with WASD, left stick or left-half touch; hold left mouse or right-half touch to kill at the pointer; backquote for the panel), the three npm commands, and the smoke test caveats; `AGENTS.md` lists the pass order and the file map.
- [ ] **Step 4: Commit** `Add debug panel and document the swarm core demo`.

---

## Self-review notes

- Spec coverage for this plan's scope: species rows with same-species cohesion and alignment (Task 8), two ranges of influence via the coarse field (Task 8), averaged contributions and capped neighbors (Task 8), kinematic bounds in the species row (Task 5), soft walls and bounded arena (Task 8), spawn geography and spawn-in (Task 9), GPU free-slot spawning with no CPU per-agent allocation (Task 9), live capacity change (Task 9), stats readback through a ring with sequence numbers (Tasks 6 and 9), glyph distinctness, density-attenuated alpha, trails and half-resolution bloom (Task 12), letterbox bands (Task 13), warp grid driven by density and threat (Task 14), touch and gamepad and mouse input shape (Task 11), unsupported-browser copy (Task 3), Pages previews (Task 4). Weapons, score, lives, bombs, pickups, audio, probe, presets, menus, lab mode, first-run entry and landscape lock belong to Plans B and C.
- Names reused across tasks: `Simulation`, `SpatialGrid`, `CoarseField`, `Steering`, `Spawner`, `SpawnPressure`, `ParticlePool`, `StagingRing`, `Viewport`, `Renderer`, `FrameLoop`, `InputState`, `createInput`, `createDebugPanel`, `window.__murmuration.{ready, frame, stats}`.
