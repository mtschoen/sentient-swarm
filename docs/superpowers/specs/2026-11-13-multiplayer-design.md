# Multiplayer design exploration (2026-11-13)

Design only; nothing in the repository was changed. Code references are to `main` at `6999058`.

## 1. Problem and goals

The owner's ask: "Multiplayer. Each person controls a swarm (maybe couch co-op and/or online?), there's some sort of resource/goal that you have to seek out and guard, and you chip away at each others' swarms until you've wiped the other guy out."

Goals, in order:

1. Two people, each steering one player swarm, in the same arena as the neutral GPU swarm.
2. A thing worth fighting over that pulls both swarms into contact (the "seek out and guard" part).
3. Attrition between swarms that ends in elimination, without the leader snowballing and without a losing player sitting out minutes of a decided match.
4. Couch first, online second, with no runtime dependencies and no server the project must own.

Non-goals for this exploration: matchmaking with strangers, ranked play, anti-cheat beyond "friends trust each other", more than 4 players.

## 2. What exists and what couples to a single player

The game is single-player in every layer. The table lists each real coupling point I found in the code, with the change it needs.

| Area | Where | Single-player assumption | Change for N players |
|---|---|---|---|
| Input merge | `src/input/input.js:33-43` | One `InputState`; keyboard, mouse, touch and gamepad are summed into one `move`, `aim`, `firing`, `bomb` | One `InputState` per player, built from an assigned device set (section 4.1) |
| Gamepads | `src/input/gamepad.js:26-35` | `readGamepad` takes the first non-null pad and `break`s; the rest are ignored | `readGamepad(navigator, { index })` per pad; a device registry keyed by `Gamepad.index` |
| Pointer aim | `src/game/game.js:507-516` (`controlsFrom`) | Mouse aim is measured from `this.player.position` | Only the player who owns the mouse gets pointer aim |
| Run start gesture | `src/game/game.js:102-106`, `:380` | Any gesture from anyone starts the run | A join screen: each device presses to claim a slot |
| Game singletons | `src/game/game.js:150-162` | One `PlayerShip`, `WeaponState`, `PlayerSwarm`, `SwarmFire`, `ScoreKeeper`, `Awards`, `RunState` | A `PlayerSeat` object holding these per player; `Game` iterates seats |
| Controlled point | `src/sim/simulation.js:132`, `:193-200`; `SimParams.playerPosition` at byte 8 (`src/sim/params.js:131`, `common.wgsl:91`) | One point that every agent seeks | A second (up to fourth) point in the params uniform (uniform, so no storage binding cost) |
| Neutral seek | `src/sim/shaders/steer.wgsl:100-117` (`seekVelocity`) | Seeks `params.playerPosition` | Seek a chosen target: nearest player, or a per-agent target in spare agent flag bits (bits 1-7 and 16-31 of `flags` look unused: `common.wgsl:36`, `:131`; verify before use) |
| Spawn safety | `src/sim/shaders/spawn.wgsl:115-116`, `:194-216`; `src/sim/spawn-director.js` header (safe radius, aim lane) | Spawn distance, far corner and aim lane are relative to one player | Distance to the nearest player; aim lanes for every player, or drop the lane in versus |
| Contact uniform | `src/sim/kill.js:139-164` (`packSwarmShips`, 16 + 256 x 16 = 4112 bytes) | One `Swarm` uniform with 256 slots | One uniform per swarm (2 x 4112 bytes, well under the 64 KiB uniform binding default), or one 512-slot array with an owner per slot |
| Contact pass | `src/sim/shaders/player_collide.wgsl` (7 storage buffers, 256 workgroups) | One hit mask at stats words 24-31 | Dispatch 256 x players workgroups; one mask per player |
| Stats layout | `src/sim/layout.js:64-86` | `STATS_WORD_COUNT = 32` and the mask fills words 24-31: no spare persistent words | Grow to 48 or 64 words: a second mask, per-owner cumulative kill counters, per-player PvP hit masks |
| Kill credit | `stats.kills` (persistent word 18), `src/game/game.js:553-567` | All scored kills belong to the one player; they grow the one swarm (`KILLS_PER_SWARM_SHIP = 100`, `player-swarm.js:27`) | Projectile collide adds to the owner's counter (owner bits in the projectile) |
| Projectile owner | `Projectile` struct `common.wgsl:270-280`; flags bit 0 alive, bit 1 missile ring (`layout.js:20-22`) | No owner | Owner in flag bits 2-3; the step and render passes ignore it, collide and the new PvP test read it |
| Projectile collide bindings | `src/sim/shaders/projectiles_collide.wgsl:69-78` | Already 8 storage buffers (bindings 2 to 9): at the mobile per-stage limit in AGENTS.md | Per-owner kill counting fits in the existing `stats` buffer (no new binding); projectile versus ship must live elsewhere (section 3.3) |
| Beam slot | `src/game/projectiles.js:29` (`BEAM_SLOT = 0`) | One beam | One reserved slot per player (0 and 1); the weapons lane may remove the beam anyway |
| Bomb | `src/game/game.js:383-388` | A bomb is `requestKillAll`: every agent dies | In versus a bomb becomes a large radial kill (`requestRadialKill` already exists, `game.js:427`) so it is not a free screen clear for both |
| Time warp | `src/game/game.js:460-462`, `src/game/time-warp.js` | Scales the whole simulation | Global slow-down affects both players; cut from versus or make it a local slow field |
| Run phases | `src/game/run.js` | One life, game over when the last ship dies (`game.js:571-582`) | Match state (rounds, elimination, sudden death) above per-seat state |
| Pickups | `src/game/pickups.js`, `game.js:584-593` | Placement annulus and pity spawns relative to one player | Placement relative to both; pity spawns for the trailing player (a comeback lever) |
| Spawn pressure ramp | `src/sim/spawner.js`, `game.js:519-539` | Ramp restarts on the one player's start and respawn | One ramp for the match |
| Rendering | `game.js:636-651` (`scene()`), `src/render/swarm.js` (white ships) | One swarm, one point marker, one color | A list of swarms, each with a player hue; owner-tinted projectiles |
| HUD and audio | `src/ui/hud.js`; `effects.weaponFire` (`game.js:450-452`) | One score, one weapon readout; one cue stream | Per-player HUD corners; cue throttling so two swarms do not double the mix |
| Pause and menus | `game.js:320-333`, `src/ui/menu.js`, `menuRouting.js` | One pauser | Any player may pause; menus take input from all devices |

Facts worth stating because they shape the design:

- The swarm fire budget is already size-independent past small swarms: `SWARM_MAXIMUM_VOLLEYS_PER_INTERVAL = 12.8` volleys per fire interval with a burst of 4 (`src/game/swarm-fire.js:27-28`). A 200-ship swarm does not shoot 16 times more than a 12-ship swarm. This is the single most useful anti-snowball property the code already has.
- The flock is pure CPU JavaScript with injected randomness and no clock (`player-swarm.js:1-3`), which makes it cheap to run twice and easy to send as inputs.
- The grid scatter claims cell slots with `atomicAdd` (`src/sim/shaders/grid_scatter.wgsl:20`), so the order of agents within a cell differs from run to run even on one GPU. Steering samples neighbors with a stride over that order (`steer.wgsl:6-8`), so the neutral swarm is not reproducible even on the same machine. This settles the lockstep question (section 5).

## 3. Mode concepts

All modes share the same damage rules (3.3) and run on the larger world from the camera lane.

### 3.1 Concept A: Hives (gate capture that redirects the neutral swarm)

The spawn gates (`src/sim/spawn-director.js`, up to `MAXIMUM_SPAWN_GATES = 4`) become persistent hives at fixed spots in the larger world, 3 in a two-player match (one near each start, one contested in the middle). A hive is neutral at first. Parking enough of your ships inside its disc for a few seconds (capture progress scales with ships present minus enemy ships present, capped, so a big swarm captures faster but not instantly) makes it yours.

What owning a hive does:

- Its emissions are tagged with your owner: those neutral agents seek the nearest opposing swarm instead of the nearest swarm. The neutral swarm becomes a weapon you aim by owning ground. This is the cleanest answer to "turn the neutral swarm on the opponent", and it uses per-agent target bits in the agent flags plus a second seek point (section 2).
- Kills made near your hive count double toward growth (the hive is a feeding ground).
- Holding all hives for 20 seconds is a win condition alongside elimination, so a turtling player cannot stall forever.

Trade-offs. Strengths: it reuses gates, waves and spawn pressure; it creates map positions to fight over; redirection makes the neutral swarm matter in PvP. Weaknesses: per-agent targets touch `spawn.wgsl` and `steer.wgsl` (both GPU, both shared with the solo game, so the solo path must be proven unchanged); capture tuning is fiddly; three hives need a world larger than one screen (dependency on the camera lane).

### 3.2 Concept B: The Core (a carried objective)

One glowing core spawns at the world center. Ships that touch it carry it (it follows the carrier swarm's centroid with lag). Holding it grows your swarm by one ship every few seconds and scores time toward a win, but it is also the strongest attractor in the neutral swarm's seek (it replaces the player point as seek target for a share of agents) and slows the carrier swarm by 20 percent. Losing a set fraction of ships in two seconds drops it.

Trade-offs. Strengths: an extremely clear goal; natural comeback because the leader carries a hazard magnet; a pure CPU objective plus one more seek point, so the GPU changes are small. Weaknesses: one objective in a big world funnels play to one spot and makes the camera lane's framing easy but the map irrelevant; ball-carry modes are well-trodden ground; with two players it can degenerate into keep-away.

### 3.3 Concept C: Feeding Ground (pure attrition)

No objective. The neutral swarm is food (kills grow you) and hazard (contact costs a ship). Swarms chip at each other with projectiles. The arena shrinks over the match (a closing wall the larger world makes meaningful), forcing contact. Last swarm standing wins.

Trade-offs. Strengths: smallest build; every mechanic is already there except PvP damage; it is the test bed for the damage and anti-snowball numbers that A and B also need. Weaknesses: it is not what the owner asked for ("seek out and guard"); farming the neutral swarm while avoiding the opponent is the dominant strategy until the wall closes.

### 3.4 Concept D (co-op variant): Two Swarms, One Hive

Both players defend one hive at the center against the neutral swarm, which now arrives in heavier waves. Shared lives pool: when one player is wiped, the other can spend 20 ships at the hive to revive them with 12. This falls out of stage 1 almost for free: it needs two seats and two seek points but no PvP damage and no owner bits.

### 3.5 How swarms damage each other

1. **Projectiles hit opposing ships.** New, required. A projectile carries its owner; one opposing ship dies per projectile hit and the projectile stops (PvP shots do not pierce, unlike neutral kills, otherwise a scatter volley deletes a swarm). Implementation: extend `player_collide.wgsl`, which already runs one workgroup per swarm slot, with the projectile buffer as its 8th storage binding (it has 7 today, so this reaches the mobile limit exactly; nothing more can be added later). Each ship workgroup scans the 8192 projectile slots, 32 per thread: 512 workgroups x 8192 tests is about 4 million distance tests per step, small next to the neutral swarm's work. A second per-player PvP hit mask in stats words reports it. Killing the projectile from many workgroups races; an `atomicAnd` on its flags like the agent kill in `touch()` resolves it, which needs the projectile flags declared atomic in that shader only.
2. **Ship to ship contact.** Touching opposing ships both die, one for one. CPU only: at most 256 x 256 = 65536 pair tests per step, and in practice a uniform grid over the two swarms makes it trivial. One-for-one trades are size-neutral by design, so ramming is a tactic for the smaller swarm (trade down to a draw) and never a snowball.
3. **The neutral swarm turned on the opponent.** Via hives (A), the core's attraction (B), or a bomb variant that "taints" agents in a radius to seek the opponent for 5 seconds instead of killing them.

### 3.6 Snowball control and keeping the loser in

The leader has more ships; the risk is that more ships means more kills means more ships. Levers, in order of how much I trust them:

1. **Firepower is already capped** by the volley budget (section 2). More ships give spread and survivability, not damage. Keep it.
2. **Growth gets more expensive with size**: kills per new ship `100 x (1 + ships / 48)`, so ship 12 costs 125 kills and ship 150 costs 413. Underdog bonus: while you have under half the opponent's ships your kills count 1.5 times.
3. **The swarm hunts the strong**: neutral agents choosing a target pick the larger swarm with probability `ships_A / (ships_A + ships_B)`. Big swarms draw more contact. One uniform float, cheap.
4. **Hitbox grows with size**: already true (more ships, more area to hit).
5. **Pity pickups** go to the trailing player only (`PickupDirector` already has a recovery guard).
6. **The last ships are hard to finish**: under 6 ships a swarm gets 30 percent more speed and its losses come with 1 second of invulnerability for the remaining ships. It does not make the loser win; it makes the winner earn the wipe, which is the owner's "wiped the other guy out" moment.
7. **Rounds, not one long match**: best of 3 rounds. A wiped player is out for at most one round (about 3 minutes), not the match.

Match length: a round aims for 3 minutes; at 4 minutes sudden death starts (spawn pressure to its ceiling, hives stop redirecting, wall closes in Concept C). Best of 3 means 6 to 12 minutes, a good couch session length.

Player count: design data for up to 4 (owner in 2 bits, 4 seek points, 4 masks), ship and tune for 2. Four 256-ship swarms is 1024 contact workgroups and 1024 CPU flock agents per step; the CPU flock cost at that size is not measured, so flag it.

### 3.7 Recommendation

Build **Hives (A)** as the first real mode, reached through **Feeding Ground (C)** as the stage that proves damage and balance numbers, with **co-op (D)** shipped along the way because it costs nearly nothing. A is the only concept that is literally "a resource you seek out and guard" and that uses the neutral swarm in a way no other shooter does: owning ground means owning part of the enemy horde. B is the fallback if per-agent targeting on the GPU turns out to hurt the solo game's performance.

## 4. Couch multiplayer design

### 4.1 Input assignment

- **Join screen**: each device presses a button to claim the next seat; the seat shows the device icon and the player hue. A device belongs to exactly one seat.
- **Two or more gamepads**: one seat per `Gamepad.index`; track `gamepadconnected` and `gamepaddisconnected` and do not assume a reconnected pad keeps its index (MDN pages disagree on that). Up to 4 pads in Chromium (secondary source; verify on Firefox and Safari). Rumble per pad already exists (`src/input/rumble.js`) and must take the seat's pad.
- **Keyboard plus mouse and a gamepad**: the keyboard and mouse seat keeps today's controls (WASD move, mouse aim and fire, Space or right click bomb). This is the most likely real setup and must be first-class.
- **Two players on one keyboard**: possible with WASD move plus auto-aim toward the nearest threat for one and arrows plus IJKL aim for the other, but twin-stick on one keyboard is cramped. Offer it, do not design around it.
- **Two players on one touch screen**: a tablet in landscape split into a left and right half per player, each half again into move and aim sticks, means four floating sticks on one glass. `touch.js` (`createTouchSource`) already floats sticks per half; per-quadrant sticks are a modest change. Viable on a 10 inch tablet, not on a phone (each stick zone would be under 3 cm wide). I would ship it later and behind a "tablet duel" toggle with simplified controls (aim auto-follows movement, firing is on while moving), and not put it in stage 1.

Code shape: `createInput` becomes a device registry that produces one `InputState` per seat each update; `Game.update` loops seats for steps 1 to 4 of the frame order, then submits one simulation step with all swarms' contact data.

### 4.2 One shared camera versus split screen

**Shared screen**, one camera framing the bounding box of both swarms (the camera lane's framing, given two targets), with a maximum zoom-out. When the swarms pull farther apart than that zoom allows, the camera edge becomes a soft wall: the controlled points cannot leave the view. This is how most couch twin-stick games handle it, it keeps both players seeing the same fight, and it costs nothing extra to render.

**Split screen** costs:

- Trails are screen-space history: two `rgba16float` scene targets at canvas size ping-pong (`src/render/renderer.js:1-4`). Each view needs its own pair, plus its own bloom chain. At two half-width views the pixel work stays about the same as one full view.
- The glyph pass draws every agent instance; with two views the instance and vertex work doubles unless each view culls. At 524288 agents that is the dominant cost (not measured; the probe would step quality down).
- Trails smear when the camera moves; the camera lane must already solve reprojection or clearing for one moving view, and split screen doubles that problem.

On desktop split screen is affordable; on phones couch play with gamepads is rare anyway. Recommendation: shared screen only for stages 1 to 3, split screen as an optional later item if the larger world makes the soft wall feel bad.

## 5. Online architectures

Constraints that rule things out:

- **Lockstep and rollback are out.** They need every peer to compute the same next state from the same inputs. The neutral swarm is not reproducible even on one device (the `atomicAdd` cell order, section 2), WGSL permits reassociation and fusion of float operations (luma.gl's precision guide), and peers will have different GPUs. Making the sim deterministic would mean integer math everywhere plus a deterministic sort: a rewrite of the core.
- **The state is too large to send.** 524288 agents x 32 bytes is 16 MiB per step. Even 4 bytes per agent quantized is 2 MiB per step, 120 MiB/s at 60 Hz.

### 5.1 Option O1: Remote play (host renders, guest receives video)

The host runs the couch game with the guest as a remote seat. The host streams its canvas (`HTMLCanvasElement.captureStream`, a browser API; that it captures a WebGPU canvas is not verified, though a WebGPU canvas is still a canvas) over a WebRTC video track; the guest sends input over an unreliable, unordered data channel and plays the video.

- Bandwidth: host upstream about 3 to 6 Mbit/s for 1280x720 at 60 fps (typical WebRTC video rates; not measured with this game, whose particles and bloom are hard on a video encoder); guest upstream about 2 kB/s of input (a 12 byte input packet at 120 Hz with redundancy).
- Feel: the host has zero added latency; the guest gets network round trip plus encode and decode, roughly 40 to 100 ms on top of a domestic round trip. Fine for a swarm game, where you steer a flock and not a pixel-precise ship; bad for twitch aim. Steam's Remote Play Together does exactly this for local multiplayer games and reviewers found it works on fast connections.
- Cheating: the guest cannot cheat at all; the host could, but it is the host's game.
- What breaks: video artifacts on half a million tiny glyphs; the guest sees the host's shared camera (no per-player view without split-screen rendering on the host); the host's machine must carry the full game; host upload is the limit.
- Upside nobody else gets: the guest needs no WebGPU at all, so a friend on a browser or phone without WebGPU can play.
- Code needed beyond couch: a remote input source that feeds a seat, signaling, a video element view for the guest. No change to the simulation.

### 5.2 Option O2: Split authority with a local neutral swarm per peer

Each peer runs its own full game, including its own neutral swarm. Synchronized: the player swarms, projectile spawns, match state and coarse events. Not synchronized: individual neutral agents.

- **Your own swarm is yours.** Each peer is authoritative for its own ships: their flock (it is CPU and cheap), and every death of its own ships, whether from its local neutral swarm, from an opponent projectile it sees hit, or from ship contact. "You decide what kills you." Peers send their ships at 20 Hz; the remote swarm is drawn interpolated 100 ms behind and uploaded into the contact pass as a target for the local neutral swarm (so local neutrals chase and die on the remote swarm too).
- **Projectiles are sent as spawn events**, not states: owner, kind, position, velocity, seed, step. Straight-line projectiles replay identically enough on the receiver. Receiver hits on its own ships come from its own sim.
- **The neutral swarms are kept loosely alike** by: one seeded spawn director (it is CPU with injected randomness, so the gate table is reproducible if both peers step it with the same deltas; the GPU spawn positions are not); kill events as discs (a projectile kill cluster is sent as a center and radius about 5 times a second and the receiver applies `requestRadialKill`; bombs and hive captures as events); optionally a quantized coarse density snapshot from the host (64 x 36 cells x 5 species x 1 byte = 11.5 kB, at 2 Hz = 23 kB/s) that the receiver nudges toward by spawning or culling per cell.
- Bandwidth: ships 256 x 5 bytes (16-bit x, y, 8-bit heading) = 1.3 kB per snapshot, 20 Hz = 26 kB/s at full size, about 6 kB/s for a typical 60-ship swarm; projectile events about 1 to 3 kB/s; kill discs and events under 1 kB/s; with density nudging about 30 to 50 kB/s each way, 0.3 Mbit/s. Fine on any connection.
- Feel: your own swarm is instant. The opponent is 100 ms behind. The neutral swarm on your screen is not the one on theirs: the same wave at the same gate, but different individuals. You will sometimes see their ship die to an enemy that is not on your screen; their hive-redirected horde will look a bit different on each side.
- Cheating: total trust. A peer can ignore its own hits and be invincible. Acceptable among friends; unacceptable with strangers, which is a non-goal.
- What breaks: hive ownership and round results need one referee, so the host decides match state; disagreements about simultaneous last-ship deaths need a tie rule (both wiped in the same 200 ms window is a draw round). Divergence debugging is real work; Gaffer on Games calls state synchronization approximate and lossy, needing a lot of debugging for pops.

### 5.3 Option O3: Host-authoritative players with streamed state, cosmetic neutral on the guest

The host simulates everything that matters (both swarms against its own neutral swarm) and streams both swarms, projectiles and the coarse density to the guest, who draws a cosmetic neutral swarm. The guest's ships die to neutral agents the guest never saw, at one round trip of input latency on their own swarm. This is the worst of O1 and O2 together: networking complexity of O2 with the guest's feel of O1, without O1's correctness. Listed for completeness; not recommended.

### 5.4 Comparison

| | O1 Remote play | O2 Split authority | O3 Host-authoritative, cosmetic guest | Lockstep or rollback | Full state |
|---|---|---|---|---|---|
| Host upstream | 3 to 6 Mbit/s | 0.1 to 0.4 Mbit/s | 0.3 to 0.5 Mbit/s | tiny | over 100 MiB/s |
| Guest input latency on own swarm | RTT + 40 to 100 ms | zero | RTT | input delay | n/a |
| Correctness of what you see | exact (it is the host's frame) | own view exact, neutral differs per peer | guest sees a cosmetic neutral that kills them unseen | needs determinism we do not have | n/a |
| Guest needs WebGPU | no | yes | yes | yes | yes |
| Cheating exposure | host only | both, total trust | host only | low | n/a |
| Simulation changes | none beyond couch | large: event sync, remote swarm proxy, seeded director | large | rewrite | n/a |
| Verdict | build first | build second, if O1 feels bad | no | no | no |

### 5.5 Transport without owning a server

Everything below is browser API (`RTCPeerConnection`, `RTCDataChannel`, `captureStream`, `CompressionStream`, `WebSocket`), so the no-runtime-dependencies rule holds. What changes is hosting.

- **Manual exchange by link (zero infrastructure).** The host creates an offer, waits for ICE gathering to finish (there is no channel for trickled candidates), compresses the SDP with `CompressionStream('deflate-raw')`, and puts it in a link's `#fragment` (never sent to GitHub Pages). The guest opens the link and gets an answer code to send back through any chat app; the host pastes it. Two copy-pastes. Reported SDP sizes are around 2.5 to 3.8 kB raw (one write-up got a data-channel SDP down to 55 bytes with a custom binary encoding, keeping only fingerprint, ICE credentials and candidates); a video SDP is larger. A QR code for the offer works for in-room setup but is pointless for online play. Existing projects show the pattern runs from a static site.
- **Public signaling relays.** Trystero (a library we cannot depend on, but its approach is instructive) signals over Nostr relays, BitTorrent WebSocket trackers or public MQTT brokers. Reimplementing one without dependencies: the WebTorrent tracker protocol is JSON over WebSocket (feasible, a few hundred lines); MQTT over WebSocket needs a small binary framing (feasible); Nostr needs secp256k1 Schnorr signatures, which WebCrypto does not provide (needs vendored crypto code). All depend on third parties' uptime; a downstream project reported connection trouble with Trystero's default trackers. Room names would have to be unguessable.
- **A tiny self-hosted signaling relay on the owner's fleet.** A WebSocket room relay (join room, forward messages) is under 100 lines and would turn the two copy-pastes into "share a room link". It is a server: the static site would depend on it being up and reachable from the internet. This is an owner hosting call.
- **STUN** is needed for anything beyond one LAN: `stun.cloudflare.com` is free and unlimited per Cloudflare's docs. A public STUN URL in the code is a configuration value, not a dependency.
- **TURN** is the hard reality. Peers behind symmetric NAT or carrier-grade NAT (common on mobile networks) cannot connect directly, and the game then fails for that pair. I could not find a trustworthy figure for how often; the often-repeated "10 to 20 percent" is unverified. Options: Cloudflare TURN (free tier 1000 GB of egress per month, shared with their SFU; but credentials must be minted server-side with an API key, so it still needs a small worker, which a static site cannot hide a key in); or coturn on the owner's fleet (relays traffic through the home uplink: O1 video through TURN is 3 to 6 Mbit/s per match, and it exposes a home IP). Recommended default: ship without TURN, detect a failed connection after 10 seconds and say plainly "your networks cannot connect directly".
- **Channels**: input and snapshots on `ordered: false, maxRetransmits: 0`; match events (hive captured, round over, ship deaths in O2) on a second, reliable ordered channel.

## 6. Staged path

The smallest playable step first. I agree with couch versus on one screen before networking, with one change: the two-seat foundation is playable as co-op before PvP damage exists, so ship that as the first step.

1. **Stage 1: two seats, shared screen, co-op.** Device registry and join screen; `PlayerSeat` per player; second seek point in `SimParams` (nearest player); second contact mask (stats grows to 48 words); per-player hues; shared camera on both swarms. Playable as Concept D minus the revive. Exit test: solo game unchanged (existing browser checks pass), two pads and keyboard plus pad both work.
2. **Stage 2: versus, Feeding Ground.** Projectile owner bits; per-owner kill counters; projectile versus ship in `player_collide.wgsl`; CPU ship contact; versus bomb as radial kill; time warp off; rounds and sudden death. This is where the snowball numbers of section 3.6 get tuned. Exit test: a lab knob set for versus balance; GPU check extended for PvP hits.
3. **Stage 3: Hives.** Persistent gates, capture, owner-tagged emissions and per-agent seek targets in `spawn.wgsl` and `steer.wgsl`; hive win condition. Measure the solo game's steer pass before and after.
4. **Stage 4: online by remote play (O1).** Remote seat over a data channel, canvas video track, manual link signaling, STUN only. Exit test: two machines on different networks, a full best of 3.
5. **Stage 5, optional: split authority (O2)** if stage 4's guest latency or video quality disappoints; optional signaling relay or TURN if the owner chooses to host them.
6. **Later, optional: tablet duel touch controls; split screen; 3 and 4 players.**

## 7. Dependencies on the parallel lanes

From the **larger world and camera lane**:

- A camera that frames a set of points (two or more swarms), with a configurable maximum zoom-out and a way to report "a target is outside the frame" so the game can apply the soft wall.
- A world size and the coarse field and grid coverage over it, since hives need room and the O2 density snapshot is sized by the coarse grid (64 x 36 today).
- How trails and bloom behave under a moving camera; split screen inherits that answer twice.
- Arena bounds as data the game can shrink over time (Feeding Ground's closing wall, sudden death).

From the **weapons lane** (one projectile per ship along its heading):

- A projectile owner field or spare flag bits kept free (bits 2-3 here), and the PvP rule that a projectile stops on a ship.
- The fire budget staying size-independent (today's volley token bucket); if per-ship firing removes it, firepower scales with swarm size and snowballing becomes the main balance problem.
- Whether the beam survives (it needs one reserved slot per player).
- Projectile counts per second at full swarm size, which sets O2's event bandwidth.

## 8. Risks and idea killers

- **Readability.** Two swarms of up to 256 small ships, half a million neutral glyphs, bloom and particles: can a player tell their ships from the opponent's? Hue alone may not survive bloom. Prototype with two hues on stage 1 before anything else; if it fails, multiplayer needs a reduced neutral density or outlined ships.
- **Readback latency on PvP hits.** Hit masks come back through the staging ring frames late. In solo that is invisible; in PvP a ship may keep shooting for 2 to 4 frames after it was hit. Probably fine for a swarm; worth measuring.
- **The mobile binding limit.** `player_collide.wgsl` reaches 8 storage buffers with the projectile buffer and `projectiles_collide.wgsl` is already at 8. Any later per-player GPU feature needs a new pass, not a new binding.
- **The CPU flock at 2 to 4 swarms.** Not measured; on a phone two 256-ship flocks may cost more than the frame budget.
- **Per-agent seek targets** (Hives) touch the hottest shader in the game. If the solo frame time regresses, fall back to the Core (Concept B).
- **Online video quality.** O1 may look poor because the scene is mostly tiny bright dots; a short test with `captureStream` into a loopback `RTCPeerConnection` would answer it in an afternoon.
- **NAT without TURN.** Some friend pairs will never connect. The owner has to accept that or host a relay.
- **Balance is unknown until tuned.** Every number in section 3.6 is a starting guess.

## 9. Open decisions for the owner

Each with my recommended default.

1. **First mode**: Hives, Core or Feeding Ground as the target. Default: Hives, via Feeding Ground as the tuning stage.
2. **Co-op in scope**: ship the co-op variant at stage 1. Default: yes, it is nearly free.
3. **Player count**: 2 only, or up to 4 for couch. Default: build data for 4, ship and tune for 2.
4. **Shared screen versus split screen**: Default: shared screen with a soft wall; split screen deferred.
5. **Match format**: best of 3 rounds of about 3 minutes with sudden death at 4. Default: yes.
6. **Online at all, and which first**: Default: yes, remote play (O1) first; split authority only if O1 disappoints.
7. **Hosting**: manual link exchange only, or also a signaling relay and coturn on the home fleet (internet-facing, exposes a home IP and uplink). Default: manual links and public STUN only; revisit after stage 4 is played.
8. **Trust model**: friends only, no anti-cheat. Default: yes.
9. **Versus rule changes to solo systems**: bomb becomes a radial kill and time warp is disabled in versus. Default: yes.
10. **Tablet two-player touch**: Default: deferred, behind a toggle with simplified controls.

## 10. Sources

Found during this exploration (web search on 2026-11-13). The search tools returned summaries; I did not read every page in full, and items marked as secondary are not authoritative.

- Manual WebRTC signaling from static pages: [serverless-webrtc-qrcode](https://github.com/fta2012/serverless-webrtc-qrcode), [Quick and dirty WebRTC manual signaling](https://peterchrjoergensen.pages.dev/blog/quick-dirty-webrtc-manual-signaling/), [WebRTC QR signaling and SDP size](https://lilting.ch/en/articles/webrtc-qr-signaling), [Air gapped WebRTC: breaking the QR limit (SDP to 55 bytes)](https://magarcia-io.pages.dev/air-gapped-webrtc-breaking-the-qr-limit), [serverless-webrtc on npm](https://npmjs.com/package/serverless-webrtc)
- Public-relay signaling: [Trystero](https://github.com/dmotz/trystero), [remnantchat issue on Trystero tracker availability](https://githaven.org/Shiloh/remnantchat/issues/2)
- STUN and TURN pricing: [Cloudflare Realtime TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/), [Cloudflare Realtime pricing](https://developers.cloudflare.com/calls/pricing/)
- Data channel reliability modes: [How does reliability work in RTCDataChannel](https://jameshfisher.com/2017/01/17/webrtc-datachannel-reliability/), [Metered: data channels and low latency](https://www.metered.ca/docs/realtime-messaging/sdk-javascript/guides/data-channel-low-latency)
- Canvas capture: [W3C Media Capture from DOM Elements](https://www.w3.org/TR/mediacapture-fromelement/), [Chrome: capture a MediaStream from a canvas](https://developer.chrome.com/blog/capture-stream)
- Remote play prior art: [Steam Remote Play](https://store.steampowered.com/remoteplay), [PC Gamer: playing local multiplayer games over the internet with Steam](https://www.pcgamer.com/playing-local-multiplayer-games-over-the-internet-with-steam-works-surprisingly-well)
- Determinism and large state: [Gaffer on Games: Floating Point Determinism](https://gafferongames.com/post/floating_point_determinism), [GameDev.net thread on RTS lockstep](https://gamedev.net/forums/topic/419969-wargamerts-network-architecture-a-danger-of-lock-step-commands-synchronization/), [luma.gl: GPU floating point precision (WGSL reassociation and fusion)](https://luma.gl/docs/api-guide/shaders/gpu-floating-point-precision); the WGSL spec text itself was not retrieved
- State synchronization: [Gaffer on Games: State Synchronization](https://gafferongames.com/post/state_synchronization/), [Snapshot Interpolation](https://gafferongames.com/post/snapshot_interpolation), [Snapshot Compression](https://gafferongames.com/post/snapshot_compression/)
- Client-only cosmetic simulation at scale: [mas-bandwidth: So I'm making a 1000 player space game](https://mas-bandwidth.com/so-im-making-a-space-game/)
- Gamepads: [MDN: Using the Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API/Using_the_Gamepad_API), [MDN: Gamepad.index](https://developer.mozilla.org/docs/Web/API/Gamepad/index)
- Anti-snowball prior art (secondary, fan sources): [Agar.io mechanics (fan wiki)](https://shapes.inc/fandom/agar-io/mechanics), [Agar.io anti-teaming measure](https://reddit.birdcat.cafe/r/Agario/wiki/anti-teaming_measure)
- Swarm and flock multiplayer games (mechanics inspiration only, nothing copied): [Swarm Universe](https://store.steampowered.com/app/407110), [Flock Fusion](https://prawl.itch.io/flock-fusion), [SwarmRush](https://matthieu-gll.itch.io/swarmrush), [Boid](https://specs.behixo.com/game/boid). I found no competitive game built on capturing spawn points that redirect a neutral horde, which suggests Hives is not a copy of an existing design (absence in one search is weak evidence).

Not verified anywhere: that `captureStream` works on a WebGPU canvas in every target browser; the share of peer pairs that need TURN; the 4-gamepad cap outside Chromium; the CPU flock cost at 2 to 4 swarms; video encoder quality on this scene.
