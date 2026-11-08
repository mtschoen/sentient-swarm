# Murmuration: design

Working title. A murmuration is a starling flock that reads as one animal while every bird follows its own rules. Rename freely; nothing below depends on the name.

Status: working draft, 2026-11-06. This document is scaffolding for the plan and is deleted at branch-finish after durable facts move into README and inline docs.

## Intent

A twin-stick arena shooter in the Geometry Wars mold, built as a browser WebGPU game, where the spin is scale and emergence. The camera sits far out, the arena fills with hundreds of thousands to millions of tiny enemies, and every enemy follows its own small rule set with no coordination. The shapes the player fights, including the rolling mass that behaves like a boss, are what falls out of those rules. The player never fights a "clump"; they kill individuals, lots of them, and the swarm reshapes around the hole.

Why: the owner's favourite moment in Geometry Wars was the green flock that acted like a single entity, got sliced apart by gunfire and smooshed back together. This game makes that moment the whole game, and uses GPU compute to push the count far past anything the original could do. It is also a Fable build benchmark alongside the owner's earlier browser games PolyPhase and Prism Breakout, which is why the deploy story matches theirs.

Feel targets, in the owner's words: jump into the game as fast as possible, a ton of enemies to shoot, flashy neon colors, fun loud techno, and generally shred. Un-tiss music, splash particles, a warp grid that reacts to the game.

## Goals

- Instant start: from page load to shooting enemies in about a second, with no menu in the way on the first run.
- Enemy count as the difficulty axis. Every enemy dies to one hit. Challenge comes only from how many there are and what shapes they form.
- Emergent swarm behaviour rich enough that different species mixes play and look different, with a lab mode that exposes every knob.
- A weapon upgrade system with real contrast: the base gun is humble, upgrades feel spectacular, and losing them stings.
- Reactive arena: the warp grid dents under crowd density and under weapon fire, and the "big fat laser" class of weapon visibly tears it.
- Two first-class targets: a high-end desktop (owner's RTX 4090) where the game goes nuts, and current flagship phones in landscape.
- Shareable: opens from a link on GitHub Pages, no install, hosted pull request previews for phone testing.

## Non-goals

- Portrait phones. The page asks the player to rotate.
- Older phones. WebGPU alone rules out iOS before 26 and Android before 12 or without a recent Qualcomm or ARM GPU. "Most phones" is not promised; "flagship phones from the last two or three years" is the bar.
- Firefox on Android (WebGPU still behind a flag there). Firefox desktop is a nice-to-have.
- Multiplayer, accounts, server-side anything. Leaderboards, if any, are local.
- Migrating code into Liminal or any Unity project. Only ideas migrate.
- Benchmark fairness against the earlier model builds. The owner has declared that a pipe dream.

## Anti-goals (would make this a failure even if it technically works)

- Tanky enemies, health bars, anything that needs two hits.
- A bullet hell where the player dodges patterns instead of carving through mass. The Muse-built Raptor bullet hell was a disappointment; do not drift that way.
- Blobs. If a dense region reads as a smear of color rather than a texture of distinct glyphs, the rendering has failed.
- Enemies that are secretly coordinated (a leader, a shared target, a scripted formation). Shapes must come from local rules only.
- Phone controls bolted on at the end. PolyPhase's phone controls were a slog to retrofit; this game designs for touch from the first commit.
- Swipe or drag gestures, asymmetric tap zones, or anything needing a precise tap on a phone.
- Weapon upgrades that are a mild stat bump. The Geometry Wars upgrades left the owner cold except the big laser; each upgrade here must be visibly, audibly, and grid-distortingly different.

## Constraints

- Platform: browser WebGPU. Plain JavaScript ES modules plus WGSL. No TypeScript, no framework, no game engine. A dev server and a test runner are allowed as dev dependencies; the shipped page is static files.
- The whole simulation stays on the GPU every frame: agents, spatial grid, neighbor queries, bullets, collisions, particles, the warp field. No per-frame readback except a tiny stats or event buffer (kill counts, pickups touched, player hit) read asynchronously with at least a one-frame delay.
- A fixed agent capacity chosen at startup by a GPU probe, with species sharing that capacity by percentage. The game never allocates per enemy on the CPU.
- Per-agent steering work is bounded: the neighbor pass samples at most a fixed number of neighbors per agent (builder picks the cap and the selection strategy, for example the first K in each of the 3x3 cells or a strided sample) so a dense mass costs linear, not quadratic, time. Collision tests against bullets, beams, pickups, and the player stay exact.
- Runtime quality can step down within the allocated capacity (particle budget, bloom, sim rate, alive cap) when sustained frame time exceeds budget, because phones throttle thermally after minutes, and a startup probe cannot see that.
- GPU memory is budgeted up front per preset against the adapter's reported limits (storage buffer binding size, total buffer memory). iOS terminates WebGPU pages under memory pressure, so phone presets stay well below the limits rather than at them.
- Mobile WebGPU limits are designed for, not discovered: at most eight storage buffers per shader stage, so agent data is packed into interleaved 16-byte aligned structs rather than one buffer per attribute (and no `vec3` in storage layouts); workgroup size at most 256 and workgroup memory at most 16 KB; pipelines compiled asynchronously before any timing is trusted; timestamp queries treated as optional.
- Readback uses a ring of at least three staging buffers with sequence numbers, because a buffer whose map is pending cannot be copied into and mobile maps take several frames.
- Bulk counters (kills per frame) are reduced in workgroup memory before one global atomic add per workgroup.
- Trails and bloom render at half resolution, and additive glyph alpha is attenuated by local density so a dense mass reads as bright texture rather than a white smear.
- Thermal headroom: the probe's chosen preset leaves roughly 40 percent of the frame budget free, because phones throttle noticeably after a minute of sustained load.
- Landscape only on phones, using `screen.orientation.lock` where the browser permits and a rotate overlay otherwise.
- Deploy to GitHub Pages from a public GitHub repo, with per-pull-request preview deployments under the same site, following the pattern from the owner's PolyPhase repo (assembly script, `/<repo>/pr-preview/pr-N/`).
- Owner's house rules apply: full-word identifiers, no em-dashes in anything generated, source files under about 500 lines or carrying a one-line note why, no hard-coded machine paths, no wall-clock assertions in tests, no committed logs or raw tool output.

## The game

### Loop

Press start (or just load the page the first time) and you are in the arena. Enemies begin spawning at once and never stop. A run is endless and ends when the player is out of lives. Score is the measure.

- Player ship dies to a single touch from any enemy, Geometry Wars style.
- Three lives and three smart bombs to start. Extra lives and bombs are awarded at score thresholds (builder picks the curve; it should feel like Geometry Wars 1, roughly every 75k then stretching).
- A smart bomb clears every enemy on screen with a full-arena shockwave in the warp grid and a particle flood.
- Kill-streak multiplier: climbs with kills while the player is not hit, in steps (builder picks thresholds), displayed prominently. Resets to 1 on death.
- Spawn pressure ramps with time and score. Pressure means how many agents are alive at once and how fast dead slots refill, up to the capacity.
- Dying drops all weapon upgrades (see Weapons). This is the Beat Hazard rule and it is the main sting of a death besides the multiplier reset.

### Arena and camera

Designer's calls, made in response to the builder check:

- The arena is a bounded 16:9 rectangle, Geometry Wars style, shown in full at all times. The camera does not follow the player. The arena is letterboxed into whatever viewport it gets. On wider phones (20:9 and similar) the side bands are where the touch sticks and HUD live, so thumbs never cover the arena; on desktop the bands hold the HUD.
- Walls are soft for agents (a steering force back inside within a margin, so masses pile against walls rather than clip) and hard for the player and bullets. No wrapping, no toroidal grid.
- Glyph size target: a 4 device-pixel core with a glow about twice that, on both targets. The renderer works in device pixels, not CSS pixels. If a device cannot hold that at its capacity, capacity goes down before glyph size does; the anti-goal is blobs, not low counts.
- "Every enemy on screen" therefore means every alive agent. The smart bomb kills everything alive.
- Spatial grid extent is the arena. Cell size is tied to neighbor radius so a neighbor query reads the 3x3 neighborhood; resolution is a preset value.

### Spawning, death, and survival

Designer's calls, Geometry Wars precedent:

- Agents spawn at a few discrete spawn gates (owner ruling R14, Plan C task C0b2): drifting discs at the arena edges or in the interior, never inside the player's current view-relative safe radius or in the lane the player is aiming down, each emitting its wave with a quiet gap before the next gate's wave, and visible as rings that brighten just before and while they emit. New agents fly in under their own steering at least a quarter of the arena width from the player (farther early in a life); space the player clears is refilled only through the gates. After the first spawn wave of a life, killed agents refill at a fraction of the alive target per second (about 0.15), so a cleared lane stays open for a few seconds. Each spawn has a short spawn-in (about half a second) during which the agent is harmless, cannot be killed, and visibly pulses, which is also the tell that lets the player read where pressure is coming from.
- Contact between any live agent and the player kills the player. The touching agent dies too.
- Player death clears the whole arena (every alive agent dies, with a full particle flood and grid shockwave) and the player respawns at the arena center after a short pause with about two seconds of invulnerability. Spawn pressure resumes from a low value and ramps back.
- Agents die only to player fire, smart bombs, player contact, and the death clear. Species never kill or consume each other; Predators distort other swarms through attraction and repulsion only. The one-hit rule and the no-coordination rule both stand.

### Enemies: species as parameter rows

There is one enemy implementation. Every enemy is a boid with the classic rules (seek the player, cohesion, alignment, separation), plus flee-from-fire, plus an optional preferred orbit radius around the player, plus a row in a species-by-species interaction matrix giving signed attraction or repulsion to neighbors of each other species. A species is a row of those weights plus a glyph, a hue, and a glow profile. Nothing else distinguishes species.

Cohesion and alignment apply only to same-species neighbors. Separation applies to all neighbors. Cross-species influence comes only through the matrix. This keeps populations recognizable (a Lattice sheet stays a sheet when Chasers pour through it) while still letting swarms collide and deform. The neighborhood is part of the behavioral model, not just a performance structure. The lab exposes this as a toggle so the alternative can be compared.

Two ranges of influence (designer's call, from review). At million-agent scale the fine spatial grid's 3x3 neighborhood is under one percent of the arena wide, so agents that only read it are blind beyond a few pixels: a beam cut wider than that would never heal and Predators would never find Chasers. So:

- The fine pass (3x3 cells, capped neighbor sample) computes only separation and same-species alignment. Neighbor contributions are averaged, never summed, so forces do not scale with density and a phone preset and a desktop preset produce the same motion.
- A coarse field, downsampled from the fine grid every frame and blurred, holds one density channel per species plus one threat channel written by weapons (aim cone, projectile trails, beam segment, bomb shockwave). Medium-range cohesion, the interaction matrix, and flee-from-fire all read this field. It is also what the warp grid, the Sidewinders' target search, and the spawner's density bias (new agents join dense masses at the walls, so cleared space stays clear) read.
- Each species row also carries kinematic bounds (top speed, max turn rate) so slow sheets and fast rivers stay visibly different instead of averaging into one disk.
- Each species row carries a comfortable density: a pressure term pushes agents down the density gradient when their surroundings exceed it. The spike showed that pure seek plus local separation collapses a swarm into one overpacked ball like gravity, and that damping seek in crowds freezes everything into static puffballs. Pressure is what lets a river stay a river.

Spike findings (2026-11-06, owner's RTX 4090, headless Chrome): one million agents at about 1.1 ms of GPU time per frame, four million at about 5 ms, no shader or validation errors at any capacity. Additive blending saturates the center to pure white at four million, so tone mapping is required, not optional. Strided neighbor sampling of about 24 per cell kept dense clumps linear.

The spike prototypes the coarse field before the main pipeline is frozen.

Initial species, as the owner and designer imagined them. Treat the names and the intent as given; treat the numbers as a starting point for the lab.

1. Chaser: strong seek, strong cohesion, medium alignment. Forms the river that becomes the rolling meta-boss.
2. Orbiter: medium seek, holds a preferred radius around the player, strong alignment. Forms rings that tighten.
3. Skittish: medium seek, strong cohesion, very strong flee from fire. The player's gun herds them; they regroup elsewhere.
4. Lattice: weak seek, very strong separation at a fixed spacing, strong alignment, low top speed. Drifting crystalline sheets the player shoots lanes through.
5. Predator: weak seek toward the player, strongly attracted to Chasers and Skittish in the matrix, repelled by Lattice. Swarms that collide with and distort other swarms.

Spawning assigns new agents to species by the current share percentages. The default game mix and the pressure curve over time are the designer's job during the lab phase, not fixed here. Species mixes may change over a run (for example a Predator share that grows after a score threshold) to keep shapes evolving.

A throwaway spike (`~/murmuration-spike`, built alongside this document) explores which mixes produce interesting shapes. Its findings feed the default presets; its code is not reused.

### Lab mode

A mode reachable from the menu, modelled on PolyPhase's fusion mode where the owner could play with different shape-count mixes. It exposes:

- Agent capacity (within what the probe allows) and current alive count.
- Per-species share slider and every rule weight listed above.
- The interaction matrix.
- Neighbor radius, grid resolution, sim rate (full or half with interpolation).
- Presets: bundled ones, save to local storage, and export to the URL hash so a mix can be shared as a link.
- A toggle to play with weapons on, or to just watch and steer the player point with the swarm chasing it.

Lab mode is a real shipped mode, not a debug build. It is also how the designer finds the fun.

### Weapons

Design principle: because every enemy dies to one hit and there are hundreds of thousands of them, weapon power is area covered per second and how it shapes the swarm, not damage. Every weapon has a distinct silhouette of fire, a distinct sound, and a distinct signature on the warp grid.

Base gun: a modest forward spread, always available, never upgraded. It is deliberately humble, roughly a quarter of the clearing rate of a tier-one upgrade (builder tunes), so that the upgraded state is the treat and losing it is felt.

Upgrades: five types. Each has three tiers.

- Beam: the big fat laser. Continuous, pierces everything along its line, the heaviest grid distortion in the game, a trench that heals behind it. Higher tiers widen it and add a secondary ripple.
- Scatter: a wide arc of energy balls as big and long-lived as the base gun's, a shotgun wall (owner ruling R32: a pickup is never a power-down). Shoves the grid outward in a cone. Tiers add balls to the arc.
- Rail: narrow, very fast, long range, pierces. Thin streaks on the grid. Tiers add parallel bolts.
- Pulse: slow large orbs that detonate into expanding rings on contact or at range. Ripples on the grid. Tiers add orb count and ring radius.
- Sidewinders: homing missiles that weave toward the densest nearby cluster (the grid count buffer tells them where). Wiggly dimples on the grid. Tiers add missile count and turn rate.

Acquisition and decay, as the designer's call unless the owner objects:

- Upgrade pickups appear in the arena, dropped from the swarm on kill-streak milestones and occasionally from very dense kills, and are collected by touching them. Pickups are typed and visibly so.
- Collecting a type arms it with a charge meter that drains while firing. The meter is drawn as a ring around the ship so the player always knows how much upgrade is left.
- Collecting the same type while it is armed raises the tier (up to three) and refills the charge.
- Collecting a different type swaps to it (one upgrade at a time). Swapping keeps the current tier minus one (never below tier one) and refills the charge, so a pickup is never a landmine; the only way to lose everything is the charge running out or dying. The arena offers one pickup type at a time and rotates it slowly, so building to tier three is reachable with ordinary aim rather than a lucky one-in-five.
- While an upgrade is armed, it replaces the base gun's fire entirely, so each weapon's silhouette stays clean.
- Untouched pickups fade out after about ten seconds.
- When the charge empties, the player drops back to the base gun. This is the "sad when it goes away" moment and it should be scored by the music and the visuals.
- Death drops the upgrade entirely.

The "layers" the owner asked for come from the type by tier matrix plus the charge ring: there is always a better state to reach and a worse state looming.

Recovery guard (designer's call, from review): upgrades generate the streaks and dense kills that generate more upgrades, so a player who loses one can be least able to earn the next exactly when pressure is highest. Two rules prevent the trap. First, pickup income is not purely kill-driven: while the player is on the base gun, a pickup is guaranteed to spawn within a bounded time (builder tunes, on the order of ten seconds) regardless of kills, placed away from the densest mass. Second, the base gun is tuned so that it can always open an escape lane through a Chaser river at default pressure; "humble" means slow to clear, never unable to move.

### Event ordering and authority

Observable outcomes when things coincide, so that implementation details never decide them:

- Within a frame, in order: player input (including a bomb press) is applied first; a bomb kills everything alive before any contact test runs. Then pickups touched this frame are collected and applied. Then bullet and beam kills. Then player contact: if any live agent touches the player, the player dies this frame and the whole arena clears. Charge expiry is evaluated last; a pickup collected in the same frame as expiry wins.
- Every GPU event (kills by species, pickups collected, player hit) carries the frame sequence number it happened in. The CPU ignores events whose sequence number predates the current respawn, so a death reported late cannot kill a freshly respawned player.
- A GPU-side latch prevents a second player-death event until the CPU acknowledges the first. Readback never blocks the frame loop; several staging buffers rotate and results may arrive more than one frame late.

### First-run entry

- Landscape check first: in portrait the rotate overlay shows and nothing else happens.
- One tap or click or button press starts the game. This gesture is required anyway to unlock audio on phones, so "instant start" means exactly one input, not zero.
- Danger and scoring begin with the first spawn wave, half a second after start, while the music comes up. The probe runs underneath real play as described in Settings.
- Controls are live from the first frame; touch sticks appear where the thumbs land.

### Controls

- Gamepad: left stick move, right stick aim and fire (fire whenever aiming), face button or trigger for bomb.
- Mouse and keyboard: WASD or arrows move, mouse aims, left button fires (with an auto-fire option that fires whenever the mouse moves or is held), space or right button bombs.
- Touch: floating dual virtual sticks. Left half of the screen moves, right half aims, firing is automatic while the right thumb is down. A dedicated bomb button sits in a corner away from both thumbs. No swipes, no gestures, no precise taps during play. Dead zones and stick sizing are settings.
- Pause on focus loss and on the Escape key or a pause button.

### Settings and presets

Instant start wins over the probe. On first load the game starts immediately at a conservative preset keyed only to coarse adapter facts (device type, adapter limits). During the first seconds of real play it measures frame time with GPU timestamps where available and frame timing otherwise, then steps the preset up (or down) to the highest level that holds the frame budget. Stepping reallocates the agent buffers at a frame boundary and copies live agents across in a compute pass, so capacity can change without a restart. The result is persisted and later loads start at it; the probe re-runs only when the adapter changes or the player asks. A preset is: agent capacity, particle budget, grid resolution, bloom quality, and sim rate (full, or half with interpolated rendering). The preset is shown and editable in Settings.

Following PolyPhase's calibrated-slider pattern: effect sliders read 100 percent at the tuned default and can be pushed past it. Reduced motion is opt-in and defaults off (Windows reports `prefers-reduced-motion` spuriously when animation effects are disabled; see the owner's gotcha note). Music and effects volume are separate.

Gameplay does not depend on capacity. The swarm must feel the same on a phone at a few hundred thousand agents and on the desktop in the millions; only density differs. The invariants across presets are: the fraction of the arena a Chaser river occupies at a given pressure, the width of the escape lane the base gun opens (as a fraction of screen), pickup income per minute, and survival difficulty (time to first death for a given skill). Score thresholds, spawn pressure as a fraction of capacity, and weapon clearing rates as a fraction of the screen are all expressed relative to capacity so these stay comparable. Score itself is normalized so that a kill at low capacity is worth proportionally more.

### Visuals

Neon on black, additive glow. Specifically:

- Each species is a distinct glyph (triangle, diamond, cross, chevron, pentagon outline, builder picks) drawn as an instanced quad with a signed-distance or textured shape, rotated to face velocity, with per-agent hue jitter, spin, and pulse phase so dense regions read as texture, never as a smear.
- Bloom via render-to-texture and a half-resolution blur pass. Trails via a feedback buffer with decay.
- Splash particles on every kill, GPU-side, budgeted by the preset. Kills of many agents at once produce proportionally bigger splashes.
- The warp grid: a displaced line grid driven by a field that sums crowd density (reusing the spatial grid's count buffer) with weapon impulses (beam trench, pulse ripples, bomb shockwave). A forming mass dents the floor before the player looks at it.
- Zoom is fixed in play (far out, "Geometry Wars zoomed out 100x"), adjustable in lab mode.

### Audio

Designer's call unless the owner objects: procedural four-on-the-floor techno generated in Web Audio (kick, hats, bass, a lead), with intensity (layers, filter opening, tempo within a narrow band) driven by the kill-streak multiplier and alive density. Weapon pickups and upgrade expiry are scored (a riser on pickup, a drop-out on expiry). Sound effects are synthesized, with one voice per weapon type and layered splash sounds that scale with kill count. Beat Hazard is an inspiration for music driving intensity, but here the music follows the game rather than the game following a song. A light touch is allowed, such as muzzle flashes and bloom pulsing on the beat, as long as it never changes gameplay.

Procedural audio avoids licensing and keeps the deploy static. If the owner later supplies tracks, the intensity model should accept them.

## How it is built: decided

- Repo `~/murmuration`, public on GitHub under the owner's account, GitHub Pages from main, pull request preview deployments.
- Plain JavaScript ES modules and WGSL files. A dev server for local work (Vite is acceptable, as in PolyPhase, or any static server). No bundler is required for the shipped page; if one is used it must be optional.
- GPU pipeline per frame: clear grid counts, count agents per cell, prefix sum, scatter agents into sorted order, neighbor pass (boid forces plus species matrix plus flee), integrate, bullet step (bullets are GPU entities with their own buffer), bullet-agent collision via the grid (an agent dies if a bullet or beam segment is within its radius; beams are segments tested per cell), pickup and player collision, particle step, warp field update, then render passes (grid, trails, agents, bullets, particles, bloom, composite, UI).
- Agent lifecycle is a dead flag plus a GPU free-list or compaction, so spawning never touches the CPU. The spawner writes a small per-frame spawn request (count per species) into a uniform.
- Stats readback (kills by species, pickups collected, player hit, agents alive) through a small buffer mapped asynchronously with a one-frame delay. Score, lives, multiplier, and weapon state live on the CPU and are derived from those events.
- Tests: CPU-side logic (spawner shares, score and multiplier, weapon tiers and charge, preset selection from probe results, settings persistence) under a node test runner with injected time. WGSL compilation and a short smoke run (load page, run N frames, assert no console errors and a frame-time ceiling) under a browser automation harness in CI where a GPU is available, and locally otherwise. Pull request previews are the phone test surface; the owner tests on a physical foldable Android and this time on an iPhone running Safari as well.
- Hosted previews over local setup for the owner's testing. Each pull request body starts with a problem statement.
- Reference material the builder may read: the owner's PolyPhase repo at `~/polyphase` (Pages assembly script, preview workflow, mobile smoke tests, calibrated sliders) and the throwaway spike at `~/murmuration-spike` (grid and species shader structure). Read for patterns; do not copy either wholesale.

## Left to the builder

- All numbers: rule weights, species shares and pressure curve, weapon rates and tiers, score thresholds, multiplier steps, particle budgets, bloom parameters, probe thresholds for presets.
- Glyph shapes, palette, typography, menu and settings layout, HUD layout (score, multiplier, lives, bombs, charge ring).
- Shader organisation, workgroup sizes, prefix-sum structure, buffer layouts, how beams are tested against the grid, how the free-list works.
- Dev server, test runner, CI workflow details, the Pages assembly script.
- Procedural music design within the constraints above.
- The exact probe method and how presets are keyed to it.

## Open until the spike reports

- Which species mixes produce the most interesting shapes, and whether five species is the right number to ship with.
- Agent counts actually reached at 60 fps on the owner's desktop and what the phone budget looks like.
- Whether half-rate simulation with interpolation is needed on phones.

## Prior art consulted

- Geometry Wars: Retro Evolved (the feel, the grid, the green flock, the big laser).
- Beat Hazard (upgrades lost on death, music-driven intensity, Ultra's missile pickups).
- Blids by Chris Benjaminsen: dependency-free WebGPU flocking at up to four million agents using a counting-sort grid, the reference for the sim core's structure.
- Particle Life (Ventrella's Clusters lineage): the species interaction matrix.
- PolyPhase and Prism Breakout: the owner's earlier browser games, source of the calibrated-slider settings pattern, the Pages preview workflow, and the phone-controls lessons.
