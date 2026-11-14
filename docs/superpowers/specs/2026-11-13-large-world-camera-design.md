# Larger world and dynamic camera: design exploration

Date: 2026-11-13. Status: design only, no code changed. Read from `main` at 6999058.
Everything marked UNVERIFIED was not confirmed in the code or by running it.

## 1. Problem and goals

Owner request: extend the board so the simulation is larger than one screen, with a dynamic camera that
frames the player's swarm among the larger swarm, punches in when many enemies are near, and zooms out (to a
limit) when the action is elsewhere.

Goals:
- A world larger than the view, with a camera that follows, zooms and never breaks aim or legibility.
- Every step ships and leaves the game playable. No runtime dependencies, plain JS and WGSL, mobile limits
  kept (at most 8 storage buffers per stage, workgroup size at most 256).
- The sim never reads the camera. Then one camera, two cameras (split screen) or a shared camera all work
  later, which is what multiplayer needs.
- Gameplay does not depend on the capacity preset (AGENTS.md: presets change counts and budgets only).

Non-goals: multiplayer design, new enemy types, art changes.

Two findings shape everything below:
1. Today `arenaBounds` is three things at once: the visible region, the playable region (walls, spawn band,
   player clamp, pickups) and the camera. The camera work is mostly splitting those apart.
2. Enemy seek has no range limit and targets a single point (`steer.wgsl:101`, `params.playerPosition`).
   In a bigger world every enemy still converges on the player. Without a seek range, "action elsewhere" does
   not exist: a bigger world is just a longer commute. This is a gameplay decision (section 7, step 3).

## 2. Current coupling to the one-screen world

The world is 16 by 9 units. `layout.js` is the CPU source of truth; `common.wgsl` repeats the numbers as
literals (not token-substituted), so a world change must edit both or move them into `SHADER_CONSTANTS`.

| Area | Where | What is tied to 16 by 9 |
|---|---|---|
| World constants | `src/sim/layout.js:4-5` | `ARENA_WIDTH`, `ARENA_HEIGHT` |
| Same, in WGSL | `src/sim/shaders/common.wgsl:14-15`, `:137`, `:157-173` | literal `16.0`, `9.0`; `clampToArena`, `cellIndexFor`, `coarseCellIndexFor` |
| Coarse field size | `layout.js:7-8`, `field.js:11-17`, `field_downsample.wgsl`, `field_blur.wgsl:14-29`, `density_sum.wgsl:7` | 64 by 36 cells, so a cell is 0.25 by 0.25 units. `targetDensity` is agents per cell, so the cell size defines the swarm's feel and must not change. |
| Fine grid | `layout.js:49-55` (`gridDimensions`), `grid.js:11-12,24-28`, `grid_scan.wgsl:1-3` | cells = ceil(16/r) by ceil(9/r). `MAXIMUM_GRID_CELLS` = 65,536 (256 blocks of 256, block sums scanned by ONE workgroup); the constructor throws above it. |
| Density readback | `density-readback.js:12,81-89` | `CELL_COUNT`, `densityAt` maps world to the 64 by 36 map with `ARENA_*` |
| Steering | `steer.wgsl:70-71,101`, `fineNeighborAverages` | coarse sample clamped to the field; seek toward one `playerPosition`, no range |
| Walls | `integrate.wgsl:25-27`, `params.js:71-72,163` | soft walls at `arenaBounds`; `validatedArenaBounds` requires bounds inside `[0,16]` by `[0,9]` |
| Spawn (GPU) | `spawn.wgsl:80-160`, `params.js:62` | band, far corner and gate points use `arenaBounds`; `spawnBandWidth` must be at most `ARENA_HEIGHT/2`; minimum distance is `boundsSize.x * spawnDistanceFraction` |
| Spawn (CPU) | `spawner.js` (header, `setAreaFraction`), `spawn-director.js:23-60,254`, `game.js:293,296-306,527-528` | alive target scales with the arena area fraction; gate placement, drift and `safeDistance` use `arenaBounds.width`; 3 gates, `MAXIMUM_SPAWN_GATES` = 4 (a 4-slot uniform) |
| Projectiles | `projectiles_step.wgsl:43-45`, `projectiles_collide.wgsl:386,484`, `projectiles.wgsl:88,226-235,360`, `render/projectiles.js:35` | `isInsideArena` kills projectiles outside; beam length and the fade use the same rectangle |
| Kill-all | `kill_all.wgsl` (`KillArea`) | bomb and death clear kill everything alive; a radial mode already exists (pickup blast) |
| Pickups | `pickups.js:74-125` | annulus around the player, lowest `densityAt` of 8 in-bounds candidates |
| Player | `player.js:31` (speed 6), `player-swarm.js:52`, `game.js:149-157` | clamped to `arenaBounds`; the swarm centroid exists (`player-swarm.js:97`) |
| Simulation init | `simulation.js:110,132,281-285` | grid from `gridDimensions`; `playerPosition` starts at the 16 by 9 center |
| Viewport | `render/viewport.js` (all) | `arenaBoundsForAspect` picks a sub-rectangle of the world per canvas aspect and maps it to the canvas; `inspectZoom` is a centered affine scale (lab only). `worldToClip`/`screenToWorld` are already an exact affine pair, which is the seam for a camera. |
| Input | `input/pointer.js:17-45`, `game.js:495-515` | pointer stores CSS position and converts with `screenToWorld` every update, so a changing transform is already handled; mouse aim is `pointerWorld - ship` |
| Glyph size | `glyphs.js:30-43` | ship length = 0.018 of the 9-unit world height (the same world size at every aspect), floor 8 device px, times `zoom^0.5`; coverage scale uses `COARSE_*` and the world rect |
| Particles | `render/particles.js:26-32` | already uses `worldToClip` and `effectiveZoom` |
| Warp grid | `warpgrid.js` (96 by 54 lines), `warpgrid.wgsl:79,137-152` | lattice spans `ARENA_*`, field sample uses `ARENA_*`, border lines pinned to the world edge |
| Trails | `trails.js`, `trails_decay.wgsl` | `textureLoad` of the previous scene at the same pixel (screen space, 1:1) |
| Composite/capture | `renderer.js:180-185` | `arenaRect` (letterbox only beyond aspects 1:4 and 4:1) |
| Presets | `settings/presets.js:6-9` | `neighborRadius` 0.12, 0.1, 0.1, 0.08 |

Not found in the code: any use of the arena by audio or HUD logic (UNVERIFIED beyond a grep of
`ARENA_*`/`arenaBounds`; `main.js:72` reads `arenaRectDevicePixels` for something not inspected). The fixed
step length is in `src/game/loop.js`, not read.

## 3. Options: world size and simulation cost

Baseline numbers (desktop 524,288 capacity, alive ceiling 10 percent = 52,429): 364 agents per square unit
on the 144-unit world, about 22.7 per coarse cell.

Grid cell counts at cell = neighborRadius (this is the real limit, not memory):

| World | phoneLow r=0.12 | desktop r=0.1 | desktopUltra r=0.08 | Fits 65,536? |
|---|---|---|---|---|
| 16 by 9 (today) | 134x75 = 10,050 | 160x90 = 14,400 | 200x113 = 22,600 | yes |
| 32 by 18 (2x2) | 267x150 = 40,050 | 320x180 = 57,600 | 400x225 = 90,000 | all but ultra |
| 48 by 27 (3x3) | 400x225 = 90,000 | 480x270 = 129,600 | 600x338 = 202,800 | none |
| 64 by 36 (4x4) | 534x300 = 160,200 | 640x360 = 230,400 | 800x450 = 360,000 | none |

Fixes for the cap: (a) a third scan level (the single-workgroup block scan becomes a two-pass tree; up to
16.7M cells; the "Blids" WebGPU flocking project, below, reports a counting sort with a 3-level prefix scan
at up to 4M agents, so the technique is established), or (b) a cell floor
`cellSize = max(neighborRadius, sqrt(worldArea / 65536))`; for 2x2 that is 0.094, so only desktopUltra
changes (0.08 becomes 0.094, 17 percent coarser; the 3x3 fine pass stays correct because cell >= radius,
and the 32-sample cap bounds cost). (b) is one line and enough for 2x2; (a) is needed for 3x3 and up.

Memory is not a constraint. At 2x2: coarse field 128x72 = 9,216 cells x 32 B = 295 KB per buffer (two
buffers), density accumulator 184 KB, density map 37 KB; grid 57,600 cells x 4 B x 4 buffers = 0.9 MB. At 4x4
the coarse field is 36,864 cells (1.2 MB per buffer). Agent buffers (32 B x capacity, ping-pong) do not depend
on the world.

Per-pass cost versus world area (reasoned from the shaders, not measured; UNVERIFIED on hardware):
- grid count/scatter, field accumulate, stats, glyph vertices: O(capacity). Unchanged.
- steer: O(capacity x at most 32 samples). A sparser world only lowers it (fewer neighbors per cell).
- grid clear/scan, field convert/blur, density readback: O(cells), small next to O(capacity).
- warp grid: O(lattice lines). 96x54 is 10,518 segments; the same spacing over 2x2 is 192x108 = 41,772
  segments (4x). This one needs windowing (section 6).
So at fixed capacity, simulation cost is nearly independent of world size. The cost of a bigger world is
set by how many agents we choose to keep alive, not by the area.

### Density at fixed capacity

| Option | Alive count | Density, 2x2 world | Cost | Look |
|---|---|---|---|---|
| A. Same count as today | 52k desktop | mean 91 per unit^2 (4x thinner) | same as today | thin away from the player, but enemies converge on the player anyway while seek is unlimited |
| B. Same mean density | 4x (210k desktop = 40 percent of capacity) | 364 | about 4x steering and field cost, UNVERIFIED frame time | identical per area, mostly off screen: pays for agents nobody sees |
| C. Bubble: same count, density kept near the player | 52k | normal near the player, empty far away; far agents recycled to gates near the player | same as today | decouples cost from world size; also what multiplayer needs (a bubble per swarm); no real "elsewhere" unless objectives persist |
| D. Hordes: same count, uneven | 52k to 100k | near-player normal, hordes elsewhere | 1x to 2x | needs the seek range from section 7 step 3 |

Note `desktopUltra` (2,097,152) is exactly 4x desktop, so option B at 2x2 is "ultra at today's look".
Phones (65,536 to 131,072) cannot afford B.

Recommendation: A for the first step (no sim cost change, no new rules), then D (hordes via seek range) as
the real "action elsewhere", with C as the technique if worlds grow to 3x3 or more.

### World size options

| Option | Verdict |
|---|---|
| Fixed 2x2 screens (32 by 18) | Recommended first. Fits the grid cap on all but ultra with the one-line floor. A Chaser at 4.5 units/s crosses it in about 7 s, so off-screen arrival is perceptible without dragging. |
| Fixed 3x3 or 4x4 | Later (step 4). Needs the third scan level, streaming or hordes, and a minimap. |
| World sized by preset | Rejected: breaks "gameplay never depends on capacity", and breaks multiplayer fairness. |
| Toroidal wrap | Not recommended. It removes edge cases (no wall band, no camera clamp) but every distance in steer, collide, projectiles, kill, contact and spawn needs a wrapped delta, the grid and field need modular neighbors, the camera must draw wrapped copies at seams, and "seek an objective" needs shortest-path logic. Many touch points for a look that is a taste call. Revisit only if hard edges feel bad in play. |

World edges: with a bounded world there are edges. Enemy sources: keep the wall band (agents enter from
off-screen edges as today) but add interior gates placed in a ring just outside the current view (section 7);
a world edge that is off screen is not where you look, so spawn near the player's view, not at the world edge.

Far agents full rate? Not needed at fixed capacity (cost is O(capacity) either way). Skipping far agents
helps only if skipped threads are coherent in a warp, and slot order is arbitrary in space (agents are
indexed by slot, not sorted); dispatching in `sortedIndices` order would be needed. Not worth it now.

## 4. The camera

### 4.1 Model

A camera is `{ centerX, centerY, zoom }` plus velocities. `zoom = 1` reproduces today's framing for the
canvas aspect (`arenaBoundsForAspect(aspect)` sets the base view size, 16 by 9 at 16:9). View size is the
base size divided by zoom. Nothing rotates, ever.

Pure module `src/game/camera.js`, no GPU, no clock (time is the sum of injected `deltaSeconds`), no
`Math.random`. Inputs per update:

```
{ focusX, focusY,          // controlled point blended with swarm centroid
  swarmRadius,             // 95th percentile ship distance from the focus
  aimX, aimY, aimStrength, // unit vector and 0..1
  nearPressure, farAction, // 0..1 from section 4.3
  viewAspect, world }
```

### 4.2 Framing: position

- Anchor: `focus = 0.5 * controlledPoint + 0.5 * swarmCentroid`. The ships leash to the point
  (`swarm-flocking.js` leash) but the centroid lags it; the blend keeps the swarm, not just the cursor, in view.
- Look-ahead: `lookAhead = aimDirection * aimStrength * LOOK_AHEAD_FRACTION * viewHeight`,
  `LOOK_AHEAD_FRACTION = 0.16`. Stick aim: `aimStrength` is stick magnitude. Mouse aim: `smoothstep(0.1, 0.6, d)`
  where `d` is the pointer's screen distance from the ship as a fraction of the shorter screen side. Direction is
  a unit vector and strength is bounded, so there is no runaway: a look-ahead that scaled with `pointerWorld`
  distance would feed back (the pan moves the pointer's world point, which asks for more pan).
  Keren's "Scroll Back" calls this family target-focus (look-ahead follows controller input) and projected-focus
  (extrapolated position); input-driven is the right one here because the ship's velocity is noisy (flocking).
- Optional velocity term: `+ 0.2 s * controlledPointVelocity`, clamped to 0.08 of the view height. Off by default.
- Dead zone (camera window in Keren's terms): half-extents `0.10 * viewWidth` by `0.10 * viewHeight` around the
  camera center; target motion inside it does not move the camera; outside, the target is the window edge.
- Smoothing: critically damped spring, exact closed form (frame-rate independent):

```
omega = 2 / smoothTime            // smoothTime = rise time constant, seconds
delta = value - target
b     = velocity + omega * delta
decay = exp(-omega * dt)
value'    = target + (delta + b * dt) * decay
velocity' = (velocity - omega * b * dt) * decay
```

  Constants: position `smoothTime = 0.30`; look-ahead offset `0.55` (slower, so a flick of the aim does not
  whip the view); cut (snap, zero velocity) on run start and respawn. This is the SmoothDamp/critically damped
  family (Unity `SmoothDamp`, Unreal `CriticallyDampedSmoothing`, Ryan Juckett's closed form).
- World clamp: after smoothing, `centerX = clamp(centerX, minX + halfViewWidth, maxX - halfViewWidth)` (same for Y);
  if the view is larger than the world on an axis, center on the world on that axis. The clamp is applied to
  the target before the spring, so the camera eases into an edge instead of stopping dead. Option: allow a
  0.5-unit overscan so the world border line (warp grid border) is visible at the edge.
- Render-time sampling: the fixed update advances the camera; `camera.sample(alpha)` extrapolates by
  `velocity * alpha * dt` exactly as glyph positions extrapolate (`glyphs.wgsl`, alpha). Without this, a camera
  stepped at the fixed rate against agents drawn at display rate shows relative judder on high-refresh screens.

### 4.3 Framing: zoom

Zoom works in log space with a limit on rate of change.

Inputs, preset-invariant (normalized by `capacity / DENSITY_REFERENCE_CAPACITY`, as `scaleDensityToCapacity` does):
- `nearCount`: enemies within `R_NEAR = 3.0` units of the focus. Source: the density map
  (`DensityReadback.densityAt`/`map`), summing cells whose centers lie inside the disc (about 190 cells at
  0.25-unit cells). The map is refreshed every 15 steps through a 3-slot ring (`density-readback.js`), so it
  lags about 0.25 to 0.5 s; the smoothing times below are all longer than that.
- `farCount`: enemies in the ring `R_NEAR` to `R_FAR = 9.0` that are outside the current view rect.
- `nearPressure = smoothstep(P_LOW, P_HIGH, nearCount / (N_REF * capacityScale))`
  with `N_REF = 6000` (placeholder, to be tuned in the lab; about the count in a 3-unit disc at a fully ramped
  uniform 364 per unit^2 is 10k), `P_LOW = 0.25`, `P_HIGH = 1.0`.
- `farAction = smoothstep(0.15, 0.6, farCount / (N_REF_FAR * capacityScale))`, `N_REF_FAR = 12000`.

Desired zoom:

```
lnZoom* = ln(ZOOM_BASE) + PUNCH_IN * nearPressure - PULL_OUT * farAction * (1 - nearPressure)
zoom*   = clamp(exp(lnZoom*), zoomMinimum, min(zoomMaximum, zoomFit))
zoomFit = 0.5 * min(baseViewWidth, baseViewHeight) * FIT_FRACTION / (swarmRadius + FIT_MARGIN)
```

Candidates: `ZOOM_BASE = 1.0`, `PUNCH_IN = ln(1.4) = 0.336`, `PULL_OUT = ln(1.0 / 0.6) = 0.511`,
`zoomMaximum = 1.6`, `zoomMinimum = 0.5` desktop, `0.67` phone, `FIT_FRACTION = 0.7`, `FIT_MARGIN = 1.0` unit.
Intent: lots of enemies near (nearPressure high) punches in up to 1.4x; action elsewhere with a quiet
neighborhood pulls out to 0.6x; a swarm of 256 ships that would not fit is always kept in view by `zoomFit`
(this is the hard constraint and overrides punch-in).

Anti-pumping:
- Smooth the two pressures with asymmetric attack/release: attack 0.4 s, release 2.0 s (so a brief swarm
  passing does not pump the view out and in).
- Zoom spring in log space: zoom in `smoothTime = 1.2`, zoom out `0.5` (reveal threats fast, tighten slowly).
- Rate limit: `|d ln zoom / dt| <= 0.35` per second (at most about 1.42x per second).
- Hysteresis: ignore changes of `lnZoom*` below 0.04 (4 percent) from the current target.
- Pivot: change zoom about the focus, not the screen center: `center' = focus + (center - focus) * zoomOld / zoomNew`,
  so the swarm does not drift on screen while the view scales.
- During a bomb, death, or time-warp ramp: hold the zoom target (do not react to the transient).

### 4.4 Nausea, aim and input

- No rotation, no shake, no instantaneous cuts except start and respawn. Camera acceleration is bounded by the
  critically damped response; zoom rate by the limit above (Keren: avoid sudden changes in camera speed and
  direction; conflicting visual and vestibular cues cause discomfort).
- Reduced motion (an existing setting): zoom fixed at 1 (or at the last stable value), no look-ahead, position
  `smoothTime = 0.6`, bigger dead zone (0.18).
- Mouse aim: direction is invariant under uniform scale and translation of the same screen vector, so
  `aim = normalize(pointerScreen - shipScreen)` does not depend on zoom at all; only the camera lag changes
  `shipScreen` over time. Use the camera transform of the current fixed step for both (deterministic and
  testable): pointer world = `screenToWorld` with this step's camera, which `pointer.js` already recomputes
  every update. The small residual shift while panning is the same as any lagging camera; keeping position
  `smoothTime` at 0.3 s and the focus near screen center keeps it small.
- Touch sticks are screen-space and unaffected. `touchOverlay` HUD exclusion zones are unchanged.
- The lab inspect zoom (`INSPECT_ZOOM = 4`, `pointer.js`, `capture-hook.js`) becomes a multiplier on the camera
  zoom so existing lab and capture code keeps working.

## 5. Options for the camera (trade-offs)

| Option | Pros | Cons |
|---|---|---|
| Fixed zoom, follow only | trivial; no legibility or trail issues | does not meet the brief; fine as step 1 |
| Zoom from density map (CPU) | no GPU change; preset-invariant; testable | 0.25 to 0.5 s lag, 0.25-unit resolution |
| Zoom from a GPU counter (new stats words: enemies within `R_NEAR` and `R_FAR` of the focus, needs focus position in `SimParams`) | low latency, exact disc | touches `stats.wgsl`, `SimParams` packing, stats ring; per-frame words 12-15 are free in `STATS_INDICES` |
| Zoom from the threat channel | already exists, decays | measures kills, not enemy presence |
| Camera fits swarm only (no density) | stable | misses the "punch in / pull out" feel |

Recommended: density map first (lab-tunable), move to GPU counters only if lag or blockiness is visible.

## 6. Rendering with a moving, zooming view

Seam: `Viewport` already exposes an exact `worldToClip`/`screenToWorld` pair. Replace its centered
`inspectZoom` and arena-rect centering with `camera.sample(alpha)`; consumers that read `worldToClip(0,0)` and
`(1,1)` (glyphs, particles, warp, gates, pickups, ship, swarm) follow for free (`glyphs.js:46-70`,
`particles.js:26-32`, `warpgrid.js packWarpView`). Consumers that read `arenaBounds` as the view rectangle
need an explicit split: `projectiles.wgsl:88,226-235,360` (beam to the edge and the in-arena fade) should use
the world for the beam end and the view for fades; `glyphs.js:41` (`shipCoverageScale`) uses `COARSE_*` and the
world rect and must use the field's world size.

- Warp grid: draw a fixed-size lattice window (about 96 by 54 lines) anchored to world-aligned multiples of the
  line spacing, sliding with the camera; spacing doubles at each halving of zoom (power-of-two LOD with a fade
  between levels) so line count and cost are constant (10.5k segments) at any zoom or world size. The vertex
  shader needs the window origin and spacing as uniforms; `ARENA_*` become world constants for the field sample.
  Keep drawing the world border line so edges are visible.
- Trails (screen-space accumulation breaks when the view moves). Options:
  (a) reproject the previous scene: each frame sample it at the previous frame's position of this pixel's world
  point. With clip = A*world + B per axis, previous clip = (A'/A) * (clip - B) + B'; pass `ratio` and `B'` in the
  decay uniform and use `textureSampleLevel` with a linear sampler instead of `textureLoad` (one extra binding in
  `trails_decay.wgsl`). Trail history lives about 5 frames (0.6 per 1/60 s), so bilinear softening does not
  accumulate visibly. Newly revealed screen area simply has no history.
  (b) clear trails while the camera moves faster than a threshold: simple, but trails blink in and out.
  (c) a world-space trail texture: rejected (a 32 by 18 world at useful resolution is far too large).
  Pick (a); ship (b) only as an emergency fallback behind reduced motion.
- Bloom: screen space, resolution-based; unaffected by camera motion. Bloom boost on shockwaves is unchanged.
- Glyph legibility zoomed out: ship pixel size is `ppu * 0.018*9 * zoom^0.5`. On an 844 by 390 phone
  (CSS px, dpr 1; UNVERIFIED for dpr handling) the base view is 16 units wide, 52.8 px per unit, so ships are
  8.5 px; at zoom 0.67 they are 7.0 px, at 0.5 they are 6.0 px (glow quad twice that). Add a sub-pixel LOD:
  below about 5 px, keep the quad at a 5 px floor and scale brightness by `(shipPixels / 5)^2`, so a zoomed-out
  crowd stays an energy-conserving glitter instead of aliasing sparkle. Phone `zoomMinimum` of 0.67 keeps most
  play above the floor.
- Culling: the glyph pass draws one instance per slot, and off-view quads are clipped by the rasterizer; vertex
  cost stays O(capacity) as today, fill cost drops. An explicit cull in the vertex shader (collapse to a
  degenerate quad outside view plus margin) saves only a few ALU instructions; skip it. Particles and
  projectiles are bounded by their pools.
- HUD and finding off-screen things:
  - Edge indicators (recommended first): chevrons clamped to the view rect inset 24 px for pickups, the
    telegraphed wave gate (`spawn-director.js` telegraph, 0.5 s) and the densest far cluster. Draw them in the
    GPU pass (the renderer owns the transform; they pick up bloom) or as at most about 12 DOM elements if the
    first cut should be fast. Hide when the target is on screen.
  - The camera itself: zoom-out when `farAction` is high shows the action without UI.
  - Minimap: only from 3x3 up; a 96 by 54 px corner canvas drawn from the CPU density map (already read back).
    Avoid on phones (screen cost, thumbs).
  - Do not make indicators pop in and out of layout (persistent-slot rule from owner notes): fade by opacity.
- Composite/capture `arenaRect` (`renderer.js:180-185`): with a camera the view always fills the canvas;
  the 1:4 to 4:1 letterbox can stay for step 1 and be dropped later.

## 7. Recommendation: incremental steps

Each step ends green (`npm test`, `npm run coverage`, `npm run check:gpu`, smoke) and shippable.

### Step 0: camera seam, no visible change
- New pure `src/game/camera.js` (`Camera`: center, zoom, velocities, `sample(alpha)`, clamp) and
  `src/sim/world.js` (`WORLD_WIDTH`, `WORLD_HEIGHT`, derived `COARSE_*`, `gridDimensions`), with `layout.js`
  re-exporting; `SHADER_CONSTANTS` gains `WORLD_WIDTH`/`WORLD_HEIGHT` and `common.wgsl:14-15` takes the tokens.
- `Viewport` takes a camera instead of `inspectZoom`; `inspectZoom` stays as a multiplier. At world 16 by 9
  with the camera locked to the arena center the transforms are identical.
- Split the meaning of `arenaBounds`: `worldBounds` (walls, spawn band, clamps, pickups, projectile kill) versus
  the view rectangle (render, fades). They are equal in this step.
- Verify: `viewport` unit tests unchanged; `render-capture.mjs --compare` against a pre-change baseline within
  the existing difference limits; `check:gpu` unchanged.

### Step 1: 2x2 world with a follow camera (smallest step that puts a moving camera over a larger world)
- World 32 by 18; `COARSE` 128 by 72 (derived from the 0.25-unit cell); `gridDimensions` applies the cell floor
  (only desktopUltra changes, 0.08 to 0.094); `field.js`, `density-readback.js`, `warpgrid.wgsl`, `common.wgsl`
  consume the world constants. `validatedArenaBounds` and the `spawnBandWidth` limit follow the world.
- Camera: follow only (`smoothTime` 0.30, dead zone 0.10, world clamp), `zoom = 1`, cut on start and respawn.
  Reduced motion uses the larger dead zone.
- Counts: alive target unchanged (option A). Replace the aspect-based area fraction with a constant: the alive
  ceiling stays 10 percent of capacity as at 16:9 today. (Check with the owner: today narrower aspects get a
  smaller alive count; this removes that.)
- Gates: place in a ring `1.0` to `1.4` view half-diagonals from the player, outside the current view, inside
  the world (the band weights stay for edge pressure). `safeDistance` uses the view width, not the world.
  Wave telegraph gets an edge chevron (the first off-screen indicator), as do pickups.
- Pickups: annulus radii scale with the view half-diagonal so pickups appear near enough to reach.
- Bomb: use the existing radial `KillArea` with radius = view half-diagonal x 1.2 centered on the swarm; the
  death clear stays global. Unscored, as now.
- Warp grid at step 1: draw the world lattice at the same spacing (41.8k segments) on desktop, skip the border
  fade; windowing lands in step 2. Phones: keep 96 by 54 over the world (coarser spacing).
- Verify: unit tests for `camera.js` (injected dt: convergence in time, no overshoot, clamp at edges, cut), world
  constant consistency test (layout vs `common.wgsl` tokens), `check:gpu` runs (`grid`, `simulation`,
  `player`), smoke `--play`, `mobile-smoke`. Measure frame time with the lab readout before and after.
- Enemies still converge on the player (seek is unlimited), so this reads as "a larger room with entrances".

### Step 2: dynamic zoom and render support
- Density-driven zoom and look-ahead (section 4), lab knobs for every constant, `zoomMinimum` per device class.
- Trail reprojection, warp grid window plus power-of-two LOD, sub-pixel glyph LOD, off-view indicators for
  the dense far cluster, pivot zoom, rate limits, reduced-motion path.
- Probe: the frame-time probe measures real GPU time, which now varies with zoom (zoomed out shows more
  agents). Add a LOD lever before dropping capacity (the sub-pixel glyph LOD and fewer warp lines), and hold the
  probe's down-step for 3 s after a zoom change settles (it is already at most one step per 3 s).

### Step 3: locality, so "elsewhere" exists (gameplay change, owner call)
- Seek range: `seek *= smoothstep(seekRange, seekRange * 0.6, distanceToNearestTarget)` in `steer.wgsl`
  (`seekRange` about 1.5 view widths, lab knob). Beyond it enemies flock (cohesion, alignment) and drift;
  `params.playerPosition` becomes `targets[N]` for multiplayer.
- Hordes: gates seed pre-ramped hordes away from the player (alive budget 1x to 2x); spawn pressure splits its
  target into a near budget (around the player, fed from the density map) and a far budget (hordes).
- Spawn pressure and score stay capacity-normalized (`scaleDensityToCapacity`, `ScoreKeeper`); hordes kill the
  player's pace if they all stay far, so tune the far budget so the median time to the next contact is under
  about 6 s (to be tuned in play).

### Step 4: bigger worlds
- Third scan level (`grid_scan.wgsl`, `grid.js`), world 3x3 or larger, optional bubble streaming (recycle
  agents more than 2 view diagonals away to gates near the player, unscored and without particles), minimap,
  readback restricted to a window around the focus (the 4x4 map is 147 KB per 15 steps).

### Step 5: multiplayer readiness
Section 9 records what to keep open; no design here.

## 8. GPU and mobile-limit implications (rough numbers)

| Item | 16x9 today | 2x2 (step 1) | 4x4 (step 4) |
|---|---|---|---|
| Fine grid cells at r=0.1 | 14,400 | 57,600 | 230,400 (needs 3-level scan) |
| Coarse cells | 2,304 | 9,216 | 36,864 |
| Coarse field per buffer | 74 KB | 295 KB | 1.2 MB |
| Density readback per 15 steps | 9 KB | 37 KB | 147 KB |
| Warp segments at today's spacing | 10.5k | 41.8k (windowed: 10.5k) | 166k (windowed: 10.5k) |
| Storage buffers per shader stage | unchanged | unchanged | unchanged (no new bindings in sim) |
| Alive count (option A) | 52k desktop, 6.5k phoneLow | same | same |

- Storage buffer limit: no new storage bindings in any sim shader. The trails shader gains one sampler and
  stays far under limits. Density-driven zoom adds no GPU work (CPU map).
- `maxStorageBufferBindingSize`: the preset rule (`agentBufferBytes <= max/2`) is unaffected; the world adds
  no large buffers.
- Workgroup limits: scan level three uses the same 256-wide workgroups and 1 KB of workgroup memory.
- Phone: `phoneLow` runs the sim at half rate; the camera still updates every fixed step and samples at render
  alpha. A phone at zoom 0.67 shows 2.2x the world area with the same alive count, so it looks sparser, not
  slower.
- Measured numbers: none. Run the lab readout and the quality probe before and after step 1; this document
  gives structure, not frame times.

## 9. What changes in existing modules

| Module | Change |
|---|---|
| `src/sim/layout.js` | world constants and derived sizes move to `world.js`; `gridDimensions` cell floor; `arenaBoundsForAspect` becomes `baseViewSize(aspect)` |
| `src/sim/shaders/common.wgsl` | world constants via tokens; `cellIndexFor`/`coarseCellIndexFor` use them |
| `src/sim/grid.js`, `grid_scan.wgsl` | cap check uses the floor (step 1); third scan level (step 4) |
| `src/sim/field.js`, `density-readback.js`, `field_*.wgsl`, `density_sum.wgsl` | sizes from world constants |
| `src/sim/params.js`, `simulation.js` | bounds validation against the world; `playerPosition` init at world center; `setArenaBounds` splits into world bounds and spawn-view hints |
| `src/sim/spawner.js`, `spawn-director.js`, `spawn.wgsl` | ring placement around the view, constant alive ceiling, `safeDistance` from view width, band uses world |
| `src/sim/shaders/steer.wgsl` | step 3: seek range, target array |
| `src/game/game.js` | owns the camera; update order: input, camera update (uses last step's swarm state), controls; radial bomb; `areaFraction` removed |
| `src/game/camera.js` (new), `camera-focus.js` (new, pure: focus, zoom inputs from density map) | section 4; each under 500 lines |
| `src/game/pickups.js` | annulus from view size |
| `src/render/viewport.js` | camera transform; `arenaBounds` renamed; `inspectZoom` as multiplier |
| `src/render/glyphs.js`, `particles.js`, `projectiles.js` and WGSL | view-vs-world split, sub-pixel LOD |
| `src/render/trails.js`, `trails_decay.wgsl` | reprojection uniform and sampler |
| `src/render/warpgrid.js`, `warpgrid.wgsl` | lattice window and LOD, world constants |
| `src/render/gates.js`, `pickups.js`, new `edge-indicators.js` | off-screen chevrons |
| `src/input/pointer.js`, `capture-hook.js` | use camera zoom multiplier |
| `src/settings/presets.js` | `neighborRadius` of ultra revisited; per-device `zoomMinimum` |
| `src/ui/settings.js` | optional "camera zoom" slider in step 2 (taste, section 11) |
| Tests | new `tests/game/camera.test.js` (injected dt), updates to `tests/render/viewport*`, `tests/sim/layout*`, coverage floors (92 and 86) kept |

AGENTS.md needs a rewrite of the "world is 16 by 9" constraint and the pass-order text in step 1 (docs-update).

Multiplayer notes (not designed here):
- One screen, two swarms: the camera frames the union of the foci (box of both foci plus swarm radii),
  `zoomFit` and `zoomMinimum` become the leash: when the foci exceed the maximum view, tether or rubber-band the
  players, or split. Zoom pressure inputs become per-swarm maxima.
- Separate screens: `Camera` is already an instance; the renderer would draw the world once per view into
  sub-rects (2x vertex and fill cost; trails and bloom targets per view), `Viewport` takes a canvas sub-rect,
  `pointer.js` maps per view. The sim must not read any camera (this design keeps that).
- Sim: `params.playerPosition` becomes a target array (step 3), `spawn.wgsl` minimum distance is the minimum over
  players, `kill_all.wgsl` radial bomb is per-swarm, the density readback serves all cameras.

## 10. Risks

- Camera feedback with the mouse (look-ahead moves the pointer's world position): mitigated by unit-vector
  look-ahead with bounded strength; test in the lab with a scripted pointer.
- Zoom pumping or nausea: rate limits, asymmetric attack/release, hysteresis; reduced-motion path. Needs play
  testing; constants here are candidates, not tuned.
- Density map lag (0.25 to 0.5 s): acceptable for zoom smoothing, not for sudden threats; GPU counters are the
  upgrade.
- Cost unknown at the moment: none of the frame-time claims are measured; step 1 begins with a baseline.
- Legibility at zoom 0.5 on phones: 6 px ships; mitigated by `zoomMinimum` 0.67 on phones and the sub-pixel LOD.
- Gameplay drift: removing the aspect-based alive count and a bigger room changes difficulty; the first
  deaths ramp (`DEFAULT_RAMP` tuned in task C0) assumed enemies spawn 0.4 arena widths away at start.
- `MAXIMUM_SPAWN_GATES` = 4 and 3 gates in a 32 by 18 world may feel sparse; raising it grows the `SimParams`
  uniform (layout change in `params.js` and `common.wgsl`).
- Trail reprojection softness at fast zoom; fallback (b).
- Hard to test GPU changes here: `check:gpu` falls back to a software adapter in CI (exit 2 without one).
- Not read: `ScoreKeeper` internals, `loop.js` step size, `quality.js` probe details, `main.js:72`.
  The scoring claim (capacity normalization stays valid because alive count and capacity are unchanged in
  steps 1 and 2) is UNVERIFIED against `score.js`.

## 11. Open decisions for the owner (taste calls, with my recommended default)

1. World size: 2x2 first (recommended), or jump to 3x3. Default 2x2; 3x3 only after step 3.
2. Should enemies converge on you from anywhere (today, bigger room) or only within an aggro range, with hordes
   elsewhere (step 3)? Default: ship step 1 as is, then try the aggro range in the lab before committing.
3. Zoom range: `zoomMinimum` 0.5 desktop and 0.67 phone, `zoomMaximum` 1.6. Default as stated; or fixed
   zoom 1 with only follow if the zoom feels busy (a setting could allow "camera zoom: off / low / full").
4. Zoom behavior: punch in when crowded, pull out when elsewhere (recommended, as asked), versus the opposite
   convention many games use (pull out when crowded so you see threats). The brief asks for punch-in; default
   as asked, with `PUNCH_IN` tunable to 0.
5. Aspect handling: today a narrow window plays a smaller arena. Default: every aspect plays the same world and
   sees base area proportional to aspect-limited view (as `arenaBoundsForAspect` already does at zoom 1), so
   the alive count no longer shrinks with aspect.
6. Bomb: clear what the camera sees plus 20 percent (recommended) or still the whole world.
7. Edge indicators: chevrons for pickups and the wave gate (recommended), plus a minimap from 3x3 up
   (decide later).
8. Reduced-motion camera: fixed zoom with a gentle follow (recommended).
9. Whether the world border stays visible at the edge (0.5-unit overscan with the warp-grid border), or the
   camera stops flush at the edge. Default: visible border.
10. Toroidal wrap: default no; revisit only if hard edges feel wrong.

## Sources

Found by search during this exploration (summaries are of what the pages said; none were load-tested):
- Itay Keren, "Scroll Back: The Theory and Practice of Cameras in Side-Scrollers", GDC 2015, article:
  https://www.gamedeveloper.com/design/scroll-back-the-theory-and-practice-of-cameras-in-side-scrollers
  (camera window, lerp smoothing, target-focus and projected-focus, avoid sudden speed changes, nausea from
  conflicting visual and vestibular signals). It is about side-scrollers, not twin-stick games.
- Ryan Juckett, "Damped Springs": https://www.ryanjuckett.com/damped-springs/ (closed-form damped springs,
  frame-rate independent camera motion).
- Unity `Vector3.SmoothDamp`: https://docs.unity3d.com/462/Documentation/ScriptReference/Vector3.SmoothDamp.html
  and Unreal `FMath::CriticallyDampedSmoothing`:
  https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Core/FMath/CriticallyDampedSmoothing?lang=en-US
  (critically damped smoothing as the standard follow-camera primitive; Unreal notes reduced accuracy at large
  frame-time spikes, which is why the closed form is used here).
- Blids, WebGPU flocking, up to 4M agents, counting-sort grid with prefix scan (self-reported):
  https://github.com/Benjaminsen/Blids
- Spatial grid guidance for GPU boids (cell at least as wide as the neighborhood radius; sort by cell index):
  https://github.com/geant04/CUDA-Flocking and https://github.com/MegSesh/Project1-CUDA-Flocking (search
  summaries only; pages not opened).
- Geometry Wars 3 reviews on camera problems (camera hugging the player hides threats; camera not far enough
  ahead): https://pcgamer.com/geometry-wars-3-dimensions-review and
  https://www.gamerevolution.com/?p=66623 (search-result summaries only; pages not opened). The search found
  nothing about the zoom behavior of the original Geometry Wars or any "Grid Wars" camera; claims about those
  are not made here.
- Not found: any published camera design specific to large swarm shooters with dynamic zoom on enemy density.
  The density-driven zoom in section 4.3 is original to this design and untested.
