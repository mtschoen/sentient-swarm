# Online two-player by split authority: design (2026-11-15)

Working draft. This document and its plan are scaffolding and are deleted when the branch finishes, after anything durable is folded into `AGENTS.md`.

It replaces the order of stages 4 and 5 in `docs/superpowers/specs/2026-11-13-multiplayer-design.md`: the owner chose split authority (that document's option O2) first, not remote play. Sections 5.2 and 5.5 of that document are background; where they differ from this one or from the code, this one and the code win. `AGENTS.md` is the current map of the code.

Statements are marked **[owner]** where the owner decided them in conversation and **[call]** where the designer chose a default the owner has not ruled on. Unmarked statements are facts about the code or measurements.

## 1. Intent

Two friends at different houses play a hives match that reads like the couch one. In the owner's words: "I see my opponent capturing their hives, basically the same as if it were couch co-op, but my buddy's at his house", and the bar is "fun and not obviously jank". **[owner]**

Each player's own swarm must feel instant, which is why each machine runs the full game and only the things that must agree travel over the network.

## 2. Goals, non-goals, anti-goals

Goals:

- A hives match online between two browsers on different networks, start to `PLAYER n WINS`, with restart. **[owner]**
- Plain versus online as well, since hives is versus plus the hives. **[owner]**
- Both screens agree on: both swarms' ships, every shot, hive ownership and capture progress, the hold countdown, pickups, the bomb pool, the score and the match result.
- The neutral swarm agrees in bulk (crowd size, place, timing), not per individual. **[owner]**
- The same camera as the couch game: one framing that fits both swarms. **[owner]** ("Otherwise the game design choices won't hit the same in both modes.")
- A pause by either player pauses both. **[owner]**

Non-goals (first build):

- Online co-op. Its shared pickups with time warp, beam shards and beam time, and down and revive, are the hardest systems to keep in agreement. Later. **[owner]**
- Exact agreement of individual neutral agents; a deterministic simulation. **[owner]**
- Anti-cheat. Friends only, total trust. **[owner]**
- Any server: no signaling relay, no TURN, no short join codes (a short code needs a meeting-point service; the owner chose to keep the self-contained invite link). **[owner]**
- Reconnecting a dropped match, spectators, more than two players, rounds or best of 3.
- Remote play by video (option O1).
- A periodic density correction between the peers (see section 4).
- The half simulation rate preset online (see section 9).

Anti-goals (a failure even if it works):

- Any change to how solo, couch co-op, couch versus or couch hives play. With no online session, no networking code runs and every existing call is made exactly as today.
- Input lag on a player's own swarm.
- The two screens disagreeing about who owns a hive or who won.

## 3. Constraints

- Everything in `AGENTS.md` "Global constraints": plain JavaScript ES modules and WGSL, no runtime dependencies (the networking is browser API only: `RTCPeerConnection`, `RTCDataChannel`, `CompressionStream`), full-word identifiers, no em-dashes, source files under about 500 lines, no hard-coded machine paths, no wall-clock assertions in tests (inject time), the mobile WebGPU limits (no shader gains a storage binding).
- Small modules with one responsibility. The networking gets its own directory (`src/net/` is suggested) and does not grow `game.js`.
- A public STUN address is a configuration value in one place.
- The page is a static site on GitHub Pages. The invite data lives in the URL fragment, which is never sent to the server.

## 4. What was measured

A throwaway run (not in the repository) stepped two full-size copies of the simulation for 300 simulated seconds each with the hives gate sites, the same scripted swarms and the same shots:

- Total alive count: about 3 percent apart on average after 30 s, with brief dips to 14 to 19 percent when the horde is thin.
- Crowd placement on a 16 by 9 grid of blocks: Pearson correlation about 0.95 on average, 0.99 by 300 s; the difference is bounded, with no steady drift.
- Kills by each seat's projectiles: within 5 percent at 120 s, under 1 percent at 300 s.
- A shared spawn seed made no measurable difference with fixed hive gates: copies with different director seeds scored the same. The likeness comes from the gate sites, hive ownership, the seek points and the projectiles.
- The crowd within 2 world units of a player differs by 55 to 75 percent between copies. So a ship's death by a neutral agent can only be decided by the machine that owns the ship.
- A peer at half the capacity makes half the raw kills.
- A peer at half simulation rate holds about 19 percent more agents alive and takes half the contact hits.
- 100 ms (6 steps) of delay on one copy's inputs: mild.

Caveats: one or two runs per variant, one sample per second, scripted ships replaced instantly.

## 5. Roles and seats

- The player who creates the invite is the **host**; the one who opens it is the **guest**.
- On both machines the host is seat 1 (index 0: white, starting on the left) and the guest is seat 2 (index 1: green, starting on the right), exactly as two pads on the couch, so `PLAYER 2 WINS`, hive owners, projectile owner flags and seek targets mean the same seat at both houses. **[call, stated to the owner without objection]**
- So on the guest's machine the **local** seat is index 1 and the **remote** seat is index 0. The code today assumes the local player is seat index 0 in several places (`inputFor`, the `Game.player` family of getters, the fire log, `padForSeat`); supporting a local seat of index 1 is part of this work. The world is not mirrored.
- Each seat has one of two drivers:
  - **Local**: today's seat 1 behavior, whichever index the seat has. It reads every local device (keyboard, mouse, touch and the first pad: `input.state`, not the one-pad `input.seatTwoState` path that couch seat 2 uses), steers, flocks, fires and takes hits. On the guest's machine that is seat index 1.
  - **Remote**: it does not read input, steer, flock, fire or decide hits. Its point, aim, ships, weapon readout and beam come from the network (section 7). `PlayerSeat`'s separate `steer`, `flock`, `fire`, `controlsFrom` and `applyHits` methods are the seam; `SeatJoin.seatVirtual()` and the sparring dummy show a seat with no device.
- The local seat index is one value that `Game`, the input, the HUD's seat 1 fields, the fire log, rumble (`padForSeat`, `createLifeWatcher`) and the camera's fallback focus read (0 everywhere except on an online guest); the device mapping is not inverted ad hoc. Threading it through is a task of its own, done and verified against the existing suites before any networking lands. **[call]**
- Online, couch joining (`SeatJoin`), the sparring dummy and the lab are unavailable; an online session always has exactly two seats.
- Desktop and tablet browsers with keyboard and mouse or a pad are the tested online clients. A phone with touch controls is expected to work but is not tested in the first build, and its fullscreen and rotate-overlay pauses pause both players like any other pause. **[call]**

## 6. Who decides what

**Each machine decides its own ships' deaths** **[owner approved]**:

- by its own neutral agents (the contact pass, as today), and
- by the other player's shots, as those shots are replayed on its own screen (`versus_hits.wgsl` against its local seat only).

The other machine learns of a death from the next ship snapshot and shows the small loss shockwave there.

Consequences on each machine for the **remote** seat's ships:

- Local neutral agents chase them (the seek points and hive targets work as today) but cannot kill them, and do not die on them. **[call]** Reason: a ship that cannot die locally would otherwise destroy every agent that touches it, thinning the local crowd far more than on the owner's machine, where a touch costs one agent and one ship.
- Local shots do not kill them and pass through them; their deaths arrive from their owner a moment later. **[call]** The alternative (the shot stops on the ship without killing it) reads as "my hit did not count" whenever the other machine disagrees, and is not built.
- Both follow from uploading the remote seat with the existing `invulnerable` option of `Simulation.setSwarmShips`, which clears both its `armedSeats` and its `projectileArmedSeats` bit, as revive immunity does today. No shader or uniform layout changes. Ship to ship contact is not gated by this online (the host referees it, below).

**The host referees everything that must have one answer** **[owner approved]**:

- The spawn gates: the host runs the only `SpawnDirector`; its gate table (the hive sites in hives, the roaming gates in plain versus, each row with its `emit` state) and the director's wave (the value `SpawnPressure.update` takes) travel to the guest in every host snapshot. The guest runs no director: each step it uses the newest table and wave it has received, as they are, also when the two windows differ in aspect (in plain versus the roaming gates follow the host's view). Each machine runs its own `SpawnPressure` from its own stats and the shared wave, so both bank refills between waves and pour them out during waves alike; how many agents spawn is each machine's own, where and when is the host's. **[call]**
- Hive capture, ownership, the hold timer and the hold win (`Hives`, `HiveHold`, `captureStep`), computed on the host alone from its own ships and the guest's ships as last received. The guest never computes capture; it shows the host's hive state.
- Ship to ship contact (`contactPairs`): the host pairs the ships and names the dead slots of both seats, each with the ship's generation counter (section 7) so a kill aimed at a ship that has since died and regrown in that slot is ignored; each machine kills its own named ships. This is the one case where a machine's ship dies by the other's word.
- Pickups: the host runs the only `PickupDirector` (the versus rotation) and announces each pickup with an identifier, type and position, and its expiry. A machine that sees its own seat reach a pickup claims it; the host grants the first claim (its own at once) and announces the collector; the collector then applies it to its `WeaponState`, and both machines play the pickup blast at the collector's point as sent in the claim.
- The bomb pool, the score, the multiplier and the awards. The score is the host's view: it scores the kills counted by the host's own simulation (its own shots and the guest's shots as replayed there), and the guest's HUD shows the host's score, multiplier and bomb count; the guest's own kill counts feed only its own swarm's growth. A guest's bomb press is a request carrying the guest's swarm centroid at the press; the host spends the pool and announces the bomb with that center (its own centroid for its own bomb); both machines apply the radial kill at the announced center with one radius that does not depend on either window (`bombRadiusForView` of the standard 16 by 9 unzoomed view).
- Elimination and the result: each machine reports its own seat's ship count; a machine whose seat reaches 0 says so; the host judges, treating two wipes within 200 ms of each other as a draw (after one seat's wipe the host waits that window plus half the round trip for the other's report before judging), **[call]** and announces `{ winner, draw, hives }`. Both machines then run the usual match end (`endMatch`).
- The run's lifecycle: start, pause, resume, restart, quit (section 8).

**Swarm growth** stays with each machine: a seat grows by its own owned kills and feeding kills as counted on its own machine (as in couch versus and hives), but online the kill counts are scaled by `DENSITY_REFERENCE_CAPACITY / capacity` before they reach `addKills`, so a peer on a lower preset does not grow slower. **[call]** Couch and solo growth are not changed.

## 7. What travels

One `RTCPeerConnection`, two data channels **[call]**:

- **state**: unordered, no retransmits. Snapshots; a lost one is replaced by the next.
- **events**: reliable and ordered. Everything that must arrive.

Messages are compact binary (`DataView`), with a protocol version in the first exchange; a mismatch shows "both players need to reload the page" and ends the session. The exact layouts are the builder's.

**Session clock.** Both machines agree on a match time (seconds since the match's start, advanced by game updates, frozen while paused). A ping and pong on the events channel, repeated every second or so on a session timer from the moment of connection (so the title can show the round trip and the clock exists before any match), estimate the round trip and the offset between the two machines' match times; every snapshot and event carries its sender's match time.

**Snapshots (state channel), 30 per second from each machine** **[call]**: one on every second fixed game update (the update is 1/60 s), never on a timer of their own while playing:

- The local seat: point position and velocity, aim, firing held, the weapon readout (armed kind, tier, charge, rail turrets and tier), invulnerability, alive count, and per live ship: slot index, position (16 bits per axis over the world), heading (8 bits), gunner mark, and a small generation counter so a slot that died and regrew between two snapshots is seen as a new ship. About 6 bytes per ship (the builder may pack slots as an alive bitmap), at most 1600 bytes at 256 ships.
- The beam, while firing: origin and direction (replayed through `setBeam` in the remote seat's slot).
- From the host only, in every snapshot: the gate table and the wave. At a lower rate (about 10 per second): the hive states (owner, capturer, progress), the hold timer, the score, multiplier and bomb count.

The remote swarm is drawn and uploaded for contact from snapshots, interpolated about 100 ms behind the newest (two snapshots bracket the render time; extrapolate at most another 100 ms, then hold). **[call]**

**Events (events channel):**

- Shots: every projectile spawn record the local seat queues (`{ x, y, velocityX, velocityY, radius, lifetime, kind, seed, extra }` plus owner), batched per update. The receiver replays each with `Projectiles.queueSpawn(spawn, owner)`, advanced along its velocity by its age and with its lifetime cut by the same, so it is where it would be by now. Sidewinders and pulse orbs steer and burst by the local density field, so their paths differ a little per screen; accepted. **[owner approved]**
- From the host: ship contact kills, pickup announced, collected and expired, bomb announced, hive captured (for the shockwave), match start, pause, resume countdown, restart, result, quit.
- From the guest: pickup claim, bomb request, own seat wiped, pause, resume and restart requests, quit.

Expected traffic is under about 0.5 Mbit/s each way at the 256-ship cap (snapshots alone are about 0.36 Mbit/s there) and a fraction of that for typical swarms.

## 8. The session, from connecting to the end

**Connecting** **[owner]**: manual exchange, public STUN only.

1. The title menu has an ONLINE item, always present (never popping in). The host picks it and gets a Host panel: the page creates the connection and its offer, waits for ICE gathering to finish (with a short cap), compresses it (`CompressionStream('deflate-raw')`, base64url) and shows a **Copy invite link** button. The link is the site's own address with the offer in the fragment (`#join=...`). It works once.
2. The guest opens the link. The game loads straight into a Join panel with a **Copy reply** button (the compressed answer as text).
3. The host pastes the reply into the Host panel: a text box, plus a **Paste reply** button that reads the clipboard in one press. **[owner, from the mockup]**
4. Connected: the host's title looks like the couch title after player 2 joined, with a line in seat 2's color saying player 2 is connected online and the round trip in milliseconds. The mode item cycles VERSUS and HIVES only, starting on HIVES. The host picks the mode and starts. The guest sees the same title with the host's mode shown read-only and "waiting for the host to start" in place of Play; the ONLINE item reads as a disconnect on both.
5. If no connection is established within 10 seconds, both sides say plainly that the two networks cannot connect directly, and return to the panel. **[owner]** The host's 10 seconds run from pasting the reply; the guest cannot see that moment, so the guest's run from Copy reply and its panel says it is waiting for the host until then. **[call]**

**Start.** Each machine tells the other when its loading and warm-up have finished; the host's Play does nothing until both are ready (the title says which side is still loading). The host's start then sends the mode and a start moment half a second ahead on the session clock (which runs from the moment of connection, so it exists before any match); both machines call `setPlayerCount(2)` and `setMode` and start when their clock reaches it. There is no visible countdown at the start. **[call]** A restart after a match ("play again") or from the pause menu mid-match, by either player, restarts both. **[call]**

**Pause** **[owner]**: either player pausing (the pause key or button, gamepad Options, leaving the tab, the window losing focus, a pad dropping out, the rotate overlay) pauses the match on both screens under the pause menu, with a line saying which player paused. Either player may resume. Resuming runs a **3, 2, 1 countdown on both screens, during which either player can pause again** **[owner]**; play continues when it reaches zero.

**Connection lost** **[call]**: when the connection reports itself disconnected, both screens pause with "connection lost" and wait 10 seconds for it to recover on its own; if it does not, the match ends and both return to the title with a message. A dropped match is not resumed.

**Quit**: quit to title by either player ends the session for both and returns both to the couch title in co-op, as `quitToTitle` does today. **[call]**

A hidden tab stops animation frames, so the liveness of the session must not depend on the frame loop; use the connection's own state.

## 9. Quality presets

- The two machines may be on different presets and capacities; the alive target is a fraction of capacity and growth is normalized (section 6).
- Online, the simulation runs at full rate on both machines. A machine whose preset would use half rate (`phoneLow`) runs at full rate for the session, and the frame-time probe does not step it into half rate while online. **[call]** If such a device cannot hold the frame rate, that is a known limit of the first build.
- Capacity swaps mid-match keep working as today.

## 10. Camera and readability

- The couch camera on both machines: `framingCenter` and `fitZoom` over both seats' focuses (the remote seat's focus from its snapshot). The simulation never reads it. **[owner]**
- Seat colors, owner tints, the two seat rows in the HUD, the hive pips and countdown, and the edge indicators work as on the couch, fed by the remote seat's snapshot and the host's hive state.
- Rumble goes only to the local seat's pad.

## 11. Proof

1. Unit tests (node:test, injected time, no wall clock): the message encode and decode round trips; the invite and reply encode and decode; the session clock; snapshot interpolation; the remote seat driver; the host referee rules (pickup claims, the bomb pool, the draw window).
2. Two `Game` instances wired together in memory through a fake transport with injectable delay and loss (the harness in `tests/game/game-harness.js` and its fake simulation are the starting point): a versus match and a hives match reach the same result on both, hive ownership agrees, a pause on one pauses the other, the countdown can be interrupted.
3. A guard test in the style of `tests/game/hives-guard.test.js`: with no online session nothing in the game calls into the networking.
4. A browser check with two browser contexts on one machine (not part of `check:gpu`), the script carrying the invite and the reply between them: connect, start hives, one seat captures the center hive and both pages show the same owner, a win, the same banner on both, restart, pause and countdown, disconnect.
5. The existing suites (`npm test`, coverage floors, `check:gpu`, the `coop`, `versus` and `hives` browser checks) stay green.
6. The exit test: the owner and a friend on different networks play a full hives match. Agent-side validation (items 1 to 5) comes first.

## 12. Left to the builder

- Module boundaries and names inside the networking directory; the binary layouts; the snapshot and host-state rates within the stated range; the ICE gathering cap; which public STUN addresses (one primary and one fallback).
- How the local seat index is threaded through input, the `Game` getters, the HUD's "seat 1 fields" and rumble.
- The Host and Join panels' exact layout, within the existing menu style and without layout that pops.
- The wording of every message.
