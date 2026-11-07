# Murmuration

A browser WebGPU page that simulates hundreds of thousands of flocking enemies of five species entirely on the GPU, rendered as neon spaceship silhouettes (one shape per species, nose along the heading) over a reactive warp grid with trails and bloom. Run it with `npm install` then `npm run dev` (serves on http://127.0.0.1:5174).

## Commands

- `npm run dev`: dev server on 127.0.0.1:5174 (strict port).
- `npm run build`: static build into `dist/`; set `PAGES_BASE` for a sub-path deploy.
- `npm test`: CPU logic tests via node:test.
- `npm run smoke`: Playwright browser smoke test (see below).

## Demo controls

- Move the player point with WASD or the arrow keys, the left stick of a gamepad, or by dragging in the left half of the screen on touch.
- Hold the left mouse button to kill agents at the pointer. On touch, hold the right half of the screen and drag to aim; on a gamepad, push the right stick. Both kill 1.5 world units from the player along the aim (at the player before the touch is dragged). Kills splash particles.
- Hold the right mouse button for a 4x inspect zoom around the arena.
- The first click, tap or key press starts the procedural techno (it speeds up, opens its filters and adds a lead as the arena fills and kills land; tempo changes land on bar starts). Press M to mute or resume all sound.
- Press the backquote key, or use the `debug` button in the top right corner, to open the demo controls panel. It is hidden by default and holds:
  - a capacity select (65536, 262144, 1048576, 4194304 agent slots; a change rebuilds the simulation and carries live agents over),
  - the same-species cohesion toggle (off steers cohesion up the total-density gradient instead of the own-species one),
  - spawn share sliders, ten sliders per species, and the 5 by 5 species matrix,
  - renderer sliders (trail decay, bloom strength, warp density and threat weights),
  - a live readout of frames per second and alive counts.
- `?capacity=N` in the URL sets the starting capacity to one of the select's values; anything else starts at 262144.

## Smoke test

`npm run smoke` starts the Vite dev server on port 5174 (nothing else may use it), opens the page in headless Chromium with WebGPU flags, waits for `window.__murmuration.ready` and for `frame` to reach `--frames N` (default 120), and fails on any console error. Set `SMOKE_URL` to test an already running server. Exit codes: 0 ok, 1 failure, 2 no WebGPU adapter. On this machine headless Chromium gets an adapter, so exit 2 has not been observed; its message is `smoke: WebGPU adapter unavailable in headless Chromium (navigator.gpu missing or requestAdapter() returned null)`.

Caveats:

- Headless Chromium here needs `--disable-dawn-features=use_dxc`: without it `requestDevice` fails because `dxcompiler.dll` cannot load (Windows Error 87), so shaders compile through the FXC fallback.
- Headless Chromium may never composite a WebGPU canvas, so `page.screenshot()` is not trusted. The page publishes `window.__murmuration.capture`, which copies the swapchain texture back through the GPU; the smoke reads it for its luminance checks.
- The smoke writes `artifacts/smoke.png`, `artifacts/smoke-zoom.png` and `artifacts/smoke-kill.png`. `artifacts/` is not committed.
- The smoke never opens the debug panel.
- The smoke's kill check mouse-down is the first gesture, so it also checks that the audio unlocks and the sequencer schedules steps. Chromium runs with `--mute-audio`, so the smoke is silent.
- `SMOKE_PORT` overrides the smoke server port (default 5174), for running smokes from parallel checkouts.

## Measured

1,048,576 slots (`?capacity=1048576`), headless Chromium with uncapped frame flags, NVIDIA RTX 4090 (adapter info reports vendor nvidia, architecture lovelace), 1280 by 720 viewport:

| Quantity | Value |
| --- | --- |
| Alive agents when the run stopped (about 90 seconds in) | 979,039 |
| Render frames per second over the last 10 seconds | 1,393 |

The spawn ramp takes 90 seconds, so the alive count passes 900,000 only near the end of it. The 1,393 is a render-only rate in headless Chromium, not a gameplay frame rate: it counts animation frames with vsync and the frame rate limit disabled, and the simulation still advances in fixed 1/60 second steps, so about 60 simulation steps per second ran under those frames. Simulation step cost was not measured separately.

The same run held a plateau of 304,727 alive agents from about 10 to 20 seconds. That was a spawn overshoot: read-back stats lag the GPU by several steps (more when one animation frame runs several fixed steps), and the spawner requested the same deficit again on every lagging step, so the alive count overshot the ramping target about twofold and then waited for the target to pass it. SpawnPressure now counts the spawns requested for steps newer than the stats it has seen, and the simulation browser check runs main.js's cadence and fails above 1.05 times the target. The table predates that fix. Reproduce with a script that launches `launchWebGpuBrowser({ measuring: true })` from `tests/browser/launch.mjs`, opens the page with `?capacity=1048576`, and samples `window.__murmuration.frame` and `stats.aliveTotal` every 10 seconds.

Arena mean luminance (Rec. 709 over the arena rect of a captured frame, 0 black to 1 white), 262,144 slots, 1280 by 720, the same machine:

| When | Arena mean luminance |
| --- | --- |
| `npm run smoke -- --frames 300` capture | 0.4758 |
| Full ramp, about 95 seconds in (235,929 alive) | 0.5716 |

Both were measured with ships 0.018 of the arena height long (`shipArenaFraction`, about 13 device pixels here), the attenuation floor at 0.3 and `MAXIMUM_CROWD_RADIANCE` at 0.75. With the floor uncapped the full ramp saturated at 0.80, and lowering `EXPOSURE` to 0.10 left it at 0.80 while failing the smoke's kill-flash margin, so the cap is the lever. The smoke fails above 0.6. Reproduce the full-ramp number with a script that opens the page with `?capacity=262144`, waits about 95 seconds and reads `meanLuminance` from `window.__murmuration.capture()`.

## Tuning notes

- Averaged separation cancels inside a uniform crowd, so the coarse pressure term sets spacing. Lattice with `targetDensity` 24 per coarse cell settles at about 0.05 world units, half the neighbor radius.
- Lattice sheets breathe: an undamped pressure spring against low acceleration. Damping is a lab item for Plan C.
- Brightness: each ship is divided by 1 + 4 times the fraction of its coarse cell that ship bodies cover on screen (`COVERAGE_ATTENUATION` in `glyphs.wgsl`), but not below `ATTENUATION_FLOOR` (0.3), and that floor's summed radiance is capped at `MAXIMUM_CROWD_RADIANCE` (0.75) so a full ramp under trails stays colored instead of saturating. Ship length is `shipArenaFraction` of the arena height (at least 8 device pixels) and grows with the square root of the inspect zoom, so zooming in spreads a crowd apart. The composite tonemaps luminance and keeps hue, so dense cores stay colored instead of white. Trails decay per elapsed time (`trailDecay` is the fraction kept per 1/60 second) and emission is scaled to match, so trail length and brightness do not depend on the refresh rate.
- Straight seek brakes near the player (`ARRIVAL_BRAKING` 0.7 in `steer.wgsl`), so swarms with pressure off collapse onto the player instead of oscillating through it.
- No clumps: pressure only acts above `targetDensity`, so the old targets (30 to 150) left a sparse population (the ramp-up, 6 to 18 per coarse cell) with no pressure; Lattice packed most of its agents near the player. Targets are now 16 to 30 per coarse cell (Chaser 24, Orbiter 18, Skittish 30, Lattice 24, Predator 16 with pressure 0.5). The pressure term is clamped to 2 times `maximumSpeed`, and straight seek fades out inside a 1.0 unit comfort radius so seekers hover instead of piling on the player. The ruling rests on the sparse cases: check (e) in `tests/browser/steer.mjs` gates the share near the player and the peak cell at 13107, 40960 and 262144 agents (uniform seeding, not the spawner's geography). Measured at 13107 agents (ramp start): 12.6 percent within 1 unit of the player, peak cell 9.7 times the population average, 79 percent grouped (in a cell over twice the average); at 40960: 4.6 percent, 3.2 times, 18 percent; at 262144: 2.6 percent, 2.0 times, 0 percent. The ramp-start peak limit is 4 times the highest target, a weaker gate than 4 times the average.
