# Swarm weapons: one projectile per ship, and the beam as a special occasion

Design exploration, 2026-11-13. No code was changed. All numbers marked "(unmeasured)" are my estimates, not benchmarks.

## 1. Problem and goals

The player is now a swarm of 12 to 256 ships. Today's fire (`src/game/swarm-fire.js`) copies the whole armed volley (a fan, a triple, ...) from each ship at quarter radius, under a token bucket. The owner finds that reads as a coherent wave, not as ships shooting. Firepower for small swarms also roughly doubled when every ship became able to fire, and the beam is already considered too strong.

Goals:
1. The unit of fire is a ship: one projectile per ship per shot, along that ship's real heading.
2. Firepower is not trivial at 12 ships and not absurd at 256, and stays inside the 8192-slot pool and the per-update spawn caps.
3. The beam becomes a rare event with a clear visual identity at both 12 and 256 ships.
4. Keep the owner's constraints: ships do not fire in all directions and do not all face one way (heading stays within about 31 degrees of the aim, spread by course), no new runtime dependencies, mobile WebGPU limits (AGENTS.md), full-word identifiers, no em-dashes.

## 2. Current system (brief)

- Volley origin: `WeaponState.update` (`src/game/weapons.js`) fires the armed weapon's volley from the controlled point: `#appendShot` builds `projectilesPerShot` projectiles fanned over `spreadRadians` (tier tables in `src/game/weaponTypes.js`). Rail pickups add turrets (`railTurrets` up to 12, 30 degrees apart around the rear of the aim) on their own accumulator.
- Distribution: `SwarmFire.distribute` captures the newest volley as a template (`captureTemplate`), then each ship inside `SWARM_FIRE_CONE_RADIANS` (35 degrees) and off cooldown (interval times jitter 0.8 to 1.2) appends a quarter-radius copy of the entire template (`appendVolley`). A token bucket (`SWARM_MAXIMUM_VOLLEYS_PER_INTERVAL` = 12.8 per fire interval, burst 4) caps volleys; `MAXIMUM_SWARM_SPAWNS_PER_UPDATE` = 512 is a backstop. Turret volleys fire once from a ship in rotation. The beam is `fire.beam` moved to the centroid.
- Heading: `faceStep` in `src/game/swarm-facing.js` turns each ship's heading (270 degrees per second maximum) toward `facingFor(course, aim)`, which squeezes all courses into 90 percent of the 35 degree cone.
- Today's rough numbers (my arithmetic from the constants): base gun is 3 balls per 0.12 s. At 12 ships every ship is nearly always ready, so about 12 / 0.12 = 100 volleys per second, just under the bucket's 12.8 / 0.12 = 107, giving about 300 balls per second at radius 0.05 (swept width 0.1 each, about 30 width-units per second). The old single ship was 25 balls per second at radius 0.2, about 10 width-units per second. So 12 ships today are about 3x the old ship, which matches "roughly doubled" plus the earlier 3.2x target for 64 ships.
- GPU: `Projectiles` (`src/game/projectiles.js`) is a ring of 8192 48-byte slots, slot 0 reserved for the beam, round-robin assignment (`ProjectileSlots.next`), which silently overwrites a still-alive slot when the cursor wraps. `projectiles_collide.wgsl` entry `main` runs one thread per slot and walks the capsule `previousPosition` to `position` with at most `CAPSULE_CELL_BUDGET` = 96 cells. Entry `rings` handles pulse rings (about 9 alive by design, `MAXIMUM_LISTED_RINGS` = 256, `RING_CELL_BUDGET` = 1024 each). Entry `beam` is dispatched as ONE workgroup of 256 threads: it builds the swept sector (`beamSector`, previous direction in the slot's `seed` and `extra`, reach scale in `lifetime`) and the threads walk the bounding box cells interleaved, `BEAM_CELL_BUDGET` = 256 collided cells per thread.
- The step shader (`projectiles_step.wgsl`) skips the beam slot and integrates everything else `position += velocity * dt`, setting `previousPosition` first.

Not verified in code: whether the beam entry reads `previousPosition` or the slot's `flags` bits beyond ALIVE (I saw `beamSector(projectile)` consume `position`, `velocity`, `seed`, `extra`, `lifetime`, `radius`); the render shader's handling of any new kind; actual frame cost of any option below.

## 3. Topic A: one projectile per ship

### 3.1 The unit of fire

A "shot" is now: one ship, one projectile (or one small fixed bundle for the weapons where the bundle is the identity), spawned at the ship's position along `ship.heading`, with per-kind jitter. The weapon's `fireInterval` stops being a per-ship cooldown and becomes a swarm-wide tempo that is converted into a per-ship interval (3.3).

Options for what a tier means:

| Option | Tier means | Pro | Con |
|---|---|---|---|
| A1 Count | Tier N fires N projectiles per ship (a tight burst) | Keeps current table semantics, easy to read | Breaks "one projectile per ship" at T2 and T3; spawn volume triples |
| A2 Size and pierce | Tier raises radius, lifetime, kill budget | One projectile stays one projectile; cheap on the pool | Less visible variety; radius is already large (0.2 base) |
| A3 Rate | Tier shortens the per-ship interval | Trivial to implement | Reads as "same gun, faster"; pool pressure |
| A4 Per-kind meaning (recommended) | Each weapon chooses the axis that is its identity | Tiers feel different per weapon; pool use predictable | More tuning than a uniform rule |

### 3.2 Per weapon (recommended A4)

Base gun (tier 1 only): one energy ball per ship shot, radius 0.10 (the quarter-size 0.05 was a stand-in; now the ball is the ship's only shot), speed 10, lifetime 2 s (3 s today is for a fan that must reach the walls; per-ship streams do not need it), pierce as today. Per-ship angular jitter plus or minus 2 degrees so a ship's own stream is not a perfect line.

Scatter (tiers 1, 2, 3 = 9, 13, 17 pellets today): the fan is now emergent from many ships plus jitter, so tier means (a) pellets per ship shot 1, 2, 3 in a tight 0.25 radian fan, and (b) random extra angle jitter of plus or minus 10, 16, 22 degrees on top of the heading. Radius 0.07, lifetime 1.2 s (a short-range shotgun), per-ship rate 1.6x the base rate. Total swept width rises about 1x, 1.4x, 1.9x across tiers, matching today's 9 : 13 : 17 ratio.

Rail kind (tiers 1, 2, 3 = 1, 2, 3 parallel needles at 0.15 offset): rail is no longer an armed weapon (R29), only turrets, see 3.4. The `rail` projectile kind stays: speed 40, radius 0.05, lifetime 0.6, pierce.

Pulse (orb that detonates into a ring when local density exceeds 40 or lifetime ends): one orb per ship shot, but pulse is the one weapon where the aggregate is capped hard, because each detonation is a ring that costs real GPU time (`rings` entry, up to 1024 cells per ring; the doc comment in the shader says about 9 rings alive by design). Tiers 1, 2, 3 raise the ring's reach (orb `extra` density threshold stays, ring growth lifetime scaled 1.0, 1.25, 1.5) rather than orb count. Aggregate cap: 3.3 orbs per second at tier 1, 5 at tier 2, 6.7 at tier 3 (today's 1, 2, 3 orbs per 0.3 s), independent of swarm size, served in rotation across ships.

Sidewinders (2, 4, 6 missiles per shot, each detonates on its first kill into a half-size ring): one missile per ship shot, same aggregate-cap logic as pulse (each kill spawns a ring through the slot rewrite in `main`). Tiers raise aggregate missile rate 8, 16, 24 per second (today 2, 4, 6 per 0.25 s) and homing strength (`extra` 5, 7, 9). Rings per second are bounded by kill events, so also add a ring-alive guard (3.5).

Not verified: actual ring cost when 20 or more rings are alive; the shader comments say 9 is the design point. The pulse and sidewinder caps above are chosen to keep that bound and should be validated with the existing worst-frame measurement approach noted in `projectiles.js` (the 0.35 ms at 262144 agents note).

### 3.3 Scaling from 12 to 256 ships

Replace the token bucket with an aggregate rate law. For weapon kind k with base aggregate rate `baseShotsPerSecond[k]` (from the old fireInterval and tier) and swarm size N:

    aggregateShotsPerSecond = baseShotsPerSecond * (N / 12) ^ exponent[k]
    perShipInterval = N / aggregateShotsPerSecond      (then times the existing 0.8 to 1.2 jitter)

Exponent per kind: base 0.4, scatter 0.4, rail turrets 0.3, pulse 0, sidewinders 0. With exponent 0.4, 256 ships fire (256/12)^0.4 = 3.4x the aggregate of 12 ships, not 21x. Swept width per second for the base gun (radius 0.10, so 0.2 wide per ball):

| Ships | Aggregate shots per second | Per-ship interval | Width-units per second | Versus old single ship (10) | Live balls at 2 s lifetime |
|---|---|---|---|---|---|
| 12 | 65 | 0.18 s | 13 | 1.3x | 130 |
| 64 | 125 | 0.51 s | 25 | 2.5x | 250 |
| 128 | 165 | 0.78 s | 33 | 3.3x | 330 |
| 256 | 220 | 1.16 s | 44 | 4.4x | 440 |

This cuts the 12-ship firepower from about 30 (today) to 13 width-units, answering the "doubled" complaint, and tops out at about the earlier 3.2x target at 128 ships and 4.4x at 256 (the extra 20 percent at 256 is deliberate: each added ship should still feel like it matters). One exponent per kind is the single balance knob, exposed as a lab knob. Why sublinear: a linear law makes 256 ships 21x the 12-ship firepower and pool usage; a flat law makes growth feel pointless. Growth also pays through width of coverage (more ships means more distinct lanes across the cone, which is real value even at fixed aggregate).

Per-ship interval at 256 is over one second, so a ship fires rarely. To keep the swarm feeling alive, each ship's first shot after the cone opens is phased by `slotHash` as today, so shots are a continuous drizzle (about 220 per second over 256 ships) rather than a pulse.

### 3.4 Rail turrets

Today: turrets are abstract emitters fired in rotation from one ship, at angles around the rear of the aim. Options:

- T1 Keep abstract (cheapest, step 1). The turret volley fires from a ship picked in rotation, position from that ship, direction fixed by the turret offset. Reads as ships firing backwards and sideways, which the owner disliked earlier (no all-directions fire), but turrets were an explicit ruling (R29) so it is existing behavior.
- T2 Gunner ships (recommended later step): each rail pickup marks one ship as a gunner (drawn with a tick ring). A gunner holds station on the leash circle at its turret angle and points outward along it (heading overridden to the turret offset), firing one needle per rail interval. 12 gunners make an outward-facing escort ring. It is visibly "that ship shoots that way", needs a station-keeping term in `swarm-flocking.js` and an exemption in `faceStep`, and gunners are real ships that can be hit (the pickup is then a liability worth reading: losing a gunner drops a turret). If a gunner dies its turret passes to another ship.
- T3 Rail needles fired by the whole swarm along headings (rail as a weapon again). Rejected: contradicts R29.

Turret aggregate rate follows exponent 0.3 on the number of gunners only if gunners exceed ship count; otherwise gunners each fire at the rail tier interval (0.3 s, needle count per tier 1, 2, 3 as today). With 12 gunners that is 40 to 120 needles per second, each short lived (0.6 s), so about 24 to 72 slots live.

### 3.5 Pool and spawn caps

Budget: reserve 4096 of the 8192 slots for swarm fire (the rest for gunners, rings, and slack). A CPU-side `FireBudget` keeps a ring buffer of spawn times (one entry per spawn, expire after the kind's lifetime) and counts estimated live projectiles. If a shot would push the estimate past the cap it is skipped (cheap, no slot overwrite). Max estimated live today by weapon at 256 ships: base 440, scatter at tier 3 (3 pellets, 1.2 s, rate 1.6x, so about 220 x 1.6 x 3 x 1.2 = 1270), turrets 72, pulse and sidewinder rings 9 to 20. All far below 4096, so the cap is a safety net, not a throttle, which is the point.

Spawn caps: `MAXIMUM_SWARM_SPAWNS_PER_UPDATE` = 512 stays a backstop. Typical per-update spawn counts at a 60 Hz step: 220 per second / 60 = 4 at 256 ships, up to about 30 for scatter tier 3. The 8-volley `MAXIMUM_SHOTS_PER_UPDATE` in `WeaponState` no longer constrains swarm fire because swarm fire does not use the volley accumulator.

What replaces the template and token machinery: `captureTemplate`, `appendVolley`, `tokens`, `SWARM_VOLLEY_BURST`, `SWARM_MAXIMUM_VOLLEYS_PER_INTERVAL`, the quarter-radius scale. `WeaponState` becomes a tier and charge holder that also exposes a `shotRecipe(kind, tier)` (per-ship pattern, radius, speed, lifetime, jitter, aggregate rate, exponent). `SwarmFire` keeps: cone test, per-slot cooldown and phase, rotation fairness.

Cooldown note: because the cone test uses each ship's `heading` and `faceStep` already guarantees ships on any course can fire after turning, no change to facing is needed for A.

## 4. Topic B: the beam

Context in code: one beam slot, a single workgroup, `BEAM_CELL_BUDGET` 256 per thread (65536 collided cells), sector swept between steps, reach scale in `lifetime`. Armed beam charge is 8 s per pickup (drains only while firing), tiers radius 0.12, 0.2, 0.3, turn rate limited to 1.5 revolutions per second (`beamTurnRevolutionsPerSecond`). Beam pickup is slot 1 of the 6-slot 20 s rotation.

### Option P: Pooled beam ("convergence")

Ships pool into the single existing beam. While the beam is armed and fire is held, ships stop firing their own projectiles ("channeling"). Contributors are ships inside the fire cone and within a pool radius (3 units) of the centroid. Beam half width = `perShipWidth * sqrt(contributors)` capped by the tier (tier caps 0.3, 0.45, 0.6), with `perShipWidth` = 0.12 / sqrt(12) = 0.035, so 12 ships give 0.12 (today's tier 1), 64 give 0.28, and 256 hits the cap. Beam origin is the contributor centroid; direction is the aim (turn limited as today). Beam needs a minimum of 4 contributors and builds over a 0.6 s ramp (width from 0 to full as contributors align), so it is never instant.

- GPU cost: none. Same slot, same dispatch, one more float in the CPU write. Cheapest of all options.
- Visual: 12 ships: a thin beam with 12 thin tether lines (drawn by the swarm renderer, no GPU projectile cost) to the origin; the beam reads as "they are all feeding it". 256 ships: the beam is thick and tethers become a bright fan, so cap tether drawing to the 32 ships nearest the axis or the visual becomes a white wash.
- Special occasion: strong, and it is the owner's own idea. Losing ships thins the beam in real time, a natural counterplay. Rarity is separate (4.2).
- Con: it is still "the old beam", just wired differently. If the 8 s charge stays and the beam stays in the rotation it does not feel more special by itself.

### Option S: Scythes (per-ship melee blades)

Each ship carries a blade of fixed length 4 world units (a quarter of the 16 unit world width; a quarter of the 9 unit height would be 2.25, so "a quarter of a screen" is ambiguous and flagged as an owner call) along its heading, half width 0.05, 0.08, 0.12 by tier, alive only while fire is held. Collision needs the swept sector, not a line: a ship turning at 270 degrees per second moves its blade tip about 0.31 units per 60 Hz step, far more than the reach, so a capsule per step leaves gaps.

GPU implementations:
- S1 Capsule per blade: reuse entry `main` (one thread per slot). Gaps from the turn (above) and the 96 cell budget (a 4 unit blade crosses 40 to 50 columns at cell size 0.08 to 0.1, times 3 rows, over budget). Needs splitting each blade into 4 sub-capsules (4 slots per ship, 1024 slots at 256 ships, rewritten every update) and still leaves turn gaps. Not recommended.
- S2 Sector per blade (recommended if scythes are built): generalize entry `beam` to `blades`, dispatched with one workgroup per ship (256 workgroups at most), each reading its blade from a reserved slot range `1 .. 256` and running the same `beamSector` plus `collideSector` code with a fixed reach limit. Slot struct has no field for an absolute length; the beam uses `lifetime` as a scale of the edge distance. Options: put the length in `previousPosition.x` (unverified whether the beam path reads it), or add a new `kind` (scythe) whose reach limit is `extra`-independent via a constant (4.0) substituted into the shader (cleanest, one constant, no data field). Bounding box of a 4 unit wedge is up to about 16 square units, about 1600 cells at cell size 0.1, spread over 256 threads is about 6 cells per thread per blade (unmeasured). Cost scales with blade count times agents per cell: worst case 256 blades x 1600 cells x about 36 agents per cell (500k agents over 14400 cells) is about 15 million distance tests per step (unmeasured, an estimate to check with the existing worst-frame measurement approach).
- Pool: with S2 blades live in slots 1 to 256 only while fire is held (zero-filled on release, as the beam does with `beamWritten`); `ProjectileSlots` starts the round-robin cursor at 257. Render: new kind in `projectiles.wgsl` drawn as a crescent or straight blade along heading; one instance per ship slot.

Visual and feel: 12 ships: 12 spokes in a forward fan, readable, a mid-range slicer with reach about 4 units around the swarm. 256 ships: a solid wedge of overlapping blades; every enemy within 4 units of any ship dies, so it becomes a vacuum cleaner and is OP at high N unless limited. Limits: blades are active only in the aim cone (already true via heading), plus a global cap of 64 active blades (ships nearest the aim), which also bounds the dispatch to 64 workgroups.
- Special occasion: scythes are a short-range risk weapon (ships must fly into the swarm and can be hit; contact kills ships via `player_collide.wgsl`), which is a counterweight rather than rarity. It does not by itself make the beam rare, but it is a good different weapon.

### Option W: Web (tethers between neighboring ships)

Instead of a beam, ships link to their nearest neighbor with a thin kill line. CPU computes nearest-neighbor pairs (N up to 256, O(N squared) is 65k checks, fine, or a grid), writes one projectile per ship with `previousPosition` = ship A and `position` = ship B. The existing capsule path (entry `main`) kills along it with reach about 0.03, at no new GPU code except a new kind that the step shader skips (like the beam today) so it is not integrated. Leashed ships sit within about 1 to 2 units, so a link is 10 to 25 cells, inside the 96 budget.
- Pro: very cheap, genuinely new, scales visually (12 ships: a sparse net; 256: a dense mesh drawn as bright lace), and rewards flying the swarm through the enemy. Pairs with the owner's "ships combine their beams" instinct.
- Con: area denial around the swarm, not a directed attack; the aim barely matters; kills near the swarm, where the enemies already hit the ships. Needs the contact pass to still hit ships, so it is risky play (good). Length of links is bounded by the leash, so it cannot be a screen-length laser.
- Special occasion: strong if it replaces the beam (a different verb, "spread out and weave"), which is the owner's "special occasion" in spirit.

### Option T: Thread lasers (capped narrow per-ship beams)

The owner's "narrow lasers per ship" with a cap: only the K ships nearest the aim axis (K = 4, 8, 16 by tier) emit a full-length thin beam (half width 0.03). GPU: same generalization as S2 (one workgroup per beam, `blades` entry) with a length of arena edge (up to about 18 units); cost about 4x a scythe per active beam, so K = 16 is the practical ceiling (unmeasured: 16 workgroups each about 6000 cells). Visual at 12: 4 thin lines, elegant. At 256: still K = 16 lines, so the beam does not scale with swarm size, which is a flaw (growth does nothing for the weapon). Rarity via charge as in 4.2. Verdict: viable but strictly worse than P (more GPU work, no scaling).

### Comparison

| | GPU change | Scales 12 to 256 | Reads at 12 | Reads at 256 | Rare by nature |
|---|---|---|---|---|---|
| P pooled | None (beam slot) | Yes (width, sqrt) | Good | Good if tethers capped | No, needs a meter |
| S scythes (S2) | New entry (workgroup per ship), new kind | Linear, needs a cap | Good | Can wash out, cap at 64 | Partly (risk) |
| W web | New kind, skip-in-step | Yes (mesh density) | Sparse but fine | Great | Partly (positioning) |
| T thread lasers | Same as S2, longer | No (K capped) | Good | Same as 12 | No |

### 4.2 Keeping the beam rare (applies to P, and to W or T if chosen)

- R1 Earned meter (recommended): remove the beam from the 20 s pickup rotation. A "convergence meter" fills from scored kills (for example 1.0 per 600 normalized kill credit; the `ScoreKeeper` already normalizes by capacity). When full, a ring around the swarm pulses and the beam is available on press (hold fire plus a button, or the next fire). Duration 5 s, then the meter empties. About one beam per 60 to 90 seconds of strong play. No pickup, so it cannot be farmed from pickup luck, and it rewards kill rate.
- R2 Rare pickup: keep the pickup but only as a milestone spawn (the director already has milestone spawns, `PickupDirector.update`), and remove it from the rotation and from pity spawns. Simplest to implement (edit `PICKUP_TYPE_NAMES`, add a milestone-only slot), but luck-driven.
- R3 Sacrifice: the beam costs ships (each second of beam sacrifices 1 of the contributing ships, burned as fuel). Dramatic and self-balancing against the large swarm, but punishes growth the player just earned and fights the "one ship per 100 kills" reward loop.
- R4 Charge in formation: beam needs the swarm to hold a rank line for 1.5 s before it fires (the 0.6 s ramp in P becomes 1.5 s plus a visible formation); a vulnerable moment is the price.

The 8 s charge of today becomes 5 s with R1, and the beam half width is the tier cap, so tiers (from pickups) are replaced by a single beam whose width scales with contributors.

## 5. Prior art (mechanics only)

I searched three queries; the results were thin and mostly storefront pages, so I did not read any game's full design. Claims below are limited to what the result snippets say.

- Fleet-control shooters exist: Shoot 1UP DX is described as letting the player control a whole fleet of up to 30 ships. Asterboid (swarm of asteroids following the player, some can be ordered to shoot out) shows a cursor-ordered swarm that attacks. "Swarm: Fight for Freedom" shows a drone swarm with a single controlled ship. I did not verify how these distribute fire per ship. This supports the premise (fleet of emitters) but not any specific number.
- Converging beams: a TV Tropes page lists games where several small beams merge into one stronger beam (Cosmoteer's ion beams merged by aiming at a prism, with a small damage penalty; Battlevoid: Harbinger's Death Ray modules). A Positech forum thread discusses a prism that fires merged beams, and a proposal where reinforcing beams stack up to a maximum of 4 before releasing a very powerful beam. This is the closest prior art to Option P (cap on contributors, damage penalty for pooling, release after build-up). Nirengeki: Double Strike (shmup) combines a drone and a gunship into a laser between them.
- Shmup pool and caps: the Shmups Wiki guide (CAVE-style) says player shots should not have massive gaps or dead zones, relevant to why scythe sweeps need a sector, not a per-step line; Luna Abyss's developer article describes pooled bullets sized per encounter, which parallels the 4096-slot swarm budget; a design critique notes that many power-ups can bury readability, which supports capping beam tethers and scythe counts.
- I found no source for per-emitter power scaling formulas (the exponent law in 3.3 is my own design, not from prior art).

## 6. Recommendation (one coherent proposal, incremental steps)

Pick: A4 per-kind shots with an aggregate exponent law, Option P (pooled beam) with R1 (earned meter), gunner ships for rail turrets later, and the scythe as an optional new weapon only after the owner decides.

Steps, each leaves the game playable and is covered by pure-JS tests where possible:

1. Rate law and one-projectile base gun. New `src/game/swarm-fire-rate.js` (pure): aggregate and per-ship interval from kind, tier, N, exponent. `SwarmFire.fireShips` spawns one projectile per ship (base gun only, others fall back to the old template path temporarily). Remove tokens. Add a `FireBudget` (live-estimate cap 4096). Lab knob for the exponent.
2. Per-kind recipes for scatter, pulse, sidewinders: `shotRecipe` in `weapons.js`/`weaponTypes.js`, tier meaning per 3.2, aggregate caps for pulse and sidewinders. Delete `captureTemplate`, `appendVolley`, the volley constants. Update `tests/game` for swarm-fire and weapons.
3. Beam as P. `SwarmFire` computes contributors and `halfWidth`; ramp and minimum contributors; ships stop firing projectiles while channeling. Renderer draws capped tethers (`src/render/swarm.js`). No GPU change. Lab knobs: per-ship width, pool radius.
4. Convergence meter (R1). `ScoreKeeper` exposes kill credit; new `src/game/convergence-meter.js`; beam leaves `PICKUP_TYPE_NAMES` (rotation becomes 4 weapons plus time warp, so the time warp is 1 in 5 pickups; check the R31 ruling about 1 in 6); HUD meter element in `hud.js`.
5. Rail gunners (T2): `PlayerSwarm` gunner flag, station-keeping in `swarm-flocking.js`, heading exemption in `swarm-facing.js`, renderer tick. Retire turret rotation emission in `distribute`.
6. Optional: Scythes (S2) as a new weapon taking the beam's rotation slot: new shader entry, kind, render path, reserved slot range, and a measured worst-frame check at 500k agents before shipping.

## 7. GPU and mobile-limit implications

- Steps 1 to 5: no new shader entry; projectile pass work scales with live projectiles, which are bounded (the estimate above is at most about 1300 for scatter tier 3 at 256 ships, against 8192 slots and one thread per slot). Storage buffer count is unchanged (8 in the collide pass, limit 8 per stage per AGENTS.md). No new buffers.
- CPU: spawn objects per update are small; the `pending` array and `writePending` handle a few dozen runs. Keep `ships` allocation-free as today.
- Step 6 (scythes): the `blades` dispatch adds up to 64 workgroups of 256 threads (within the 256 workgroup size limit); workgroup memory use stays the existing `ringSlots`-sized 1 KB plus atomics (limit 16 KB). Zero new bindings if blades reuse the existing slot buffer. Mobile cost unmeasured; ship a cap of 16 active blades on the phone presets.
- Pulse and sidewinder aggregate caps protect the `rings` entry (32 workgroups, 1024 cells per ring).

## 8. What it changes in existing modules

- `src/game/swarm-fire.js`: gutted and replaced (per-ship shots, rate law, budget, cone, beam pooling). Likely splits into `swarm-fire-rate.js`, `fire-budget.js`, `swarm-beam.js` (soft 500 line rule).
- `src/game/weapons.js` and `weaponTypes.js`: add `shotRecipe` and per-kind exponent and aggregate cap fields; the volley path stays for the lab and tests until the old fan is retired.
- `src/game/game.js`: `distribute` call changes (no `fire.spawns` template input); convergence meter wiring; `setBeam` takes the pooled width.
- `src/game/pickups.js`: beam removed from the rotation (step 4).
- `src/game/player-swarm.js`, `swarm-flocking.js`, `swarm-facing.js`: gunner flag, station keeping, heading exemption (step 5).
- `src/render/swarm.js`, `src/ui/hud.js`: tethers, gunner ticks, meter.
- `src/sim/shaders/projectiles_collide.wgsl`, `projectiles_step.wgsl`, `src/render/shaders/projectiles.wgsl`, `src/game/projectiles.js`: only for scythes or web (step 6).
- Tests: `tests/game` swarm-fire, weapons, pickups; new tests for the rate law, budget, beam pooling; the browser `projectiles` and `player` GPU checks gain a beam width check.
- AGENTS.md: the "how fire works" description changes.

## 9. Open decisions for the owner (recommended defaults)

1. Firepower target at 12 ships: about 1.3x the old single ship (13 width-units per second) versus today's 3x. Default: 1.3x.
2. Growth law: exponent 0.4 (256 ships fire 3.4x the aggregate of 12). Default 0.4; flatter (0.25) makes growth cosmetic, 0.6 makes it a power spike.
3. Does tier mean per-kind (recommended) or a uniform rule (count, size or rate)? Default: per-kind.
4. Are rail turrets abstract emitters (keep) or gunner ships that turn outward (T2)? Default: gunners, but later (step 5).
5. Beam model: pooled (P), scythes (S), web (W) or thread lasers (T). Default: P first; consider S as a separate weapon.
6. Beam rarity: earned meter (R1), milestone pickup (R2), sacrifice (R3) or formation delay (R4). Default: R1 with a 5 s duration, roughly one every 60 to 90 s of strong play.
7. If scythes: length 4 units (quarter of the width) or quarter of the height (2.25 units)? Maximum active blades 64 desktop, 16 phone? Default: 4 units, caps as stated, and only after a measured GPU check.
8. Should pulse and sidewinders keep an aggregate cap independent of swarm size (recommended for ring cost), accepting that a bigger swarm does not fire more of them, only wider?
9. While channeling the beam, do ships stop firing projectiles? Default: yes (clear identity, bounded pool).

## 10. Sources

- Shoot 1UP DX (fleet up to 30 ships): the search summary named it but returned no page URL for it, so it is unsourced here; treat it as a lead to check, not a citation.
- Asterboid: https://games.uni-wuerzburg.de/expo/2022/details/games/asterboid
- Swarm: Fight for Freedom: https://happy-k.itch.io/swarm-fight-for-freedom
- Neon Swarm Protocol Zero: https://beopenbefree.itch.io/neon-swarm-protocol-zero
- Converging stream weapons (TV Tropes): https://tvtropes.org/pmwiki/pmwiki.php/Main/ConvergingStreamWeapon
- Positech prism beam discussion: https://forums.positech.co.uk/t/big-laser-effect/3180?page=3
- Nirengeki: Double Strike: https://saltmonger.itch.io/nirgengeki
- Luna Abyss bullet pools: https://gamedeveloper.com/design/building-the-bullet-hell-systems-of-luna-abyss
- Shmups Wiki bullet hell guide: https://shmups.wiki/library/Boghog's_bullet_hell_shmup_101
- Design critique of power-up clutter: https://nomadsreviews.co.uk/post/design-sins-and-pet-peeves-in-shoot-em-ups

All sources came from search result snippets; I did not open the pages, so details beyond the snippets are unverified.
