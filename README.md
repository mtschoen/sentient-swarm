# Sentient Swarm

A browser WebGPU shooter (the code, packages and repository are named murmuration) that simulates hundreds of thousands of flocking enemies of five species entirely on the GPU, rendered as neon spaceship silhouettes (one shape per species, nose along the heading) over a reactive warp grid with trails and bloom. Run it with `npm install` then `npm run dev` (serves on http://127.0.0.1:5174).

Play it at https://mtschoen.com/games/sentient-swarm/ or https://mtschoen.github.io/sentient-swarm/ (GitHub Pages, published from main by `pages.yml`). Source: https://github.com/mtschoen/sentient-swarm.

## Commands

- `npm run dev`: dev server on 127.0.0.1:5174 (strict port).
- `npm run build`: static build into `dist/`; set `PAGES_BASE` for a sub-path deploy.
- `npm test`: CPU logic tests via node:test.
- `npm run smoke`: Playwright browser smoke test (see below).
- `npm run coverage`: the tests with Node's built-in coverage over `src/`, failing under the line and function floors in `package.json`.
- `npm run check:gpu`: the small GPU page checks in sequence (probe, grid, player, simulation, projectiles, bloom); needs a WebGPU adapter (`WEBGPU_ADAPTER=fallback` forces the software one).

## CI

- `check.yml` runs on every push and pull request: `npm test`, `npm run coverage` and `npm run build`, plus an advisory job that runs `npm run check:gpu` on the software adapter (a missing adapter shows as a failed step, never a pass).
- `browser.yml` runs on main pushes and manual dispatch on a self-hosted runner with a real GPU: the smokes, `quality.mjs`, `check:gpu`, `steer.mjs` and `bloom.mjs`. It never runs for pull requests.
- Local only: `audio-render.mjs`, `render-capture.mjs --compare`, `capture-*.mjs`, the measurements below and the phone checklist in `SMOKE.md`.

## How to play

You are a one-hit ship in an arena full of flocking enemies. One touch kills you. Shoot to score, grab weapon pickups, and survive. The game waits on a Ready screen until your first click, tap or button press (moving also starts it); starting clears the arena.

### Controls

| Input | Move | Aim and fire | Bomb | Pause |
| --- | --- | --- | --- | --- |
| Keyboard and mouse | WASD or arrow keys | Mouse aims, hold the left button to fire | Space or the right mouse button | Escape |
| Gamepad (tuned for a DualSense) | Left stick | Right stick aims, and pushing it past half fires | Any face button, or either trigger | Options |
| Touch | Left half of the screen, a floating stick | Right half, a floating stick that aims and fires | The bomb button, lower right | The pause button at the top centre of the arena |

- The title menu has Play, Lab and Settings; the pause menu has Resume, Settings, Restart run and Quit to title. Arrow keys, the d-pad, the left stick, Enter, Space and the face buttons drive both menus. Play also starts on a tap or click anywhere on the title screen. The game pauses itself when the tab is hidden, the window loses focus or a phone is held in portrait (an overlay asks you to rotate to landscape).
- A bomb kills every agent in the arena and scores nothing. You start with 3 bombs and 3 lives, and a press with no bombs left does nothing.
- After a hit you die, the arena clears (that scores nothing either), and you respawn after a short pause with 2 seconds of invulnerability. With no lives left the run ends; use Play again (or tap), or press fire or bomb on a gamepad or Space on the keyboard, to restart.
- The right mouse button is only a bomb in the game. The 4x inspect zoom it used to hold exists in the Lab only.
- On a gamepad, rumble plays on a bomb, a death, a pickup and an extra life (a trigger rumble where the pad supports it, else the dual motors); a phone buzzes briefly on a bomb and a death where the platform allows it.
- Keys: M mutes or resumes all sound, O opens the settings panel (so does the Settings button at the bottom left), backquote opens the Lab.

### Weapons and pickups

You start on the base gun: three energy balls in a spread with unlimited ammo. They are big and slow enough to read, live until they cross the arena, and pierce everything they hit, so each volley carves a tunnel the swarm cannot close at once. A pickup arms one of four upgrades with three tiers each, adds a rail turret, or starts a time warp:

| Weapon | What it does | Tier 1, 2, 3 |
| --- | --- | --- |
| Beam | A continuous swept beam that cuts everything along it | Wider each tier |
| Scatter | A short-range fan of small energy orbs | 9, 13, 17 orbs |
| Pulse | A slow orb that detonates into an expanding ring in dense crowds, or when it expires or leaves the arena | 1, 2, 3 orbs |
| Sidewinders | Missiles that turn toward the densest part of the swarm | 2, 4, 6 missiles |
| Rail (turrets) | See below: not an armed weapon | Rail tier 1, 2, 3 shots per turret volley |

- Every shot pierces: it keeps going through the agents it kills.
- The arena offers one pickup type at a time, rotating every 20 seconds (the HUD shows the next type). Pickups appear when your multiplier steps up and at least every 10 seconds while you are on the base gun. An untouched pickup fades out after 10 seconds. Every pickup also fires a clearing blast: agents within 1.5 world units of the ship die, unscored like a bomb, with a shockwave.
- Picking up the same armed type adds a tier (up to 3) and refills the charge. A different type drops you one tier (never below 1) and refills the charge.
- A time warp pickup (a pale violet clock, one rotation slot in six) arms nothing either: for 6 seconds the swarm moves, spawns and dies at 0.3 speed while your ship, your fire and your shots keep full speed, with a cold tint, slower music and a WARP bar on the HUD; another time warp extends it and a death ends it.
- A rail pickup arms nothing. It adds a rear-firing turret that fires rail shots whenever you fire, on top of whatever weapon is armed (the beam included). Turrets fan out 30 degrees apart centred on the rear of your aim and rotate with it: one points straight back, then two, three and so on, up to 12 turrets all around. Further rail pickups after 12 raise the turrets' rail tier up to 3. Turrets have no charge; a hit drops them together with the armed weapon. The HUD shows the turret count and tier.
- The charge ring around the ship is the charge left of the armed weapon: the bright arc is the fraction remaining, drawn clockwise from the top. It drains only while you fire, and when it empties you return to the base gun (turrets stay). Dying drops the weapon and the turrets.

### Difficulty

- New enemies enter through spawn gates: three drifting rings at the arena edges or in the interior, never inside a safe radius around you or in the lane you are aiming down. A gate lives about 14 seconds. Every 1.6 seconds one gate emits a wave for 0.7 seconds (it brightens just before), so pressure comes in bursts with quiet gaps. The first fill after a start or respawn opens every gate at once.
- The alive target ramps from 1 percent to 10 percent of capacity over 120 seconds on a squared curve (a tenth is where the swarm still packs into a shape instead of filling the arena), enemies seek the ship more strongly as the ramp goes (10 percent at the start), and spawns start farther away (0.4 of the arena width, shrinking to 0.25). Killed enemies refill at 15 percent of the alive target per second, spent in the wave bursts.

### Scoring

| Rule | Value |
| --- | --- |
| Points per kill | `10 * 262144 / capacity`, so a run scores the same at any capacity |
| Multiplier | 1, 2, 3, 4, 5, 6, 8, 10 at kill streaks of 0, 50, 150, 400, 1000, 2500, 6000, 15000 (scaled by `capacity / 262144`) |
| Streak reset | Getting hit resets the streak and the multiplier |
| No points | Bomb kills and the death clear |
| Extra life | At scores `75000 * 2^n` (n from 0) |
| Extra bomb | At scores `40000 * 2.5^n` (n from 0) |

## Settings

Open the panel with the O key, the Settings button (bottom left) or Settings in either menu. Changes apply live and are saved in the browser.

- Quality preset: the preset in effect (see the table below); changing it rebuilds the simulation at that size. Re-run probe lets the quality probe step up again.
- Effects, Shake and Trails: calibrated so 100 percent is the tuned default and the range is 0 to 300 percent. Effects scales kill bursts and bloom, Shake scales the screen shake, Trails scales trail length (300 percent is long streaks that still fade).
- Music and Effects volume: 0 to 100 (default 80 each).
- Stick dead zone (0 to 50 percent, default 15) and Stick size (50 to 200 percent) for the gamepad and the touch sticks; Gamepad rumble on or off.
- Reduced motion: opt-in, off by default. It turns trails off and halves kill particles and shake.

## Quality presets

Presets change counts and visual budgets only; gameplay never depends on capacity (scoring and the ramp are normalized to capacity).

| Preset | Capacity | Particles | Neighbor radius | Bloom | Simulation rate |
| --- | --- | --- | --- | --- | --- |
| `phoneLow` | 65,536 | 32,768 | 0.12 | low | half |
| `phoneHigh` | 131,072 | 65,536 | 0.10 | medium | full |
| `desktop` | 524,288 | 131,072 | 0.10 | high | full |
| `desktopUltra` | 2,097,152 | 262,144 | 0.08 | high | full |

- Start: `phoneLow` on a phone (detected from the browser's mobile hint, else a coarse pointer with touch points), `desktop` elsewhere, stepped down until the agent buffer fits half of the adapter's storage binding limit. A preset stored for the same GPU adapter is reused.
- The probe measures frame time during play only (never on a menu, a pause or the lab's Watch). Its target is 10 ms: a 90th percentile over 180 frames (after 120 warm-up frames) above 13.5 ms steps down, below 6 ms steps up, and never more than one step every 3 seconds. A step down first halves the particle budget and lowers bloom one level, then drops a preset on the next. A stored preset only steps down; a fresh adapter (or Re-run probe) may also step up, to the highest preset the adapter's binding limit allows.
- `?capacity=N` pins the capacity (one of 65536, 131072, 262144, 524288, 1048576, 2097152, 4194304) and turns the probe off; `?probe=off` turns only the probe off.

## Lab

Choose Lab on the title menu (or press backquote). The lab panel holds:

- Watch (the default) and Play. Watch keeps the swarm running with no weapons and no contact; the swarm chases your pointer (or the move stick) and the alive count is held at a chosen fraction of capacity. Play runs the full game with the current mix.
- Mixes: six bundled mixes (`default`, the shipped chaser-dominant shares, `equalFive`, `allChasers`, `mixedFive`, `predatorsVsPrey`, `latticeStorm`) and mixes you save by name in the browser. A mix names the species shares, the five species rule rows, the 5 by 5 interaction matrix, the neighbor radius, the simulation rate and optional knob values.
- Share writes the current mix into the address as `#mix=...` (no reload). Opening a link with `#mix=` applies it and opens the lab; a malformed link opens the lab with the shipped defaults and a status line.
- Knob groups: Watch, Steering and walls, Spawn ramp, Spawn gates, Kills and particles, Weapons (the pickup blast radius, the base gun kill budget, the beam sweep budget and the time warp's seconds and speed), plus renderer sliders, a capacity select and a live readout of frames per second and alive counts.
- The right mouse button holds the 4x inspect zoom here only.
- Leaving to the title restores the settings the game had when you entered, so the next Play is the shipped game.

## Audio

Procedural four-on-the-floor techno, synthesized with Web Audio; no audio files. The tempo runs from 124 to 134 beats per minute with the intensity and changes only on bar starts. The song moves through sections (intro, groove, build, drop, breakdown, in 8 or 16 bar blocks) over two chord progressions, with a key change on every second drop, a short melody motif per section and a fill bar at the end of each 8 bar phrase. Intensity (0 to 1) comes from survival time in the run (45 seconds to the full weight), the score multiplier and kills per second; it opens the filters, adds layers and the lead, and raises the tempo. A death halves the survival part. Picking up a weapon plays a rising riser on the music as well as the pickup effect. Weapon fire has a voice per weapon and tier, and kills, bombs, deaths, pickups and extra lives have effects.

The first gesture that starts the run (a click, tap or key; a gamepad press alone cannot) unlocks audio. M mutes or resumes everything. Audio is suspended while the page is hidden.

## Smoke test

`npm run smoke` starts the Vite dev server on port 5174 (nothing else may use it), opens the page in headless Chromium with WebGPU flags, waits for `window.__murmuration.ready` and for `frame` to reach `--frames N` (default 120), and fails on any console error. It also checks that the game waits in Ready, that a click starts the run, and that the start clears the arena. `--play N` instead drives a synthetic gamepad that moves the ship, starts the run and fires for N frames, and requires a positive score and a ship brighter than the arena mean. Every page evaluate and the whole run are bounded, so a stalled page fails instead of hanging. Set `SMOKE_URL` to test an already running server. Exit codes: 0 ok, 1 failure, 2 no WebGPU adapter. On this machine headless Chromium gets an adapter, so exit 2 has not been observed; its message is `smoke: WebGPU adapter unavailable in headless Chromium (navigator.gpu missing or requestAdapter() returned null)`.

Caveats:

- Headless Chromium here needs `--disable-dawn-features=use_dxc`: without it `requestDevice` fails because `dxcompiler.dll` cannot load (Windows Error 87), so shaders compile through the FXC fallback.
- Headless Chromium may never composite a WebGPU canvas, so `page.screenshot()` is not trusted. The page publishes `window.__murmuration.capture`, which copies the swapchain texture back through the GPU; the smoke reads it for its luminance checks.
- The smoke writes `artifacts/smoke.png`, `artifacts/smoke-zoom.png`, `artifacts/smoke-ships.png` and `artifacts/smoke-kill.png` (the start clear), and `--play` writes `artifacts/smoke-play.png`. `artifacts/` is not committed.
- The smoke runs with `?probe=off&capacity=262144` so the quality probe cannot change the size mid-run, and it never opens the lab panel. The phone checklist for a preview link is in `SMOKE.md`.
- The smoke's start click is the first gesture, so it also checks that the audio unlocks and the sequencer schedules steps. Chromium runs with `--mute-audio`, so the smoke is silent.
- `SMOKE_PORT` overrides the smoke server port (default 5174), for running smokes from parallel checkouts.

## Measured

1,048,576 slots (`?capacity=1048576`), headless Chromium with uncapped frame flags, NVIDIA RTX 4090 (adapter info reports vendor nvidia, architecture lovelace), 1280 by 720 viewport:

| Quantity | Value |
| --- | --- |
| Alive agents when the run stopped (about 90 seconds in) | 921,728 |
| Render frames per second over the last 10 seconds | 224 |

Measured with spaceship glyphs (about 26 device pixel quads at 720p, each fragment evaluating the species distance field and the engine plume); the earlier 4-pixel glyphs ran at 1,393 with 979,039 alive. The rate falls as the ramp fills (1,044 at 145,684 alive, 452 at 434,197, 283 at 724,362). The spawn ramp took 90 seconds (linear) in that run, so the alive count passed 900,000 only near the end of it. The 224 is a render-only rate in headless Chromium, not a gameplay frame rate: it counts animation frames with vsync and the frame rate limit disabled, and the simulation still advances in fixed 1/60 second steps, so about 60 simulation steps per second ran under those frames. Simulation step cost was not measured separately.

The same run held a plateau of 304,727 alive agents from about 10 to 20 seconds. That was a spawn overshoot: read-back stats lag the GPU by several steps (more when one animation frame runs several fixed steps), and the spawner requested the same deficit again on every lagging step, so the alive count overshot the ramping target about twofold and then waited for the target to pass it. SpawnPressure now counts the spawns requested for steps newer than the stats it has seen, and the simulation browser check runs main.js's cadence and fails above 1.05 times the target. The table predates that fix. Reproduce with a script that launches `launchWebGpuBrowser({ measuring: true })` from `tests/browser/launch.mjs`, opens the page with `?capacity=1048576`, and samples `window.__murmuration.frame` and `stats.aliveTotal` every 10 seconds.

Arena mean luminance (Rec. 709 over the arena rect of a captured frame, 0 black to 1 white), 262,144 slots, 1280 by 720, the same machine:

| When | Arena mean luminance |
| --- | --- |
| `npm run smoke -- --frames 300` capture | 0.4758 |
| Full ramp, about 95 seconds in (235,929 alive) | 0.5716 |

Both were measured with ships 0.018 of the arena height long (`shipArenaFraction`, about 13 device pixels here), the attenuation floor at 0.3 and `MAXIMUM_CROWD_RADIANCE` at 0.75. With the floor uncapped the full ramp saturated at 0.80, and lowering `EXPOSURE` to 0.10 left it at 0.80 while dimming kill flashes, so the cap is the lever. The smoke fails above 0.6. Reproduce the full-ramp number with a script that opens the page with `?capacity=262144`, waits about 95 seconds and reads `meanLuminance` from `window.__murmuration.capture()`.

## Tuning notes

- Averaged separation cancels inside a uniform crowd, so the coarse pressure term sets spacing. Lattice with `targetDensity` 24 per coarse cell settles at about 0.05 world units, half the neighbor radius.
- Lattice sheets breathe: an undamped pressure spring against low acceleration. Damping is a lab item for Plan C.
- Brightness: each ship is divided by 1 + 4 times the fraction of its coarse cell that ship bodies cover on screen (`COVERAGE_ATTENUATION` in `glyphs.wgsl`), but not below `ATTENUATION_FLOOR` (0.3), and that floor's summed radiance is capped at `MAXIMUM_CROWD_RADIANCE` (0.75) so a full ramp under trails stays colored instead of saturating. Ship length is `shipArenaFraction` of the arena height (at least 8 device pixels) and grows with the square root of the inspect zoom, so zooming in spreads a crowd apart. The composite tonemaps luminance and keeps hue, so dense cores stay colored instead of white. Trails decay per elapsed time (`trailDecay` is the fraction kept per 1/60 second) and emission is scaled to match, so trail length and brightness do not depend on the refresh rate.
- Straight seek brakes near the player (`ARRIVAL_BRAKING` 0.7 in `steer.wgsl`), so swarms with pressure off collapse onto the player instead of oscillating through it.
- No clumps: pressure only acts above `targetDensity`, so the old targets (30 to 150) left a sparse population (the ramp-up, 6 to 18 per coarse cell) with no pressure; Lattice packed most of its agents near the player. Targets are now 16 to 30 per coarse cell (Chaser 24, Orbiter 18, Skittish 30, Lattice 24, Predator 16 with pressure 0.5). The pressure term is clamped to 2 times `maximumSpeed`, and straight seek fades out inside a 1.0 unit comfort radius so seekers hover instead of piling on the player. The ruling rests on the sparse cases: check (e) in `tests/browser/steer.mjs` gates the share near the player and the peak cell at 13107, 40960 and 262144 agents (uniform seeding, not the spawner's geography). Measured at 13107 agents (ramp start): 12.6 percent within 1 unit of the player, peak cell 9.7 times the population average, 79 percent grouped (in a cell over twice the average); at 40960: 4.6 percent, 3.2 times, 18 percent; at 262144: 2.6 percent, 2.0 times, 0 percent. The ramp-start peak limit is 4 times the highest target, a weaker gate than 4 times the average.
