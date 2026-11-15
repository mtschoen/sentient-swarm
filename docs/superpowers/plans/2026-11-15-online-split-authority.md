# Online Split-Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two friends in different houses play a versus or hives match between two browsers, each machine running the full game for its own swarm while the host referees everything that must have one answer.

**Architecture:** Each seat gets a driver: the local seat is today's seat 1 behavior at whichever index it has, the remote seat is written from snapshots and fires replayed shots. A new `src/net/` directory holds everything online (codecs, clock, transports, the remote seat, the referee, the session lifecycle); the game reaches it only through one injected object, `game.online`, which is `null` without a session, so solo and couch play make exactly today's calls. The host (seat index 0 on both machines) runs the only spawn director, pickup director, hive capture, bomb pool, score and match judgment and sends their results; each machine decides its own ships' deaths.

**Tech Stack:** Plain JavaScript ES modules; WGSL unchanged; browser `RTCPeerConnection`, `RTCDataChannel`, `CompressionStream('deflate-raw')`, `DataView`; `node:test`; Playwright and Vite as dev dependencies only.

**Spec:** `docs/superpowers/specs/2026-11-15-online-split-authority-design.md`

## Global Constraints

- Plain JavaScript ES modules and WGSL. No TypeScript. No runtime dependencies; the networking is browser API only (`RTCPeerConnection`, `RTCDataChannel`, `CompressionStream`).
- Full-word identifiers (`maximum`, not `max`; `position`, not `pos`). No em-dashes (U+2014) anywhere, including comments, docs and copy.
- Every source file under about 500 lines, or carrying a one-line note at the top saying why. `src/game/game.js` (849 lines today) must not grow: new game-side work goes into small modules in the style of `versus-seats.js` and `hive-seats.js`. `src/main.js` (467 lines) stays at most 500.
- No hard-coded machine paths. No wall-clock assertions in tests: every time source (`now`, `setTimer`, `clearTimer`, `random`) is injected.
- No shader gains a storage binding; no WGSL or uniform layout changes at all.
- "With no online session, no networking code runs and every existing call is made exactly as today." The existing suites are the proof and must stay green unchanged.
- Online, couch joining (`SeatJoin`), the sparring dummy and the lab are unavailable; an online session always has exactly two seats.
- A public STUN address is a configuration value in one place (`src/net/ice-configuration.js`). The invite lives in the URL fragment (`#join=`).
- Online co-op, reconnecting a dropped match, spectators, TURN, servers, short codes and the half simulation rate are out of scope.
- Neighbor contributions stay averaged; the world stays 32 by 18; the fixed update is `1 / 60` s.
- Commit after every task with a message in the imperative.

## Review Focus

1. **Hive state lost or reordered on the state channel during a capture.** The guest's hive pip and capture arc never step back to an older owner or progress; once loss stops they match the host within one host-state interval, and the capture shockwave plays once. Test in Task 4.2.
2. **Both players reach one pickup in the same moment.** Exactly one machine's weapons change, the pickup vanishes on both, each machine plays the blast once at the same place, and the losing claim never fires later. Test in Task 4.3.
3. **A host ship touches a guest ship whose death the host has not seen yet** (the snapshot was lost, or is still 100 ms behind). One touch kills one ship on each side, not one host ship per update until the next snapshot arrives. Test in Task 3.7.
4. **The guest's tab is hidden or blurred during the 3, 2, 1 countdown.** No animation frames run there, yet the pause still reaches the host from the event handler and neither game resumes. Test in Task 5.2.
5. **The invite link is opened twice, or opened in a tab that is mid-run, or the pasted reply is not a reply** (the invite itself, garbage, a stale reply). The player sees a plain message and nothing else changes; a second reply after connecting is ignored; a mid-run tab holds the join until the title shows. Tests in Tasks 2.3, 6.2 and 6.4.

---

## Execution map

Each task runs in its own sibling worktree. "After" names hard dependencies; tasks with none left can run side by side.

| Task | After | Parallel with |
| --- | --- | --- |
| 1.1 Local seat index in the game | none | 2.1, 2.3, 2.4, 2.5 |
| 1.2 Rumble routing and the Phase 1 gate | 1.1 | Phase 2 |
| 2.1 Byte buffer, protocol, snapshot codec | none | 1.x, 2.3, 2.4, 2.5 |
| 2.2 Event codec | 2.1 | 2.3, 2.4, 2.5, 1.x |
| 2.3 Signal codec | none | everything in Phases 1 and 2 |
| 2.4 Session clock | none | everything in Phases 1 and 2 |
| 2.5 Transport interface and memory transport | none | everything in Phases 1 and 2 |
| 3.1 Ship generations and the mirrored swarm | 1.2, 2.1 | 5.1, 5.3, 6.1, 6.2, 6.3 |
| 3.2 Remote seat driver | 3.1 | same |
| 3.3 Online game adapter and two-game harness | 3.2, 2.2, 2.4, 2.5 | same |
| 3.4 Shot replay and the beam | 3.3 | 3.5 |
| 3.5 Growth scaling and local-only hits | 3.3 | 3.4 |
| 3.6 Match end through the host | 3.4, 3.5 | 5.1, 5.3, 6.x |
| 3.7 Host-refereed ship contact | 3.6 | same |
| 4.1 Gates and wave from the host | 3.7 | 4.2, 4.3 |
| 4.2 Hive state from the host | 3.7 | 4.1, 4.3 |
| 4.3 Pickups with identifiers and claims | 3.7 | 4.1, 4.2 |
| 4.4 Bomb pool and shared HUD numbers | 4.2 | 4.1, 4.3 |
| 5.1 Session lifecycle (pure) | 2.4 | Phases 3 and 4 |
| 5.2 Online session | 4.1 to 4.4, 5.1 | 6.1 to 6.3 |
| 5.3 Full simulation rate online | 1.2 | Phases 2 to 4 |
| 6.1 ICE configuration and RTC transport | 2.5 | Phases 3 to 5 |
| 6.2 Host and Join panels | 2.3 | Phases 3 to 5 |
| 6.3 ONLINE title item and connected title | 1.2 | Phases 3 to 5 |
| 6.4 Online wiring in main.js | 5.2, 5.3, 6.1, 6.2, 6.3 | none |
| 7.1 Guard test | 6.4 | 7.2 |
| 7.2 Two-context browser check | 6.4 | 7.1 |
| 7.3 Documentation | 7.1, 7.2 | none |
| 7.4 Whole-suite pass | 7.3 | none |

Merge parallel lanes one at a time onto the integration branch and rerun `npm test` after each merge (the `review-in-parallel-pipelines` gate). Tasks 4.1 to 4.3 touch different lines of `game.js` and `online-game.js`; expect small textual conflicts there, never semantic ones.

## Shared shapes

Defined once here; tasks refer to them by name.

```text
SeatSnapshot = {
  type: 'snapshot', sequence: u32 (per sender, +1 per snapshot), matchSeconds: f64 (sender's), seat: 0 | 1,
  point: { x, y, velocityX, velocityY }, aim: { x, y }, firing: boolean, invulnerable: boolean,
  weapons: { armed, tier, charge, railTurrets, railTier }, aliveCount,
  ships: [{ slot, x, y, heading, gunnerIndex, generation }]   // slot order, alive only
  beam: null | { x, y, directionX, directionY, halfWidth },
  host: null | { gates: null | { gates: [{ x, y, radius, emit, species, open, telegraph, site? }], speciesBias }, wave: null | { emitting, remainingSeconds, burstFraction } },
  hostState: null | HostState,
}
HostState = { sequence: u32, hives: null | [{ owner, capturer, progress }], holder, holdSeconds, score, multiplier, bombs }
Transport endpoint = { send(channel, bytes), onMessage(handler(channel, bytes)), onStateChange(handler(state)), state, close() }
  channel: 'state' (unordered, no retransmits) | 'events' (reliable, ordered)
  state: 'connecting' | 'open' | 'disconnected' | 'closed'
```

`owner`, `capturer` and `holder` are seat indices or `null`. Every event is `{ type, ...fields }` with the fields listed in Task 2.2.

---

## Phase 1: The local seat index

One value, `Game.localSeatIndex`, read by the game, the input routing, the HUD's seat 1 fields, the fire log, rumble and the camera's fallback focus; it is 0 everywhere today. No networking. This phase lands and is verified before anything else.

### Task 1.1: Local seat index in the game

**Files:**
- Modify: `src/game/game.js:262-271` (the seat 1 getters), `:273-291` (`state`), `:334-340` (`removeSecondSeat`), `:397-399` (`followCamera`), `:588-591` (`inputFor`)
- Modify: `src/game/seats.js:63-67` (`framedFocuses`), `:100-113` (`fireSeats`, the fire log)
- Test: `tests/game/local-seat.test.js`

**Interfaces:**
- Consumes: `createGame()`, `runFor`, `STEP` from `tests/game/game-harness.js`.
- Produces:
  - `Game.localSeatIndex` (number, default 0), `get localSeat()` (the `PlayerSeat` at that index).
  - `Game.setLocalSeat(index)`: throws `Error` outside Ready, `RangeError` unless `Number.isInteger(index) && 0 <= index < seats.length`. `removeSecondSeat` sets it back to 0 (so `setPlayerCount(1)`, `quitToTitle` and `setWatch` all return it to 0).
  - `inputFor(seat)`: the local seat reads `input.state`, any other seat `input.seatTwoState`.
  - `player`, `swarm`, `swarmFire`, `weapons`, `swarmControls`, `firingHeld`, `bombHeld` read `this.localSeat`; `state` spreads `this.localSeat.hudFields()`.
  - `framedFocuses(seats, fallbackIndex = 0)`; `followCamera` passes `this.localSeatIndex`.
  - `fireSeats` samples the fire log for the seat whose index equals `game.localSeatIndex`, with that seat's own `inputs` and `controls` entries.

- [ ] **Step 1: Write the failing tests**

```js
test('a local seat index of 1 drives seat index 1 from input.state and seat index 0 from seatTwoState', async () => {
  const { game, input } = await createGame();
  game.setPlayerCount(2);
  game.setLocalSeat(1);
  game.start();
  const before = game.seats.map((seat) => seat.point.x);
  input.state.move = { x: 1, y: 0 };
  runFor(game, 0.5);
  assert.ok(game.seats[1].point.x > before[1] + 0.5);
  assert.equal(game.seats[0].point.x, before[0]);
  input.state.move = { x: 0, y: 0 };
  input.seatTwoState.move = { x: -1, y: 0 };
  runFor(game, 0.5);
  assert.ok(game.seats[0].point.x < before[0] - 0.5);
});

test('the seat 1 getters and the HUD fields follow the local seat', async () => {
  const { game } = await createGame();
  game.setPlayerCount(2);
  game.setLocalSeat(1);
  assert.equal(game.player, game.seats[1].player);
  assert.equal(game.weapons, game.seats[1].weapons);
  game.start();
  game.seats[1].swarm.killShip(game.seats[1].swarm.ships[0].slot);
  assert.equal(game.state.lives, 11);
  assert.equal(game.state.seats[0].ships, 12);
});

test('the fire log samples the local seat', async () => {
  const { game, input } = await createGame();
  const samples = [];
  game.setFireLog({ sample: (deltaSeconds, entry) => samples.push(entry) });
  game.setPlayerCount(2);
  game.setLocalSeat(1);
  game.start();
  input.state.firing = true;
  game.update(STEP);
  assert.equal(samples.at(-1).inputFiring, true);
});

test('with no live seat the camera frames the local seat', () => {
  const seat = (index) => ({ index, down: true, aliveCount: 0, cameraFocus: { x: index, y: 0 } });
  assert.deepEqual(framedFocuses([seat(0), seat(1)], 1), [{ x: 1, y: 0 }]);
  assert.deepEqual(framedFocuses([seat(0), seat(1)]), [{ x: 0, y: 0 }]);
});

test('setLocalSeat works in Ready only and in range; one seat and quitToTitle return it to 0', async () => {
  const { game } = await createGame();
  assert.throws(() => game.setLocalSeat(1), RangeError);
  game.setPlayerCount(2);
  game.setLocalSeat(1);
  game.start();
  assert.throws(() => game.setLocalSeat(0), /only in Ready/);
  game.quitToTitle();
  assert.equal(game.localSeatIndex, 0);
  game.setPlayerCount(2);
  game.setLocalSeat(1);
  game.setPlayerCount(1);
  assert.equal(game.localSeatIndex, 0);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/game/local-seat.test.js`
Expected: FAIL with `game.setLocalSeat is not a function`.

- [ ] **Step 3: Implement the interfaces above in `src/game/game.js` and `src/game/seats.js`**

`game.js` gains no net lines: the getters change their receiver only, and `setLocalSeat` replaces nothing, so keep it to 5 lines.

- [ ] **Step 4: Run the new tests and the whole suite**

Run: `node --test tests/game/local-seat.test.js` then `npm test`
Expected: PASS, with every existing test unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/game/game.js src/game/seats.js tests/game/local-seat.test.js
git commit -m "Thread the local seat index through the game"
```

### Task 1.2: Rumble routing and the Phase 1 gate

**Files:**
- Modify: `src/input/rumble.js` (add `rumblePadFor`), `src/main.js:142-152` (the life watcher and `withHaptics` `padForSeat`)
- Test: `tests/input/rumble.test.js` (append)

**Interfaces:**
- Consumes: `Game.localSeatIndex` (Task 1.1), `coopJoin.padForSeat(seat)` (`src/ui/coop-join.js:47`, couch meaning: 0 the first pad, 1 seat 2's pad).
- Produces: `rumblePadFor(seat, { localSeatIndex, remoteSeats, couchPadForSeat })`: `null` for a seat in `remoteSeats` (a `Set`), else `couchPadForSeat(seat === localSeatIndex ? 0 : 1)`. `main.js` builds one `padForSeat` from it with `remoteSeats` a frozen empty set for now (Task 6.4 supplies the online one) and passes `() => padForSeat(game.localSeatIndex)` to `createLifeWatcher`.

- [ ] **Step 1: Write the failing test**

```js
test('rumblePadFor routes the local seat to the first pad, the couch partner to its pad and a remote seat nowhere', () => {
  const couchPadForSeat = (seat) => (seat === 0 ? undefined : 3);
  const none = new Set();
  assert.equal(rumblePadFor(0, { localSeatIndex: 0, remoteSeats: none, couchPadForSeat }), undefined);
  assert.equal(rumblePadFor(1, { localSeatIndex: 0, remoteSeats: none, couchPadForSeat }), 3);
  assert.equal(rumblePadFor(1, { localSeatIndex: 1, remoteSeats: new Set([0]), couchPadForSeat }), undefined);
  assert.equal(rumblePadFor(0, { localSeatIndex: 1, remoteSeats: new Set([0]), couchPadForSeat }), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/input/rumble.test.js`
Expected: FAIL with `rumblePadFor is not a function`.

- [ ] **Step 3: Implement `rumblePadFor` and wire `main.js` as above**

- [ ] **Step 4: Run the Phase 1 gate**

Run: `npm test`, `npm run coverage`, `npm run build`, then on the GPU machine `SMOKE_PORT=5195 node tests/browser/coop.mjs`, `SMOKE_PORT=5196 node tests/browser/versus.mjs`, `SMOKE_PORT=5197 node tests/browser/hives.mjs`.
Expected: all exit 0; coverage at or above lines 92 and functions 86.

- [ ] **Step 5: Commit**

```bash
git add src/input/rumble.js src/main.js tests/input/rumble.test.js
git commit -m "Route rumble by the local seat index"
```

---

## Phase 2: Pure networking foundations

New directory `src/net/`, tests under `tests/net/`. Nothing here imports a browser global at module load; every browser object is a parameter.

### Task 2.1: Byte buffer, protocol constants and the snapshot codec

**Files:**
- Create: `src/net/byte-buffer.js`, `src/net/protocol.js`, `src/net/snapshot-codec.js`
- Test: `tests/net/byte-buffer.test.js`, `tests/net/snapshot-codec.test.js`

**Interfaces:**
- Produces:
  - `ByteWriter` (`u8`, `u16`, `u32`, `f32`, `f64`, `bytes() -> Uint8Array`, growing), `ByteReader(bytes)` (same reads, `remaining`; `RangeError` on a read past the end). Little-endian `DataView`.
  - `quantize(value, minimum, maximum, bits) -> integer` (clamped), `dequantize(code, minimum, maximum, bits) -> number`.
  - `protocol.js`: `PROTOCOL_VERSION = 1`; `Channel = Object.freeze({ State: 'state', Events: 'events' })`; `MESSAGE_SNAPSHOT = 1` (events use codes 16 and up, Task 2.2); `WEAPON_KIND_CODES = ['base', ...WEAPON_TYPE_NAMES]`; `ONLINE_MODES = [GameMode.Hives, GameMode.Versus]`; `SNAPSHOT_UPDATE_INTERVAL = 2`; `HOST_STATE_UPDATE_INTERVAL = 6`; `INTERPOLATION_DELAY_SECONDS = 0.1`; `MAXIMUM_EXTRAPOLATION_SECONDS = 0.1`; `DRAW_WINDOW_SECONDS = 0.2`; `START_LEAD_SECONDS = 0.5`; `RESUME_COUNTDOWN_SECONDS = 3`; `CONNECT_TIMEOUT_SECONDS = 10`; `CONNECTION_LOST_SECONDS = 10`; `PING_INTERVAL_SECONDS = 1`.
  - `encodeSnapshot(snapshot: SeatSnapshot) -> Uint8Array`, `decodeSnapshot(bytes) -> SeatSnapshot` (`RangeError` for a truncated message or another message type).
- Layout (pinned so the traffic budget holds): header `u8 type, u32 sequence, f64 matchSeconds, u8 seat, u8 flags` (bit 0 firing, 1 invulnerable, 2 beam, 3 host block, 4 host state); point `u16 x, u16 y` quantized over `[0, WORLD_WIDTH]` and `[0, WORLD_HEIGHT]`, `f32 velocityX, velocityY, aimX, aimY`; weapons `u8 armed` (index in `WEAPON_KIND_CODES`), `u8 tier`, `u16 charge` (over `[0, 1]`), `u8 railTurrets`, `u8 railTier`; ships: a 32-byte alive bitmap over 256 slots, then per alive slot in slot order `u16 x, u16 y, u8 heading` (over `[-PI, PI]`), then one 4-bit generation per alive ship packed two to a byte, then `u8 gunnerCount` and per gunner `u8 slot, u8 gunnerIndex`; beam five `f32`; host block `u8 gateCount` (255 for a null table) and per gate `f32 x, y, radius, u8 emit, species, u8 open, telegraph` (over `[0, 1]`), `u8 site` (255 for none), then `f32 speciesBias`, then `u8 wavePresent` and `u8 emitting, f32 remainingSeconds, f32 burstFraction`; host state `u32 sequence, u8 hiveCount` (0 for none) and per hive `u8 owner, u8 capturer` (255 for null), `u16 progress`, then `u8 holder, f32 holdSeconds, f64 score, u8 multiplier, u8 bombs`.

- [ ] **Step 1: Write the failing tests**

```js
const POSITION_TOLERANCE = 32 / 65535;
const HEADING_TOLERANCE = Math.PI / 256 + 1e-6;

test('a 12-ship seat snapshot round trips within the quantization', () => {
  const snapshot = sampleSnapshot({ shipCount: 12, gunners: [[3, 0], [7, 1]], generations: { 5: 9 } });
  const decoded = decodeSnapshot(encodeSnapshot(snapshot));
  assert.equal(decoded.sequence, snapshot.sequence);
  assert.equal(decoded.matchSeconds, snapshot.matchSeconds);
  decoded.ships.forEach((ship, index) => {
    const original = snapshot.ships[index];
    assert.equal(ship.slot, original.slot);
    assert.ok(Math.abs(ship.x - original.x) <= POSITION_TOLERANCE);
    assert.ok(Math.abs(ship.heading - original.heading) <= HEADING_TOLERANCE);
    assert.equal(ship.generation, original.generation);
    assert.equal(ship.gunnerIndex, original.gunnerIndex);
  });
  assert.deepEqual({ ...decoded.weapons, charge: 0 }, { ...snapshot.weapons, charge: 0 });
  assert.ok(Math.abs(decoded.weapons.charge - snapshot.weapons.charge) <= 1 / 65535);
});

test('a 256-ship snapshot without a host block stays within 1600 bytes', () => {
  assert.ok(encodeSnapshot(sampleSnapshot({ shipCount: 256 })).length <= 1600);
});

test('the host block and the host state round trip, nulls included', () => {
  const snapshot = sampleSnapshot({ shipCount: 3, host: SAMPLE_HOST_BLOCK, hostState: SAMPLE_HOST_STATE });
  const decoded = decodeSnapshot(encodeSnapshot(snapshot));
  assert.deepEqual(decoded.host.gates.gates.map((gate) => gate.site), [0, 1, 2, undefined]);
  assert.deepEqual(decoded.hostState.hives.map((hive) => [hive.owner, hive.capturer]), [[0, null], [null, 1], [null, null]]);
  assert.equal(decoded.hostState.score, SAMPLE_HOST_STATE.score);
  assert.equal(decodeSnapshot(encodeSnapshot({ ...snapshot, host: { gates: null, wave: null } })).host.wave, null);
});

test('a truncated snapshot or another message type throws RangeError', () => {
  const bytes = encodeSnapshot(sampleSnapshot({ shipCount: 4 }));
  assert.throws(() => decodeSnapshot(bytes.subarray(0, bytes.length - 1)), RangeError);
  assert.throws(() => decodeSnapshot(Uint8Array.of(16, 0, 0)), RangeError);
});

test('quantize clamps a position outside the world to its edge', () => {
  assert.equal(quantize(-1, 0, 32, 16), 0);
  assert.equal(quantize(40, 0, 32, 16), 65535);
});
```

`sampleSnapshot`, `SAMPLE_HOST_BLOCK` and `SAMPLE_HOST_STATE` live in `tests/net/net-fixtures.js` (new) so Tasks 2.2 and 3.x reuse them.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/byte-buffer.test.js tests/net/snapshot-codec.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `src/net/byte-buffer.js`, `src/net/protocol.js`, `src/net/snapshot-codec.js` to the layout above**

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test tests/net/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/net tests/net
git commit -m "Add the binary snapshot codec"
```

### Task 2.2: Event codec

**Files:**
- Create: `src/net/event-codec.js`
- Test: `tests/net/event-codec.test.js`

**Interfaces:**
- Consumes: `ByteWriter`, `ByteReader`, `PROTOCOL_VERSION`, `WEAPON_KIND_CODES`, `ONLINE_MODES` (Task 2.1).
- Produces: `encodeEvent(event) -> Uint8Array`, `decodeEvent(bytes) -> event` (`RangeError` for an unknown type code or truncation), `EVENT_TYPES` (the list below, in code order from 16). Fields (numbers `f64` for session and match seconds, `f32` otherwise, `u8` for seats, slots and generations, `u32` for identifiers):

| type | fields |
| --- | --- |
| `hello` | `version` |
| `ping` | `sessionSeconds, matchSeconds` |
| `pong` | `echoSessionSeconds, sessionSeconds, matchSeconds` |
| `ready` | none |
| `titleMode` | `mode` |
| `start` | `mode, startSessionSeconds` |
| `restartRequest` | none |
| `restart` | `startSessionSeconds` |
| `pause` | `seat` |
| `resumeRequest` | none |
| `resumeCountdown` | `endSessionSeconds` |
| `quit` | none |
| `shots` | `owner, matchSeconds, spawns: [{ x, y, velocityX, velocityY, radius, lifetime, kind, seed, extra }]` (`kind` `u8`, the rest `f32`; `u16` count) |
| `contactKills` | `kills: [{ slot, generation }]` |
| `pickupAnnounced` | `id, type, x, y` (`type` index in `PICKUP_TYPE_NAMES`) |
| `pickupExpired` | `id` |
| `pickupClaim` | `id, x, y` |
| `pickupCollected` | `id, seat, type, x, y` |
| `bombRequest` | `x, y` |
| `bombAnnounced` | `seat, x, y` |
| `hiveCaptured` | `hive, seat` |
| `wiped` | `seat, matchSeconds` |
| `result` | `winner` (255 for null), `draw, hives` (flag bits) |

- [ ] **Step 1: Write the failing tests**

```js
for (const event of SAMPLE_EVENTS) {
  test(`${event.type} round trips`, () => {
    assert.deepEqual(decodeEvent(encodeEvent(event)), event);
  });
}

test('a batch of 300 shots round trips at f32 precision', () => {
  const event = { type: 'shots', owner: 1, matchSeconds: 12.25, spawns: sampleSpawns(300) };
  const decoded = decodeEvent(encodeEvent(event));
  assert.equal(decoded.spawns.length, 300);
  assert.equal(decoded.spawns[299].velocityX, Math.fround(event.spawns[299].velocityX));
});

test('an unknown type code throws RangeError', () => {
  assert.throws(() => decodeEvent(Uint8Array.of(250)), RangeError);
});
```

`SAMPLE_EVENTS` (one per row above, every value already `Math.fround`-exact) and `sampleSpawns` go in `tests/net/net-fixtures.js`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/event-codec.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `src/net/event-codec.js`**

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test tests/net/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/net/event-codec.js tests/net
git commit -m "Add the binary event codec"
```

### Task 2.3: Signal codec (invite and reply)

**Files:**
- Create: `src/net/signal-codec.js`
- Test: `tests/net/signal-codec.test.js`

**Interfaces:**
- Consumes: `PROTOCOL_VERSION` (Task 2.1; if run before 2.1 lands, take `1` from a local constant and switch on merge).
- Produces:
  - `async encodeSignal({ kind: 'offer' | 'answer', sdp }) -> string`: base64url without padding of `deflate-raw` (`CompressionStream`) over the UTF-8 JSON `{ "v": PROTOCOL_VERSION, "k": kind, "s": sdp }`.
  - `async decodeSignal(text, expectedKind) -> { kind, sdp }`: trims whitespace; accepts a whole invite URL (uses what follows `#join=`); throws `SignalError` (`name === 'SignalError'`, `reason` one of `'malformed'`, `'wrongKind'`, `'version'`).
  - `inviteUrl(locationHref, encoded) -> string` (drops any existing fragment, appends `#join=` and the payload), `inviteFromHash(hash) -> string | null`.

- [ ] **Step 1: Write the failing tests**

```js
test('an offer round trips through base64url', async () => {
  const encoded = await encodeSignal({ kind: 'offer', sdp: SAMPLE_SDP });
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeSignal(`  ${encoded}\n`, 'offer'), { kind: 'offer', sdp: SAMPLE_SDP });
  assert.ok(encoded.length < SAMPLE_SDP.length);
});

test('a pasted reply that is not a reply says why', async () => {
  const offer = await encodeSignal({ kind: 'offer', sdp: SAMPLE_SDP });
  await assert.rejects(decodeSignal(offer, 'answer'), { name: 'SignalError', reason: 'wrongKind' });
  await assert.rejects(decodeSignal(inviteUrl('https://example.test/game/', offer), 'answer'), { reason: 'wrongKind' });
  await assert.rejects(decodeSignal('not a reply at all', 'answer'), { reason: 'malformed' });
  await assert.rejects(decodeSignal('', 'answer'), { reason: 'malformed' });
  await assert.rejects(decodeSignal(await encodeWithVersion(2, 'answer'), 'answer'), { reason: 'version' });
});

test('the invite link keeps the page address and replaces any fragment', () => {
  assert.equal(inviteUrl('https://example.test/game/#mix=abc', 'QQ'), 'https://example.test/game/#join=QQ');
  assert.equal(inviteFromHash('#join=QQ'), 'QQ');
  assert.equal(inviteFromHash('#mix=abc'), null);
  assert.equal(inviteFromHash(''), null);
});
```

`SAMPLE_SDP` (a realistic 2 to 3 kB offer with host and srflx candidates) and `encodeWithVersion` go in `tests/net/net-fixtures.js`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/signal-codec.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `src/net/signal-codec.js`** (`CompressionStream` and `DecompressionStream` through `Blob.stream().pipeThrough`; Node 22 has both globals)

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test tests/net/signal-codec.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/net/signal-codec.js tests/net
git commit -m "Add the invite and reply codec"
```

### Task 2.4: Session clock

**Files:**
- Create: `src/net/session-clock.js`
- Test: `tests/net/session-clock.test.js`

**Interfaces:**
- Produces: `SessionClock({ now })` (`now()` monotonic seconds):
  - `connect()` (session time 0 from here), `sessionSeconds`.
  - `matchSeconds`, `advanceMatch(deltaSeconds)`, `resetMatch()`, `setMatchRunning(running)`.
  - `ping() -> { type: 'ping', sessionSeconds, matchSeconds }`, `pong(ping) -> { type: 'pong', echoSessionSeconds, sessionSeconds, matchSeconds }`, `receivePong(pong)`.
  - `roundTripSeconds` (`null` before the first pong), `sessionOffsetSeconds` and `matchOffsetSeconds` (remote minus local, 0 before the first pong), each taken from the sample with the smallest round trip among the last `CLOCK_SAMPLE_COUNT = 8`; a pong received while the local match is not running leaves `matchOffsetSeconds` alone.
  - `toLocalSession(remoteSessionSeconds) -> number`, `remoteMatchNow() -> matchSeconds + matchOffsetSeconds`.

- [ ] **Step 1: Write the failing tests**

```js
test('a symmetric ping measures the round trip and the session offset', () => {
  let seconds = 100;
  const host = new SessionClock({ now: () => seconds });
  const guest = new SessionClock({ now: () => seconds + 5 });
  host.connect(); guest.connect();
  seconds += 1;
  const ping = host.ping();
  seconds += 0.04;
  const pong = guest.pong(ping);
  seconds += 0.04;
  host.receivePong(pong);
  assert.ok(Math.abs(host.roundTripSeconds - 0.08) < 1e-9);
  assert.ok(Math.abs(host.toLocalSession(pong.sessionSeconds) - (host.sessionSeconds - 0.04)) < 1e-9);
});

test('the smallest round trip of the last 8 samples wins', () => {
  // A 0.3 s sample then a 0.05 s sample: roundTripSeconds is 0.05 and the offset is that sample's.
});

test('the match offset compares match times at the moment of receipt', () => {
  // host match 10 at ping; guest match 10.02 when it answers 0.04 s later; host advanced 0.08 by receipt:
  // matchOffsetSeconds = 10.02 + 0.04 - 10.08 = -0.02 (within 1e-9); remoteMatchNow() = host.matchSeconds - 0.02.
});

test('a pong received while the local match is stopped keeps the old match offset', () => {
  // offset -0.02 as above; setMatchRunning(false); a pong implying +0.5: matchOffsetSeconds stays -0.02, sessionOffsetSeconds updates.
});
```

Write the outlined tests with the numbers in their comments as assertions.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/session-clock.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `src/net/session-clock.js`**

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test tests/net/session-clock.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/net/session-clock.js tests/net/session-clock.test.js
git commit -m "Add the session clock"
```

### Task 2.5: Transport interface and the memory transport

**Files:**
- Create: `src/net/transport.js` (the interface in prose, `TransportState` constants and `validateChannel(name)`), `src/net/memory-transport.js`
- Test: `tests/net/memory-transport.test.js`

**Interfaces:**
- Produces: `TransportState = Object.freeze({ Connecting: 'connecting', Open: 'open', Disconnected: 'disconnected', Closed: 'closed' })`; `createMemoryTransportPair({ delaySeconds = 0, lossFraction = 0, reorderSeconds = 0, random = Math.random })` returning `{ host, guest, advance(seconds), disconnect(), reconnect(), close() }`, where `host` and `guest` are Transport endpoints (Shared shapes), both `'open'` from creation. Delivery happens only inside `advance`. The `state` channel drops a message when `random() < lossFraction` and delays each by `delaySeconds + random() * reorderSeconds`; the `events` channel never drops, keeps order and delays by `delaySeconds`. While disconnected, `state` messages are dropped and `events` messages wait and are delivered after `reconnect`. `send` copies its bytes.

- [ ] **Step 1: Write the failing tests**

```js
test('messages arrive after the delay, events in order even with jitter on the state channel', () => {
  const pair = createMemoryTransportPair({ delaySeconds: 0.05, reorderSeconds: 0.04, random: sequenceRandom([0.9, 0.1, 0.5]) });
  const received = [];
  pair.guest.onMessage((channel, bytes) => received.push([channel, bytes[0]]));
  pair.host.send('state', Uint8Array.of(1));
  pair.host.send('state', Uint8Array.of(2));
  pair.host.send('events', Uint8Array.of(3));
  pair.host.send('events', Uint8Array.of(4));
  pair.advance(0.049);
  assert.deepEqual(received, []);
  pair.advance(0.1);
  assert.deepEqual(received.filter(([channel]) => channel === 'events'), [['events', 3], ['events', 4]]);
  assert.deepEqual(received.filter(([channel]) => channel === 'state').map(([, value]) => value), [2, 1]);
});

test('full loss drops every state message and no event', () => {
  // lossFraction 1, random () => 0: 10 state and 10 event sends, advance(1): no state and all 10 events, in order.
});
test('a disconnect drops state, holds events until reconnect, and both sides see the states', () => {
  // disconnect(): both onStateChange got 'disconnected'; one state and one event sent; advance(1): nothing arrives;
  // reconnect(): both got 'open'; advance(1): only the event arrives; close(): both got 'closed'.
});
test('mutating the sent array afterwards does not change the delivered bytes', () => {
  // const bytes = Uint8Array.of(1); send('events', bytes); bytes[0] = 9; advance(1): the received byte is 1.
});
```

`sequenceRandom(values)` (cycles through a list) goes in `tests/net/net-fixtures.js`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/memory-transport.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `src/net/transport.js` and `src/net/memory-transport.js`**

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test tests/net/memory-transport.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/net/transport.js src/net/memory-transport.js tests/net
git commit -m "Add the transport interface and an in-memory transport"
```

---

## Phase 3: The remote seat

### Task 3.1: Ship generations and the mirrored swarm

**Files:**
- Modify: `src/game/player-swarm.js` (`spawnShip` at :153-176, new `generationOf`, new `mirrorShips`), `src/game/player-seat.js` (constructor: `this.remote = false`)
- Create: `src/net/seat-snapshot.js`
- Test: `tests/game/player-swarm.test.js` (append), `tests/net/seat-snapshot.test.js`

**Interfaces:**
- Consumes: `SeatSnapshot` (Shared shapes), `encodeSnapshot` (Task 2.1).
- Produces:
  - `PlayerSwarm.generationOf(slot) -> 0..15`: a per-slot spawn counter (`Uint32Array`, incremented in `spawnShip`) masked to 4 bits. Kill and regrow in one update still changes it.
  - `PlayerSwarm.mirrorShips(entries, deltaSeconds) -> { lost: [{ slot, x, y }] }`: `entries` are `SeatSnapshot.ships`; listed slots become alive at the given place, heading and gunner index, every other slot dead; `aliveCount` equals `entries.length`; `previousX`/`previousY` take the slot's prior position, or the new one when the slot was dead or its generation changed; a slot that was alive and is now missing or carries another generation reports its old ship in `lost`; a newly alive slot's `bornTime` is the swarm time; `time` advances by `deltaSeconds`. The mirror generations live in their own `Uint8Array`, not in the slot objects.
  - `PlayerSeat.remote` (boolean, false; set by Task 3.3).
  - `buildSeatSnapshot(seat, { sequence, matchSeconds, firing, beam, invulnerable }) -> SeatSnapshot` with `host: null`, `hostState: null`.

- [ ] **Step 1: Write the failing tests**

```js
test('generationOf changes when a slot dies and regrows in the same update', () => {
  const swarm = new PlayerSwarm({ random: () => 0.5 });
  swarm.reset(5, 5, 3);
  const before = swarm.generationOf(1);
  swarm.killShip(1);
  swarm.spawnShip(5, 5);
  assert.notEqual(swarm.generationOf(1), before);
});

test('mirrorShips sets the alive ships, reports the lost ones and keeps the previous positions', () => {
  const swarm = new PlayerSwarm();
  swarm.mirrorShips([ship(0, 1, 1, 0), ship(1, 2, 2, 0)], 1 / 60);
  const { lost } = swarm.mirrorShips([ship(0, 1.5, 1, 0), ship(1, 2, 2, 1)], 1 / 60);
  assert.equal(swarm.aliveCount, 2);
  assert.deepEqual(lost, [{ slot: 1, x: 2, y: 2 }]);
  assert.equal(swarm.slots[0].previousX, 1);
  assert.equal(swarm.slots[0].x, 1.5);
  assert.equal(swarm.slots[1].previousX, 2, 'a new generation does not blend from the old ship');
  assert.deepEqual(swarm.mirrorShips([], 1 / 60).lost.map((entry) => entry.slot), [0, 1]);
});

test('buildSeatSnapshot carries the seat, its ships with generations and gunners, and encodes', () => {
  const seat = new PlayerSeat({ index: 1, random: () => 0.5 });
  seat.reset(12, { x: 26, y: 9 });
  const snapshot = buildSeatSnapshot(seat, { sequence: 7, matchSeconds: 3.5, firing: true, beam: null, invulnerable: false });
  assert.equal(snapshot.seat, 1);
  assert.equal(snapshot.ships.length, 12);
  assert.equal(snapshot.ships[0].generation, seat.swarm.generationOf(snapshot.ships[0].slot));
  assert.ok(encodeSnapshot(snapshot).length > 0);
});
```

`ship(slot, x, y, generation)` builds `{ slot, x, y, heading: 0, gunnerIndex: -1, generation }`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/game/player-swarm.test.js tests/net/seat-snapshot.test.js`
Expected: FAIL with `swarm.generationOf is not a function`.

- [ ] **Step 3: Implement the interfaces above**

- [ ] **Step 4: Run them and the whole suite**

Run: `node --test tests/game/ tests/net/` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/player-swarm.js src/game/player-seat.js src/net/seat-snapshot.js tests
git commit -m "Add ship generations and the mirrored swarm"
```

### Task 3.2: Remote seat driver

**Files:**
- Create: `src/net/remote-seat.js`
- Test: `tests/net/remote-seat.test.js`

**Interfaces:**
- Consumes: `SeatSnapshot`, `INTERPOLATION_DELAY_SECONDS`, `MAXIMUM_EXTRAPOLATION_SECONDS` (Task 2.1), `PlayerSwarm.mirrorShips` (Task 3.1).
- Produces: `RemoteSeatDriver({ seatIndex })`:
  - `receive(snapshot)`: ignores another seat's snapshot and a sequence already held; keeps at most 32, ordered by `sequence`; drops any older than the oldest kept.
  - `sample(renderMatchSeconds) -> SeatSample | null` (`null` before any snapshot): the two snapshots that bracket the render time give point, velocity, aim and each ship's position (linear) and heading (shortest arc); a ship present only in the newer one appears once the render time reaches it; a slot whose generation differs between the two takes the newer ship only once the render time reaches it, with no blend; past the newest snapshot the point and ships extrapolate along the velocity of the last two snapshots for at most `MAXIMUM_EXTRAPOLATION_SECONDS`, then hold; weapons, firing, invulnerable and beam come from the newest snapshot at or before the render time (the oldest when none is).
  - `apply(seat, renderMatchSeconds, deltaSeconds) -> { lost }`: writes the sample into `seat.player` (`positionX`, `positionY`, `velocityX`, `velocityY`, `aimX`, `aimY`), `seat.weapons` (`armed`, `tier`, `charge`, `railTurrets`, `railTier`), `seat.remoteFiring`, `seat.remoteInvulnerable`, `seat.remoteBeam` and `seat.swarm.mirrorShips`; does nothing before the first snapshot.
  - `suppress(slot, generation)`: that ship is left out of every later `apply` until a sample shows the slot dead or with another generation.
  - `newest` (the newest `SeatSnapshot` or `null`).

- [ ] **Step 1: Write the failing tests**

```js
const SNAPSHOT_SECONDS = 1 / 30;

test('two snapshots bracket the render time', () => {
  const driver = new RemoteSeatDriver({ seatIndex: 0 });
  driver.receive(seatAt({ sequence: 1, matchSeconds: 1, x: 10 }));
  driver.receive(seatAt({ sequence: 2, matchSeconds: 1 + SNAPSHOT_SECONDS, x: 11 }));
  const sample = driver.sample(1 + SNAPSHOT_SECONDS / 2);
  assert.ok(Math.abs(sample.point.x - 10.5) < 1e-9);
  assert.ok(Math.abs(sample.ships[0].x - 10.5) < 1e-9);
});

test('past the newest snapshot it extrapolates at most 0.1 s, then holds', () => {
  // snapshots at 2 (x 10) and 2 + 1/30 (x 10.1): velocity 3 per second.
  // sample(2 + 1/30 + 0.05).point.x is 10.25; sample(2 + 1/30 + 0.3).point.x is 10.4.
});

test('a snapshot arriving out of order still brackets correctly, and a duplicate is ignored', () => {
  // receive sequence 1 (t 1), 3 (t 1 + 2/30), then 2 (t 1 + 1/30), then 3 again:
  // sample(1 + 1.5 / 30) lies between 2 and 3; the driver holds 3 snapshots.
});

test('a regrown slot jumps to the new ship once the render time reaches it', () => {
  // slot 2 generation 1 at x 10 (t 1), generation 2 at x 14 (t 1 + 1/30): sample at the midpoint keeps generation 1 at
  // x 10 (no blend toward 14); sample at t 1 + 1/30 shows generation 2 at x 14.
});

test('a suppressed ship stays out until the slot dies or changes generation', () => {
  // suppress(3, 2); snapshots still list slot 3 generation 2: apply leaves it dead and aliveCount 11;
  // a snapshot listing slot 3 generation 3 brings it back.
});

test('before any snapshot apply leaves the seat as it was', () => {
  // a reset seat at (26, 9) with 12 ships: sample(5) is null; apply(seat, 5, 1 / 60) returns { lost: [] } and the point and ships are unchanged.
});
```

`seatAt` builds a 12-ship `SeatSnapshot` with every ship at `(x, 9)`; it goes in `tests/net/net-fixtures.js`. Spell out the outlined tests with the values in their comments.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/remote-seat.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `src/net/remote-seat.js`**

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test tests/net/remote-seat.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/net/remote-seat.js tests/net
git commit -m "Add the remote seat driver"
```

### Task 3.3: Online game adapter and the two-game harness

**Files:**
- Create: `src/net/online-game.js`, `tests/net/online-harness.js`
- Modify: `src/game/game.js` (constructor: `this.online = null`; `inputFor`: a remote seat reads `NEUTRAL_INPUT`, a frozen `InputState`; the steer and flock loop at :525-530 skips `seat.remote`, then `this.online?.applyRemoteSeats(this, deltaSeconds)`; last line of `update`: `this.online?.afterUpdate(this, deltaSeconds)`), `src/game/seats.js` (`uploadSwarms`: `invulnerable` also when `seat.remote`; `fireSeats` skips `seat.remote`)
- Test: `tests/net/online-game.test.js`

**Interfaces:**
- Consumes: `RemoteSeatDriver` (3.2), `buildSeatSnapshot` (3.1), `encodeSnapshot`, `decodeSnapshot`, `encodeEvent`, `decodeEvent`, `SessionClock`, Transport endpoints, `createMemoryTransportPair`, `Game.setLocalSeat`.
- Produces:
  - `OnlineGame({ role: 'host' | 'guest', transport, clock })`: `attach(game)` (two seats required, else `RangeError`; sets the local seat, 0 for the host and 1 for the guest, marks the other `remote = true`, sets `game.online = this`), `detach(game)` (clears both and calls `game.setLocalSeat(0)` once in Ready), `isHost`, `isGuest`, `localSeatIndex`, `remoteSeatIndex`, `queueEvent(event)` (sent on the events channel at the end of the update).
  - Hooks: `applyRemoteSeats(game, deltaSeconds)` (drains received messages, then `driver.apply(remoteSeat, clock.remoteMatchNow() - INTERPOLATION_DELAY_SECONDS, deltaSeconds)` and queues a loss shockwave, `game.queueImpulse(x, y, 0.12, false)`, per lost ship); `afterUpdate(game, deltaSeconds)` (advances the match clock while Playing and not paused, sends a snapshot every `SNAPSHOT_UPDATE_INTERVAL` updates, flushes queued events, pings every `PING_INTERVAL_SECONDS` of session time); `ping` and `pong` events are answered and fed to the clock as they are received. Task 5.2 moves the pinging to a session timer.
  - Harness: `createOnlinePair({ delaySeconds, lossFraction, reorderSeconds, random } = {}) -> { host, guest, pair, stepBoth(seconds), startMatch(mode) }`. `host` and `guest` are `createGame()` results plus their `online` adapters and fake clocks sharing one injected `now`; `stepBoth` runs `game.update(STEP)` on host then guest, then `pair.advance(STEP)` and the clock, per step; `startMatch(mode)` does `setPlayerCount(2)`, `attach`, `setMode(mode)`, `start()` on both (Phase 5 replaces it with the lifecycle). The harness also patches `queueSpawn(spawn, ...owner)` and `setBeam(beam, seat, owner)` to record owners, as `versusHarness` in `tests/game/versus-game.test.js:12-31` does, and `seededRandom(seed)` (mulberry32) for repeatable loss.

- [ ] **Step 1: Write the failing tests**

```js
test('on the guest, input.state drives seat index 1 and nothing drives seat index 0', async () => {
  const { guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  const before = guest.game.seats[0].point.x;
  guest.input.seatTwoState.move = { x: 1, y: 0 };
  guest.input.state.move = { x: -1, y: 0 };
  stepBoth(0.5);
  assert.ok(guest.game.seats[1].point.x < 26 - 0.5);
  assert.ok(Math.abs(guest.game.seats[0].point.x - before) < 1e-6);
});

test('each machine shows the other seat about 100 ms behind', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  const history = [];
  host.input.state.move = { x: 1, y: 0 };
  for (let index = 0; index < 60; index += 1) { stepBoth(STEP); history.push(host.game.seats[0].point.x); }
  const behind = history.at(-1 - Math.round(0.1 / STEP));
  assert.ok(Math.abs(guest.game.seats[0].point.x - behind) < 0.05);
});

test('the remote seat uploads invulnerable and the local seat does not', async () => {
  // after stepBoth(0.2): every host upload with seat 1 has invulnerable true, every seat 0 one false; the guest mirrors it.
});

test('each machine sends 30 snapshots a second', async () => {
  // count 'state' messages sent by the host endpoint over stepBoth(1): 30.
});

test('both cameras frame both swarms as the couch camera does', async () => {
  // after stepBoth(1): guest.game.camera.centerX within 0.3 of host.game.camera.centerX, and both near 16 (seats 20 apart);
  // guest camera zoom within 0.02 of the host's.
});

test('detach returns the local seat to 0 and clears the remote flag', async () => {
  // after the match, quitToTitle and detach on the guest: localSeatIndex 0, game.online null, no seat with remote true.
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/online-game.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `src/net/online-game.js` and the `game.js` and `seats.js` hooks**

The `game.js` hooks are one line each (four lines); remove four lines of now-redundant comment in the frame header (it moves to `online-game.js`'s header) so `game.js` stays at 849 lines or fewer.

- [ ] **Step 4: Run the new tests and the whole suite**

Run: `node --test tests/net/` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/net/online-game.js src/game/game.js src/game/seats.js tests/net
git commit -m "Drive a remote seat from snapshots"
```

### Task 3.4: Shot replay and the beam

**Files:**
- Create: `src/net/shot-relay.js`
- Modify: `src/game/seats.js` `fireSeats` (the local seat's `shots.spawns` and `shots.turretSpawns` also go to `game.online?.recordShots(seat.index, spawns)`; after the loop `game.online?.replayRemoteFire(game)`), `src/net/online-game.js`
- Test: `tests/net/shot-relay.test.js`, `tests/net/online-game.test.js` (append)

**Interfaces:**
- Consumes: the `shots` event (2.2), `clock.remoteMatchNow()` (2.4), `seat.remoteBeam` (3.2).
- Produces: `ageSpawn(spawn, ageSeconds) -> spawn | null` (age below 0 counts as 0; position advanced by velocity times age, lifetime cut by age; `null` when nothing is left); `ShotRelay` with `record(owner, spawns, matchSeconds)` (one `shots` event per update holding every spawn of that update, none when empty) and `replay(event, remoteMatchNow, projectiles)` (each aged spawn to `projectiles.queueSpawn(spawn, event.owner)`). `OnlineGame.recordShots(owner, spawns)`, `OnlineGame.replayRemoteFire(game)` (replays the received `shots` events, then `projectiles.setBeam(remoteSeat.remoteBeam, remoteIndex, remoteIndex)`, with `null` when the remote seat is not firing a beam).

- [ ] **Step 1: Write the failing tests**

```js
test('ageSpawn moves the shot along its velocity and cuts its lifetime by its age', () => {
  const spawn = { x: 1, y: 2, velocityX: 3, velocityY: -1, radius: 0.05, lifetime: 0.5, kind: 1, seed: 0.25, extra: 0 };
  assert.deepEqual(ageSpawn(spawn, 0.1), { ...spawn, x: 1.3, y: 1.9, lifetime: 0.4 });
  assert.equal(ageSpawn(spawn, 0.6), null);
  assert.deepEqual(ageSpawn(spawn, -0.2), spawn);
});

test('every host shot reaches the guest with its owner, aged by the delay', async () => {
  // delay 0.05; host.game.debugArm('scatter', 2); host fires for 1 s, then stepBoth(0.2) with fire released:
  // guest owner-0 spawns count equals host's own queued spawns; each guest copy's x equals the host's
  // x + velocityX * age with age within one STEP of 0.05.
});

test('the remote beam follows the remote seat and stops with it', async () => {
  // host debugArm('beam'), fire held 0.5 s: the guest's setBeam calls for seat 0 carry owner 0 and non-null beams;
  // 0.3 s after release the last one is null.
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/shot-relay.test.js tests/net/online-game.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement the interfaces above**

- [ ] **Step 4: Run them and the whole suite**

Run: `node --test tests/net/` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/net/shot-relay.js src/net/online-game.js src/game/seats.js tests/net
git commit -m "Replay the remote seat's shots and beam"
```

### Task 3.5: Growth scaling and local-only hits

**Files:**
- Modify: `src/game/versus-seats.js` (`growSwarms` :80-91 and `applyVersusHits` :95-102 each begin with `if (game.online) return game.online.growSwarms(game, stats);` and `... applyHits(game, stats);`), `src/net/online-game.js`
- Test: `tests/net/online-growth.test.js`

**Interfaces:**
- Consumes: `DENSITY_REFERENCE_CAPACITY` (`src/sim/species.js:43`, 524288), `hiveGrowth` (`src/game/hive-seats.js:50`).
- Produces: `onlineGrowth(kills, capacity) -> kills * DENSITY_REFERENCE_CAPACITY / capacity` (exported from `online-game.js`); `OnlineGame.growSwarms(game, stats)` grows the local seat alone by `onlineGrowth(hiveGrowth(game, stats, local, ownerKills[local]), game.capacity)`; `OnlineGame.applyHits(game, stats)` applies the local seat's mask alone (`seat.applyHits(stats)`), queues the 0.12 loss shockwaves, and on the local seat's wipe calls `this.reportWipe(game)` (a stub until Task 3.6 that queues the `wiped` event). Neither machine applies the remote seat's mask.

- [ ] **Step 1: Write the failing tests**

```js
test('online growth is normalized to the reference capacity', () => {
  assert.equal(onlineGrowth(100, 262144), 200);
  assert.equal(onlineGrowth(100, 524288), 100);
});

test('the host grows its own seat by scaled owned kills and never the remote one', async () => {
  // CAPACITY 262144: a host stats frame with ownerKillsSinceLastRead [100, 300] grows host seat 0 by 2 ships;
  // host seat 1 (remote) keeps the snapshot's count.
});

test('the remote seat hit mask kills nothing on this machine', async () => {
  // host stats frame with secondSwarmHitMask maskFor([0, 1, 2]): host seat 1 aliveCount unchanged until the guest's snapshot.
});

test('a capacity change mid-match rescales growth from the next frame and keeps the remote seat invulnerable', async () => {
  // set host.game.capacity = 524288 as CapacitySwap's install does (game.js:256); 100 owned kills now grow 1 ship;
  // the next host upload for seat 1 still has invulnerable true.
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/online-growth.test.js`
Expected: FAIL with `onlineGrowth is not a function`.

- [ ] **Step 3: Implement the interfaces above**

- [ ] **Step 4: Run them and the whole suite**

Run: `node --test tests/net/ tests/game/` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/versus-seats.js src/net/online-game.js tests/net
git commit -m "Grow and hit only the local seat online"
```

### Task 3.6: Match end through the host

**Files:**
- Create: `src/net/match-referee.js`
- Modify: `src/game/versus.js` (add `VersusMatch.announce(result)`: sets and returns the result once, `null` when already over), `src/net/online-game.js`
- Test: `tests/net/match-referee.test.js`, `tests/net/online-match.test.js`

**Interfaces:**
- Consumes: `endMatch(game, result, frameSequence, point)` (`src/game/match-end.js:15`), `DRAW_WINDOW_SECONDS` (0.2), the `wiped` and `result` events, `clock.matchOffsetSeconds`, `clock.roundTripSeconds`.
- Produces:
  - `MatchReferee({ drawWindowSeconds = DRAW_WINDOW_SECONDS })`: `reportWipe(seat, hostMatchSeconds)`, `decide(hostMatchSeconds, latencySeconds) -> null | { winner, draw, hives: false }` (with both wiped: a draw when the wipes are within the window, else the later-wiped seat wins; with one wiped: once `hostMatchSeconds >= firstWipe + drawWindowSeconds + latencySeconds` the other seat wins; returns a result once only), `reset()`.
  - `OnlineGame.reportWipe(game)`: the guest queues `wiped { seat: 1, matchSeconds }`; the host reports seat 0 to its referee. Host each update: `decide(clock.matchSeconds, (clock.roundTripSeconds ?? 0) / 2)`; a guest wipe report is converted to host match time by subtracting `matchOffsetSeconds`.
  - Results: the host, on a decided result or a new `versusMatch.result` from a hives hold, queues `result` and runs the match end; the guest runs it on the `result` event. Both run the match end the same way: `game.versusMatch.announce(result)`, then `endMatch(game, result, game.simulation.frameSequence, point)` with `point` the losing seat's centroid (its point when it has no ships). Online, `judgeMatch` in `versus-seats.js` must never run: `applyVersusHits` is routed to `game.online` since Task 3.5 and `applyShipContact` is routed in Task 3.7, so this task's tests keep the swarms apart.

- [ ] **Step 1: Write the failing tests**

```js
test('one wipe wins for the other seat after the draw window and the latency', () => {
  const referee = new MatchReferee();
  referee.reportWipe(1, 10);
  assert.equal(referee.decide(10.2, 0.05), null);
  assert.deepEqual(referee.decide(10.25, 0.05), { winner: 0, draw: false, hives: false });
  assert.equal(referee.decide(10.3, 0.05), null);
});

test('two wipes within 200 ms are a draw; further apart the later one wins', () => {
  // wipes at 10 (seat 1) and 10.15 (seat 0): decide(10.15, 0) is { winner: null, draw: true, hives: false };
  // wipes at 10 (seat 1) and 10.25 (seat 0) reported before deciding: winner 0.
});

test('a guest wipe ends the match on both with the same banner', async () => {
  // startMatch('versus'), delay 0.05: script a guest stats frame with secondSwarmHitMask SWARM_WIPE_MASK (seat index 1
  // reads the second mask, player-seat.js:118). Run until both phases are 'gameOver':
  // both matchResult deep-equal { winner: 0, draw: false, hives: false }; gameOverBanner(...).title is 'PLAYER 1 WINS' on both.
});

test('both seats wiped in the same moment is a draw on both', async () => {
  // in one stepBoth: host frame swarmHitMask SWARM_WIPE_MASK, guest frame secondSwarmHitMask SWARM_WIPE_MASK:
  // both matchResult { winner: null, draw: true, hives: false } and both banners 'DRAW'.
});

test('a remote snapshot showing no ships ends nothing by itself', async () => {
  // deliver a guest snapshot with ships [] to the host adapter directly; after one host update its phase is still 'playing'.
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/match-referee.test.js tests/net/online-match.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement the interfaces above**

- [ ] **Step 4: Run them and the whole suite**

Run: `node --test tests/net/ tests/game/` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/net/match-referee.js src/game/versus.js src/net/online-game.js tests/net
git commit -m "Judge online matches on the host with a draw window"
```

### Task 3.7: Host-refereed ship contact

**Files:**
- Modify: `src/game/versus-seats.js` `stepVersus` (:67-70: `if (game.online) { game.online.stepVersus(game, deltaSeconds); return; }`), `src/net/online-game.js`
- Test: `tests/net/online-contact.test.js`

**Interfaces:**
- Consumes: `contactPairs` (`src/game/ship-contact.js`), `SHIP_CONTACT_DISTANCE`, `RemoteSeatDriver.suppress`, `PlayerSwarm.generationOf`, the `contactKills` event.
- Produces: `OnlineGame.stepVersus(game, deltaSeconds)`. Host: with the same guards as `applyShipContact` (`versus-seats.js:105-107`, plus either seat's snapshot `invulnerable`), pairs `seats[0].swarm.ships` with the mirrored `seats[1].swarm.ships`; kills its own paired ships, removes each paired guest ship from its mirror at once and calls `driver.suppress(slot, generation)`, queues one `contactKills` event per update with every `{ slot, generation }`, and reports its own wipe; then `updateHives` as today (Task 4.2 adds the rest). Guest: kills each named ship whose `generationOf(slot)` matches, with the 0.12 shockwave, ignores the others, and reports its own wipe; it never pairs ships.

- [ ] **Step 1: Write the failing tests**

```js
test('one touch kills one ship on each side', async () => {
  // place host seat 0 ship slot 0 and guest seat 1 ship slot 0 at (16, 9) on their own machines and hold them there.
  // after stepBoth(0.3): host seat 0 aliveCount 11, guest seat 1 aliveCount 11.
});

test('a contact against a ship whose death the host has not seen yet kills only once', async () => {
  // lossFraction 1 on the state channel from the moment of contact: over 10 more updates the host kills no further ships.
});

test('a contact kill naming an older generation is ignored', async () => {
  // deliver contactKills [{ slot: 4, generation: (guest generationOf(4) + 15) % 16 }] to the guest: aliveCount unchanged.
});

test('the guest never pairs ships', async () => {
  // make the ships touch on the guest's screen only (move the guest's mirrored seat 0 ships onto its own each update,
  // the host keeps them apart): after stepBoth(0.3) both seats keep 12 ships on both machines.
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/online-contact.test.js`
Expected: FAIL (the host kills a ship on every update of the contact).

- [ ] **Step 3: Implement the interfaces above**

- [ ] **Step 4: Run them and the whole suite**

Run: `node --test tests/net/ tests/game/` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/versus-seats.js src/net/online-game.js tests/net
git commit -m "Referee ship contact on the host"
```

---

## Phase 4: The host-refereed systems

### Task 4.1: Gates and wave from the host

**Files:**
- Modify: `src/game/game.js` `spawnCounts` (:626-657; after the Dying check: `if (this.online?.isGuest) { this.stepGates = hiveGateTable(this, this.online.hostGates); return this.online.guestSpawns(this, deltaSeconds, pressure, shares); }`), `src/net/seat-snapshot.js` (the host block), `src/net/online-game.js`
- Test: `tests/net/online-gates.test.js`

**Interfaces:**
- Consumes: `SpawnDirector.spawnGates` and `.wave` (`src/sim/spawn-director.js:277-293`), `hiveGateTable` (called from `game.js` only, so `tests/game/hives-guard.test.js` stays as it is).
- Produces: the host's every snapshot carries `host: { gates: game.spawnDirector.spawnGates, wave: game.spawnDirector.wave }` (the raw director table, before `hiveGateTable`); `OnlineGame.hostGates` and `hostWave` (the newest received, `null` before the first); `OnlineGame.guestSpawns(game, deltaSeconds, pressure, shares)`: no director update; all zero counts while `hostGates` is `null`; otherwise `pressure.update(deltaSeconds, game.latestStats, shares, game.simulation.frameSequence + 1, this.hostWave)`. The `hiveGateTable` call stays on the `game.js` line, so `tests/game/hives-guard.test.js` is unchanged. This holds from the match start (`attach`) to its end; the title before a match keeps each machine's own director.

- [ ] **Step 1: Write the failing tests**

```js
test('the guest runs no director and spawns at the host gates', async () => {
  // spy on guest.game.spawnDirector.update: never called over stepBoth(2) of a versus match.
  // every non-null guest simulation step table, minus hive fields, deep-equals one of the host's director tables.
});

test('before the first host snapshot the guest spawns nothing', async () => {
  // lossFraction 1 from the start: every guest spawnBudgets entry after start is all zeros.
});

test('roaming gates follow the host view even when the guest window is narrower', async () => {
  // guest.game.setView({ width: 8, height: 9 }); versus: guest tables still equal host tables.
});

test('in hives the guest gate rows carry the owner and target from the host hive state', async () => {
  // set hivesOf(guest.game).hives[2].owner = 0 on the guest (Task 4.2 later feeds it from the host):
  // the guest row with site 2 has owner 0 and target 1.
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/online-gates.test.js`
Expected: FAIL (the guest's director is called).

- [ ] **Step 3: Implement the interfaces above**

- [ ] **Step 4: Run them and the whole suite**

Run: `node --test tests/net/ tests/game/` then `npm test`
Expected: PASS, `hives-guard.test.js` included.

- [ ] **Step 5: Commit**

```bash
git add src/game/game.js src/net tests/net
git commit -m "Spawn at the host's gates on the guest"
```

### Task 4.2: Hive state from the host

**Files:**
- Create: `src/net/host-state.js`
- Modify: `src/net/online-game.js` (`stepVersus`: the guest no longer calls `updateHives`; the host compares hive owners before and after `updateHives` and queues `hiveCaptured { hive, seat }`; the host puts `hostState` in every `HOST_STATE_UPDATE_INTERVAL`th update's snapshot)
- Test: `tests/net/host-state.test.js`, `tests/net/online-hives.test.js`

**Interfaces:**
- Consumes: `hivesOf(game)`, `Hives.hives`, `Hives.hold` (`holder`, `seconds`), `ScoreKeeper.score`, `.multiplier`, `RunState.bombs`.
- Produces: `buildHostState(game, sequence) -> HostState`; `applyHostState(game, state, lastSequence) -> appliedSequence` (writes each hive's `owner`, `capturer`, `progress` and `hold.holder`, `hold.seconds`; ignores a state whose `sequence` is not above `lastSequence`); `OnlineGame.hostState` (the newest applied, for Task 4.4). The guest plays the 0.4 capture shockwave on `hiveCaptured` and never runs `captureStep` or `HiveHold.update`. The hold win reaches the guest as a `result` with `hives: true` (Task 3.6).

- [ ] **Step 1: Write the failing tests**

```js
test('an older host state after a newer one changes nothing', () => {
  // apply sequence 5 (center progress 0.6), then sequence 4 (progress 0.2): progress stays 0.6 and the return value is 5.
});

test('the host captures the center hive and the guest shows the same owner', async () => {
  // startMatch('hives'): hold host seat 0's 12 ships inside the center hive (set slot positions each update).
  // after stepBoth(5.5): host hives[2].owner 0; within 0.2 s guest.game.state.hives.hives[2].owner 0; one capture shockwave of strength 0.4 on each.
});

test('the guest capturing its own hive is computed on the host from the guest ships', async () => {
  // hold guest seat 1's ships inside hive 1 on the guest: after stepBoth(5.5) host hives[1].owner 1 and, within 0.2 s, the guest's view agrees.
});

test('state channel loss during a capture still converges and never steps back', async () => {
  // lossFraction 0.5, reorderSeconds 0.05, seededRandom(7): sample guest center progress every update: never below the
  // previous sample while the host's only rises; 0.5 s after the host's capture the guest owner equals the host's.
});

test('a hold win reads PLAYER 1 WINS on both with hives true', async () => {
  // give host every hive, wind host hold.seconds to 19.9, stepBoth(0.5) and run to game over: both results { winner: 0, draw: false, hives: true }.
});

test('the guest never calls captureStep', async () => {
  // spy on guest.game.versusMatch.hives.update: uncalled over stepBoth(3).
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/host-state.test.js tests/net/online-hives.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement the interfaces above**

- [ ] **Step 4: Run them and the whole suite**

Run: `node --test tests/net/ tests/game/` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/net tests/net
git commit -m "Send hive state from the host"
```

### Task 4.3: Pickups with identifiers and claims

**Files:**
- Create: `src/net/pickup-ledger.js`, `src/game/pickup-collect.js` (moves `Game.collectFor`, `game.js:593-617`, out of `game.js` as `collectFor(game, seat)` built on a new `applyCollection(game, seat, type, x, y, { arm = true } = {})`)
- Modify: `src/game/game.js` (:534-543: the guest ages its pickups, `this.online.agePickups(deltaSeconds)`, in place of `this.pickups.update`; collection becomes `if (!seat.down && !seat.remote) (this.online ? this.online.collectFor(this, seat) : collectFor(this, seat))`), `src/net/online-game.js`
- Test: `tests/net/pickup-ledger.test.js`, `tests/net/online-pickups.test.js`

**Interfaces:**
- Consumes: `PickupDirector` (`pickups`, `fadeSeconds`, `rotation`), `SWARM_PICKUP_RADIUS`, the `pickupAnnounced`, `pickupExpired`, `pickupClaim` and `pickupCollected` events.
- Produces:
  - `findReachedPickup(seat, pickups) -> pickup | null`: the nearest pickup within 0.35 of the point (as `PickupDirector.collect`), else within `SWARM_PICKUP_RADIUS` of a ship; removes nothing.
  - `PickupLedger` (host): `observe(pickups) -> { announced: [{ id, type, x, y }], expired: [id] }` by object identity (a `WeakMap`, ids counting up from 1, never reused in a session); `take(id, pickups) -> pickup | null` (removes it; `null` once gone).
  - `GuestPickups` (guest): `announce({ id, type, x, y })`, `remove(id)`, `age(deltaSeconds, fadeSeconds)` (writes `age` and `fade` on `game.pickups.pickups`, never removes), `claim(id) -> boolean` (true once per id), `pending`.
  - `OnlineGame.collectFor(game, seat)` (the local seat's reach: the host takes at once, the guest claims) and `OnlineGame.agePickups(deltaSeconds)` (guest only; the host also runs the ledger right after its `pickups.update`).
  - Host flow: after `pickups.update`, announce and expire through the ledger; its own seat's reach takes the pickup at once and queues `pickupCollected { id, seat: 0, type, x, y }` with its point; a guest claim is granted when `take` succeeds, queueing `pickupCollected { id, seat: 1, ... }` with the claim's `x, y`. Both machines, on a collection: the collector's own machine runs `applyCollection(game, seat, type, x, y)`; the other runs it with `{ arm: false }` (blast, radial kill at `x, y` with `pickupBlastRadius`, shockwave, no weapon change). The guest removes the pickup on `pickupCollected` or `pickupExpired` and drops its pending claim.

- [ ] **Step 1: Write the failing tests**

```js
test('both players reaching one pickup in the same moment: only the host collects', async () => {
  // startMatch('versus'), delay 0.05; host director spawns a 'scatter' pickup; place both seats' points on it in the same update.
  // after stepBoth(0.3): host armed 'scatter', guest local seat armed 'base'; no pickups on either; each machine's
  // radialKills has exactly one entry at the host point with radius 1.5.
});

test('a guest claim is granted and the guest arms the weapon', async () => {
  // guest point on the pickup: guest armed type equals the pickup type; both radial kills at the guest's claim point.
});

test('a pickup that expires on the host disappears on the guest', async () => {
  // nobody reaches it: after 10.2 s (fadeSeconds 10) neither pickup list holds it; the guest's fade fell below 0.05 before it went.
});

test('a refused claim never fires later', async () => {
  // after the same-moment test, step 2 more seconds: guest armed still 'base', no pickupClaim re-sent.
});

test('the guest never runs the pickup director', async () => {
  // spy on guest.game.pickups.update: uncalled; announced positions equal on both.
});

test('the ledger gives ids by identity and announces expiry once', () => {
  // observe([a, b]) announces ids 1 and 2; observe([a, b]) announces nothing; observe([b]) expires [1]; observe([b]) expires [];
  // take(2, list) returns b and empties list; take(2, list) returns null.
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/pickup-ledger.test.js tests/net/online-pickups.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement the interfaces above** (moving `collectFor` out shrinks `game.js` by about 22 lines)

- [ ] **Step 4: Run them and the whole suite**

Run: `node --test tests/net/ tests/game/` then `npm test`
Expected: PASS, every couch pickup test unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/net src/game/pickup-collect.js src/game/game.js tests/net
git commit -m "Referee pickups on the host with claims"
```

### Task 4.4: Bomb pool and the shared HUD numbers

**Files:**
- Create: `src/game/bomb-step.js` (moves `game.js:511-521` into `pressBombs(game, inputs)`; online it calls `game.online.pressBomb(game, seat)` in place of the local `useBomb` and radial kill)
- Modify: `src/game/game.js` (call `pressBombs`; `state` spreads `...this.online?.sharedHud` last; `processStats` :676-683 skips `score.recordKills` and the awards when `this.online?.isGuest`), `src/net/online-game.js`
- Test: `tests/net/online-bombs.test.js`

**Interfaces:**
- Consumes: `RunState.useBomb`, `bombRadiusForView` (`src/game/camera.js:80`), `VIEW_WIDTH`, `VIEW_HEIGHT`, the `bombRequest` and `bombAnnounced` events, `OnlineGame.hostState` (Task 4.2).
- Produces: `ONLINE_BOMB_RADIUS = bombRadiusForView(VIEW_WIDTH, VIEW_HEIGHT)` (`src/net/online-game.js`); `OnlineGame.pressBomb(game, seat)`: the host spends `run.useBomb(center)` for its own seat or a granted request, requests the radial kill at once and queues `bombAnnounced { seat, x, y }`; the guest queues `bombRequest { x, y }` with its centroid (its point with no ships) and changes nothing locally; the guest on `bombAnnounced` requests the radial kill at `x, y` with `ONLINE_BOMB_RADIUS`, queues the bomb shockwave (strength 1, bloom) and calls `effects.bomb(seat)`. `OnlineGame.sharedHud`: the guest returns `{ score, multiplier, bombs }` from `hostState` (`{}` before the first); the host returns `{}`.

- [ ] **Step 1: Write the failing tests**

```js
test('a guest bomb spends the host pool and clears at the guest centroid on both', async () => {
  // guest.game.setView({ width: 8, height: 9 }); guest bomb press: host run.bombs 3 to 2; both radialKills end with
  // { x, y } equal to the guest centroid at the press and radius ONLINE_BOMB_RADIUS.
});

test('a host bomb clears at the host centroid on both', async () => {
  // host bomb press: both radialKills end with the host centroid and ONLINE_BOMB_RADIUS; guest effects.bomb called with 0.
});

test('a guest press with an empty pool clears nothing anywhere', async () => {
  // host run.bombs spent to 0 first: a guest press adds no radialKills entry on either machine and bombs stay 0.
});

test('the guest HUD shows the host score, multiplier and bombs, not its own kills', async () => {
  // host stats frame killsSinceLastRead 500; guest stats frame killsSinceLastRead 900:
  // within 0.2 s guest.game.state.score equals host.game.state.score; guest.game.score.score stays 0.
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/online-bombs.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement the interfaces above**

- [ ] **Step 4: Run them and the whole suite**

Run: `node --test tests/net/ tests/game/` then `npm test`; `wc -l src/game/game.js`
Expected: PASS; `game.js` at most 849 lines.

- [ ] **Step 5: Commit**

```bash
git add src/game/bomb-step.js src/game/game.js src/net tests/net
git commit -m "Share the bomb pool and the host's score online"
```

---

## Phase 5: The lifecycle

### Task 5.1: Session lifecycle (pure)

**Files:**
- Create: `src/net/lifecycle.js`
- Test: `tests/net/lifecycle.test.js`

**Interfaces:**
- Consumes: `START_LEAD_SECONDS`, `RESUME_COUNTDOWN_SECONDS`, `CONNECTION_LOST_SECONDS` (Task 2.1).
- Produces: `LifecyclePhase = Object.freeze({ Title, Starting, Playing, Paused, Countdown, Lost, Ended })` (string values `'title'` and so on); `SessionLifecycle({ role })`. Every method returns `{ send: event[], actions: action[] }`; actions are `{ type: 'start', mode }`, `{ type: 'restart' }`, `{ type: 'pause', by }` (`by` a seat, or `null` with `lost: true`), `{ type: 'resume' }`, `{ type: 'end', reason }` (`'quit'`, `'remoteQuit'`, `'lost'`, `'version'`).
  - `setLocalReady()`, `setRemoteReady()`, `bothReady`, `waitingFor` (`'local'`, `'remote'` or `null`).
  - `requestStart(mode, sessionSeconds)`: host only (`Error` on the guest); nothing until both are ready; sends `start` with `startSessionSeconds = sessionSeconds + START_LEAD_SECONDS`. `receiveStart(event, localStartSessionSeconds)` and the host itself enter Starting.
  - `requestRestart(sessionSeconds)`: the guest sends `restartRequest`; the host (its own or on receipt) sends `restart` 0.5 s ahead; both enter Starting with `restart: true`.
  - `pause(seat)` from Playing, Starting or Countdown sends `pause` and acts `pause`; `receivePause(seat)` acts `pause`; a pause while Paused keeps the first `by`.
  - `requestResume(sessionSeconds)` from Paused: the guest sends `resumeRequest`; the host sends `resumeCountdown` with `endSessionSeconds = sessionSeconds + RESUME_COUNTDOWN_SECONDS`; both enter Countdown.
  - `tick(sessionSeconds)`: Starting at its moment acts `start` (or `restart`) and enters Playing; Countdown at its end acts `resume`; `countdownNumber` is `Math.ceil(remaining)` (3, 2, 1) or `null`; Lost past `since + CONNECTION_LOST_SECONDS` acts `end` `'lost'`.
  - `connectionChanged(state, sessionSeconds)`: `'disconnected'` enters Lost and acts `pause` with `lost: true`; `'open'` from Lost enters Paused with `by: null`; `'closed'` acts `end` `'lost'`.
  - `quit()` sends `quit`, acts `end` `'quit'`; `receiveQuit()` acts `end` `'remoteQuit'`; `versionMismatch()` acts `end` `'version'`.

- [ ] **Step 1: Write the failing tests**

```js
test('the host start waits for both ready flags and lands half a second ahead', () => {
  const host = new SessionLifecycle({ role: 'host' });
  host.setLocalReady();
  assert.deepEqual(host.requestStart('hives', 20).send, []);
  host.setRemoteReady();
  const { send } = host.requestStart('hives', 20);
  assert.deepEqual(send, [{ type: 'start', mode: 'hives', startSessionSeconds: 20.5 }]);
  assert.deepEqual(host.tick(20.49).actions, []);
  assert.deepEqual(host.tick(20.5).actions, [{ type: 'start', mode: 'hives' }]);
  assert.throws(() => new SessionLifecycle({ role: 'guest' }).requestStart('hives', 0));
});

test('the countdown reads 3, 2, 1 and resumes at zero', () => {
  // host paused at 30; requestResume(30): countdownNumber after tick(30) 3, tick(31.2) 2, tick(32.5) 1; tick(33) acts resume.
});

test('a pause during the countdown means it never resumes', () => {
  // countdown ending at 33; receivePause(1) at 32.9; tick(33.5) and tick(40) act nothing; phase Paused, by 1.
});

test('a lost connection ends the session after 10 s unless it comes back', () => {
  // connectionChanged('disconnected', 50): pause with lost; tick(59.99) nothing; tick(60) end 'lost'.
  // a second lifecycle reconnecting at 54: phase Paused, tick(61) nothing.
});

test('restart and quit work from either side', () => {
  // guest requestRestart(40) sends [{ type: 'restartRequest' }]; host receiving it sends restart with startSessionSeconds 40.5
  // and tick(40.5) acts [{ type: 'restart' }]; guest quit() sends quit and acts end 'quit'; host receiveQuit() acts end 'remoteQuit'.
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/lifecycle.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `src/net/lifecycle.js`**

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test tests/net/lifecycle.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/net/lifecycle.js tests/net/lifecycle.test.js
git commit -m "Add the online session lifecycle"
```

### Task 5.2: Online session

**Files:**
- Create: `src/net/online-session.js`
- Modify: `src/game/game.js` `updateGameOver` (:620-623: `if (pressed && this.gameOverSeconds > RESTART_GUARD_SECONDS) (this.online ? this.online.requestRestart() : this.restart());`), `src/net/online-game.js` (`requestRestart` forwards to the session), `tests/net/online-harness.js` (`createOnlinePair` builds sessions; `startMatch(mode)` goes through `session.start`)
- Test: `tests/net/online-session.test.js`

**Interfaces:**
- Consumes: `SessionLifecycle` (5.1), `OnlineGame` (Phase 3 and 4), `SessionClock`, Transport endpoints, the `hello`, `ready`, `titleMode`, `start`, `restart`, `pause`, `resumeCountdown`, `quit` events.
- Produces: `OnlineSession({ role, transport, clock, game, setTimer, clearTimer, onAction })`:
  - On transport `'open'`: `clock.connect()`, send `hello { version: PROTOCOL_VERSION }`; a different version ends the session with `'version'`.
  - `markReady()` (local loading and warm-up done), `setTitleMode(mode)` (host; sends `titleMode`), `remoteTitleMode`, `start(mode)` (host), `pause()`, `resume()`, `restart()`, `quit()`, `phase`, `pausedBy`, `countdownNumber`, `roundTripMilliseconds` (rounded, `null` before the first pong), `waitingFor`, `dispose()`.
  - Applies actions to the game: `start` runs `game.setPlayerCount(2)`, `onlineGame.attach(game)`, `game.setMode(mode)`, `game.start()`, `clock.resetMatch()`; `pause` runs `game.pause()`; `resume` runs `game.resume()`; `restart` runs `game.restart()` and `clock.resetMatch()`; `end` runs `game.quitToTitle()`, `onlineGame.detach(game)`, `transport.close()`. Every action is also passed to `onAction` for the screens.
  - Pinging moves here from `OnlineGame.afterUpdate`: a `setTimer` cadence of `PING_INTERVAL_SECONDS` from `'open'` on, at the title, in play and while paused, so the connected title can show the round trip before any match.
  - Each scheduled moment (start, restart, countdown end, the lost deadline) is set with `setTimer` when it is learned, and `tick` also runs on every `afterUpdate`; nothing waits on animation frames. Transport messages are handled in the transport's own handler, so a pause arrives while the game is paused or the tab draws no frames.

- [ ] **Step 1: Write the failing tests**

```js
test('the host start begins both matches at the same moment', async () => {
  // both markReady; host session.start('hives'): neither run.phase is 'playing' before the fake timers reach 0.5 s;
  // after, both are 'playing' in mode 'hives', host local seat 0, guest local seat 1.
});

test('a pause on the guest pauses the host with the guest named', async () => {
  // guest session.pause(): host game.paused true and host session.pausedBy 1.
});

test('the countdown runs on both and a pause from a hidden guest tab cancels it', async () => {
  // host session.resume(): both countdownNumber 3. Advance fake time 2 s with no game.update calls on the guest
  // (no frames), then guest session.pause() as its visibilitychange handler would: after 3 more seconds both games paused.
});

test('either player restarts from game over and both restart', async () => {
  // end a match; guest session.restart(): after the 0.5 s timer both phases 'playing', scores 0, hives all neutral.
});
test('a quit by either returns both to a co-op title with one seat', async () => {
  // guest session.quit(): both games phase 'ready', mode 'coop', playerCount 1, online null; both transports closed.
});
test('a dropped connection pauses both, and 10 s later both are at the title', async () => {
  // pair.disconnect(): both paused with an action { type: 'pause', by: null, lost: true }; fake time +10 s: both 'ready', end 'lost'.
});
test('a protocol version mismatch ends the session on both', async () => {
  // the guest's hello carries version 2: both act end 'version' and both games are at the title.
});
test('a guest game-over press asks for a restart instead of restarting alone', async () => {
  // guest at game over past RESTART_GUARD_SECONDS, fire pressed: guest restart() not called locally; a restartRequest is sent.
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/online-session.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `src/net/online-session.js` and the `game.js` restart hook**

- [ ] **Step 4: Run them and the whole suite**

Run: `node --test tests/net/` then `npm test`
Expected: PASS (the Phase 3 and 4 tests now start their matches through the session).

- [ ] **Step 5: Commit**

```bash
git add src/net src/game/game.js tests/net
git commit -m "Run the online session lifecycle on both games"
```

### Task 5.3: Full simulation rate while online

**Files:**
- Modify: `src/game/game.js:482-490` (`setSimulationRate`, `simulationRate`)
- Test: `tests/game/full-rate-lock.test.js`

**Interfaces:**
- Produces: `Game.setFullRateLock(locked)`; `setSimulationRate(rate)` records the requested rate; while locked the game steps every update and `simulationRate` reads `'full'`; unlocking restores the requested rate. `OnlineGame.attach` locks and `detach` unlocks (one line each, added in this task if Phase 3 has landed, else in Task 6.4).

- [ ] **Step 1: Write the failing test**

```js
test('the full-rate lock overrides half rate and gives it back', async () => {
  const { game, simulation } = await createGame();
  game.setSimulationRate('half');
  game.setFullRateLock(true);
  assert.equal(game.simulationRate, 'full');
  const steps = simulation.frameSequence;
  game.update(STEP); game.update(STEP);
  assert.equal(simulation.frameSequence - steps, 2);
  game.setSimulationRate('half');
  assert.equal(game.simulationRate, 'full', 'a preset applied while locked stays full');
  game.setFullRateLock(false);
  assert.equal(game.simulationRate, 'half');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/game/full-rate-lock.test.js`
Expected: FAIL with `game.setFullRateLock is not a function`.

- [ ] **Step 3: Implement it in `game.js` without net growth** (fold the two rate fields into the existing three lines)

- [ ] **Step 4: Run it and the whole suite**

Run: `node --test tests/game/full-rate-lock.test.js` then `npm test`
Expected: PASS, `tests/game/quality.test.js` unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/game/game.js tests/game/full-rate-lock.test.js
git commit -m "Lock the simulation to full rate on request"
```

---

## Phase 6: The real transport and the screens

### Task 6.1: ICE configuration and the RTC transport

**Files:**
- Create: `src/net/ice-configuration.js`, `src/net/rtc-transport.js`
- Test: `tests/net/rtc-transport.test.js` (a fake `RTCPeerConnection` class with fake data channels, written in the test)

**Interfaces:**
- Consumes: the Transport interface and `TransportState` (Task 2.5).
- Produces:
  - `ICE_SERVERS = Object.freeze([{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }])` (primary, fallback), `ICE_GATHER_CAP_SECONDS = 3`.
  - `createRtcConnection({ PeerConnection, iceServers = ICE_SERVERS, gatherCapSeconds = ICE_GATHER_CAP_SECONDS, setTimer, clearTimer }) -> { transport, createOffer(), acceptOffer(offerSdp), acceptAnswer(answerSdp), close() }`. Two negotiated channels: `state` `{ ordered: false, maxRetransmits: 0, negotiated: true, id: 0 }`, `events` `{ ordered: true, negotiated: true, id: 1 }`, `binaryType = 'arraybuffer'`. `createOffer` and `acceptOffer` resolve with `localDescription.sdp` once ICE gathering completes or after the cap. `acceptAnswer` a second time rejects (`Error`, message `the invite was already answered`). `transport.state` is `'open'` once `connectionState` is `'connected'` and both channels are open; `'disconnected'` maps to `'disconnected'`; `'failed'` and `'closed'` map to `'closed'`. Before `'open'`, `events` messages queue and flush on open, `state` messages drop.

- [ ] **Step 1: Write the failing tests**

```js
test('the two channels are negotiated with the pinned options', async () => {
  const connection = createRtcConnection({ PeerConnection: FakePeerConnection, setTimer: fakeTimers.set, clearTimer: fakeTimers.clear });
  assert.deepEqual(FakePeerConnection.last.channelOptions, {
    state: { ordered: false, maxRetransmits: 0, negotiated: true, id: 0 },
    events: { ordered: true, negotiated: true, id: 1 },
  });
  assert.deepEqual(FakePeerConnection.last.configuration.iceServers, ICE_SERVERS);
});

test('the offer waits for gathering to complete, or for the 3 s cap', async () => {
  // fake fires icegatheringstatechange 'complete': createOffer resolves with the fake's localDescription.sdp;
  // a second fake that never completes resolves only when the 3 s fake timer fires.
});
test('a second answer is refused', async () => {
  // acceptAnswer(sdp) resolves; acceptAnswer(sdp) again rejects with /already answered/.
});
test('the connection states map onto the transport states', async () => {
  // connectionState 'connected' plus both channels open: 'open'; 'disconnected': 'disconnected'; 'failed': 'closed'.
});
test('events sent before open are delivered on open and state messages are dropped', async () => {
  // send('events', a) and send('state', b) before open: on open the events channel's send got a, the state channel got nothing.
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/net/rtc-transport.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement both files**

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test tests/net/rtc-transport.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/net/ice-configuration.js src/net/rtc-transport.js tests/net/rtc-transport.test.js
git commit -m "Add the WebRTC transport"
```

### Task 6.2: Host and Join panels

**Files:**
- Create: `src/ui/online-panel.js`, `src/ui/online.css` (linked from `index.html` beside `menu.css`)
- Test: `tests/ui/online-panel.test.js` (its own fake document, in the style of `tests/ui/menu.test.js:5-24`, plus a fake clipboard)

**Interfaces:**
- Consumes: `decodeSignal`, `SignalError` (Task 2.3).
- Produces: `createOnlinePanel(parent, { documentObject, clipboard, onReply(text), onCancel })` returning `{ element, visible, showHost(), showJoin(), setInvite(url), setReply(text), setConnecting(), showMessage(text), hide() }`. Host mode: a status line, **Copy invite link** (ghosted until `setInvite`), a reply text box, **Paste reply** (reads `clipboard.readText()` into the box and submits), **Cancel**. Join mode: status line, **Copy reply** (ghosted until `setReply`), **Cancel**. Both modes' elements exist from creation; switching modes and messages change text and `visibility`, never the layout. A submitted reply is checked with `decodeSignal(text, 'answer')` before `onReply` is called; after one accepted reply further submits are ignored until `showHost()` again. Messages for the errors: `malformed` "That is not a reply from this game.", `wrongKind` "That is the invite link. Your friend opens it and sends you back the reply.", `version` "Both players need to reload the page." A rejected clipboard read says "Paste the reply into the box."

- [ ] **Step 1: Write the failing tests**

```js
test('every button is laid out from the start in both modes', () => {
  const panel = createOnlinePanel(parent, { documentObject, clipboard, onReply, onCancel });
  const count = allButtons(panel.element).length;
  panel.showHost(); assert.equal(allButtons(panel.element).length, count);
  panel.showJoin(); assert.equal(allButtons(panel.element).length, count);
  assert.equal(button(panel, 'Copy invite link').attributes['aria-disabled'], 'true');
});

test('pasting the invite instead of a reply explains it and does not connect', async () => {
  clipboard.text = await encodeSignal({ kind: 'offer', sdp: SAMPLE_SDP });
  await button(panel, 'Paste reply').fire('click');
  assert.equal(replies.length, 0);
  assert.match(panel.messageText, /invite link/);
});

test('a valid reply connects once even when pasted twice', async () => {
  // clipboard holds an encoded answer: two Paste reply clicks call onReply once with that text.
});
test('a refused clipboard read asks to paste into the box', async () => {
  // clipboard.readText rejects: messageText is 'Paste the reply into the box.' and onReply is not called.
});
test('garbage and a newer protocol version give their messages', async () => {
  // box text 'hello' then submit: 'That is not a reply from this game.'; a version 2 answer: 'Both players need to reload the page.'
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/ui/online-panel.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement the panel and its stylesheet** (menu style: same font, backdrop and focus look as `menu.css`)

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test tests/ui/online-panel.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/online-panel.js src/ui/online.css index.html tests/ui/online-panel.test.js
git commit -m "Add the Host and Join panels"
```

### Task 6.3: The ONLINE title item and the connected title

**Files:**
- Modify: `src/ui/menu.js:142-157` (`createMenu` gains `onlineItem = null`, placed after the mode item; Play gets `id: 'play'`, Lab `id: 'lab'`), `src/ui/mode-choice.js` (online cycle), `src/ui/menu.css`
- Create: `src/ui/online-title.js`
- Test: `tests/ui/online-title.test.js`, `tests/ui/mode-choice.test.js` (append), `tests/ui/menu.test.js` (append)

**Interfaces:**
- Produces:
  - `ONLINE_MODE_CYCLE = Object.freeze([GameMode.Hives, GameMode.Versus])`; `ModeChoice.setOnline(role)` (`'host'`, `'guest'` or `null`): the host starts on hives and toggles between hives and versus only; the guest's item is disabled and shows `setRemoteMode(mode)`; `null` returns to the couch behavior (co-op, ghosted SOLO without player 2). `modeItemView` reflects it.
  - `onlineTitleView({ connected, role, roundTripMilliseconds, waitingFor })` returns `{ onlineLabel, statusLine, playLabel, playEnabled, labEnabled }`: not connected `{ 'ONLINE', '', 'Play', true, true }`; connected host `{ 'DISCONNECT', 'PLAYER 2 CONNECTED ONLINE (42 MS)', 'Play', waitingFor === null, false }` with `playLabel` 'WAITING FOR PLAYER 2 TO LOAD' while the guest loads; connected guest `{ 'DISCONNECT', 'CONNECTED TO PLAYER 1 ONLINE (42 MS)', 'WAITING FOR THE HOST TO START', false, false }`.
  - `createOnlineTitle(menuElement, { documentObject })` with `update(view, { visible })`: one status line in seat 2's CSS color (`SEAT_COLORS[1].css`), `.online-status`, always laid out, out of flow like `.join-banner`.

- [ ] **Step 1: Write the failing tests**

```js
test('the title keeps its button count with and without a session', () => {
  // createMenu with onlineItem: 5 buttons; setItem('play', ...) and setItem('online', ...) for each view: still 5.
});

test('online the host mode starts on hives and cycles versus and hives only', () => {
  const choice = new ModeChoice();
  choice.setOnline('host');
  assert.equal(choice.mode, 'hives');
  choice.toggle(); assert.equal(choice.mode, 'versus');
  choice.toggle(); assert.equal(choice.mode, 'hives');
});

test('the guest sees the host mode read-only', () => {
  // setOnline('guest'); setRemoteMode('versus'): modeItemView is { label: 'MODE: VERSUS', enabled: false }; toggle returns false.
});

test('leaving online returns the couch mode choice', () => {
  // setOnline('host'), then setOnline(null) without player 2: modeItemView is { label: 'MODE: SOLO', enabled: false }, mode 'coop'.
});
test('onlineTitleView gives each side its labels', () => {
  // the four views listed in the Interfaces block, each deep-equal, with roundTripMilliseconds 42.
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/ui/`
Expected: FAIL.

- [ ] **Step 3: Implement the interfaces above**

- [ ] **Step 4: Run them and the whole suite**

Run: `node --test tests/ui/` then `npm test`
Expected: PASS, the existing menu and mode tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/ui tests/ui
git commit -m "Add the ONLINE title item and the connected title"
```

### Task 6.4: Online wiring in main.js

**Files:**
- Create: `src/ui/online-wiring.js`, `src/ui/resume-countdown.js` (a fixed centered 3, 2, 1 numeral, no touches, reserved by visibility)
- Modify: `src/ui/menu.js` `createPauseMenu` (gains a note line, `setNote(text)`, always laid out), `src/main.js` (`startRun`, `pauseForMenu`, `resumeGame`, `restartFromGameOver`, the pause menu's Restart and Quit, `openLab`, the render update, the rumble `remoteSeats`, the boot hash read)
- Test: `tests/ui/online-wiring.test.js`, `tests/ui/menu.test.js` (append for `setNote`)

**Interfaces:**
- Consumes: `OnlineSession` (5.2), `Game.setFullRateLock` (5.3), `createRtcConnection` (6.1), `createOnlinePanel` (6.2), `createOnlineTitle`, `onlineTitleView`, `ModeChoice.setOnline` (6.3), `encodeSignal`, `decodeSignal`, `inviteUrl`, `inviteFromHash` (2.3), `CONNECT_TIMEOUT_SECONDS`.
- Produces: `createOnlineWiring({ game, menu, pauseMenu, hud, modeControl, coopJoin, onlinePanel, onlineTitle, countdown, locationObject, historyObject, createConnection, now, setTimer, clearTimer })` returning:
  - `active`, `role`, `remoteSeats()` (the remote seat in a `Set`, else empty; feeds `rumblePadFor`).
  - `handleStart() -> boolean`, `handlePause() -> boolean`, `handleResume() -> boolean`, `handleRestart() -> boolean`, `handleQuit() -> boolean`: each returns `true` when a session took the request (`main.js` then skips its couch path); the session's actions drive `pauseMenu.show()` with the note "PLAYER n PAUSED" or "CONNECTION LOST", the countdown, `resumeGame`, `menu.show()` and toasts.
  - `toggleOnline()` (the ONLINE item): no session opens the Host panel (`coopJoin.reset()` first), a session quits it.
  - `openFromHash(hash)`: a `#join=` payload is cleared from the address bar with `historyObject.replaceState` at once, held while a run is not at the title, and opens the Join panel the next time `update({ titleOpen: true })` runs; ignored with a toast while a session exists.
  - `update({ titleOpen, warmUpDone, deltaSeconds })`: marks ready once warm-up is done, keeps the title view, the mode item and the Lab ghosting current, and skips `coopJoin.update` polling while a session exists (`main.js` calls `coopJoin.update` only when `!online.active`).
  - Connect timeout: the host's 10 s counts from an accepted reply, the guest's from **Copy reply**; on expiry both show "Your two networks cannot connect directly." and the host's panel returns with a fresh invite.
  - The sparring query and the backquote lab key are ignored while a session exists (toast for sparring).
  - Every pause source goes through `handlePause`: the pause key and button, gamepad Options, blur, `visibilitychange`, the fullscreen external exit (all already `pauseForMenu`), the rotate overlay (`main.js:407-414` calls `game.pause()` directly; online it calls `handlePause` too), and, online only, a `gamepaddisconnected` for the pad the local seat reads (`handlePadDisconnected(padIndex) -> boolean`, comparing with `input.seatOnePadIndex()` as last read before the event).
  - End messages (toasts on the title): `'quit'` none, `'remoteQuit'` "Player n left the match.", `'lost'` "Connection lost. The match has ended.", `'version'` "Both players need to reload the page."
  - `window.__murmuration.online` exposes `{ session, inviteUrl, replyText, phase }` for the browser check.
- `main.js` stays at most 500 lines: each existing handler gains one guard line of the form `if (online.handlePause()) return;`.

- [ ] **Step 1: Write the failing tests**

```js
test('creating the wiring and showing the title builds no connection', () => {
  const factory = countingConnectionFactory();
  const online = createOnlineWiring({ ...fakes, createConnection: factory.create });
  for (let frame = 0; frame < 60; frame += 1) online.update({ titleOpen: true, warmUpDone: true, deltaSeconds: STEP });
  assert.equal(factory.count, 0);
  online.toggleOnline();
  assert.equal(factory.count, 1);
});

test('a join link that arrives mid-run waits for the title and leaves the address bar', () => {
  // game run phase 'playing'; openFromHash('#join=QQ'): historyObject.replaceState called once, panel hidden;
  // update({ titleOpen: false }) keeps it hidden; update({ titleOpen: true }) shows the Join panel.
});

test('a second join link during a session is ignored with a toast', () => {
  // connected session; openFromHash('#join=RR'): no new connection, one toast, the Join panel stays hidden.
});
test('a pause while connected is taken by the session', () => {
  // connected and playing: handlePause() returns true and the fake session's pause was called once; with no session it returns false.
});
test('the local pad dropping out pauses an online match, and a couch partner pad rule is untouched', () => {
  // online, gamepaddisconnected for the local pad's index: the session's pause called once; without a session nothing happens.
});
test('the guest connect timeout counts from Copy reply', () => {
  // guest: Copy reply at fake time 0; fake timers to 9.99 s: no message; at 10 s: 'Your two networks cannot connect directly.'
});
test('the pause menu note is laid out before any text is set', () => {
  // createPauseMenu: the note element exists with visibility hidden; setNote('PLAYER 2 PAUSED') shows it; setNote('') hides it again.
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/ui/online-wiring.test.js tests/ui/menu.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement the wiring, the countdown, the pause note and the `main.js` guards**

- [ ] **Step 4: Run the tests, the whole suite and the build; check the line counts**

Run: `npm test`, `npm run build`, `wc -l src/main.js src/game/game.js src/ui/online-wiring.js`
Expected: PASS; `main.js` at most 500, `game.js` at most 849, `online-wiring.js` under 500.

- [ ] **Step 5: Commit**

```bash
git add src/ui src/main.js tests/ui
git commit -m "Wire the online session into the page"
```

---

## Phase 7: Proof and documentation

### Task 7.1: Guard test

**Files:**
- Test: `tests/net/online-guard.test.js`

**Interfaces:**
- Consumes: `sourceFiles` and `filesWith` in the style of `tests/game/hives-guard.test.js:9-16`; `createGame`; `createOnlineWiring` with a counting connection factory.

- [ ] **Step 1: Write the test**

```js
test('only the online wiring and the panels import the networking directory', () => {
  const importers = [...new Set([...filesWith("from '../net/"), ...filesWith("from './net/")])].filter((path) => !path.startsWith('src/net/')).sort();
  assert.deepEqual(importers, ['src/ui/online-panel.js', 'src/ui/online-wiring.js']);
});

test('the game reaches the networking only through game.online', () => {
  assert.deepEqual(filesWith('.online').filter((path) => path.startsWith('src/game/')),
    ['src/game/bomb-step.js', 'src/game/game.js', 'src/game/seats.js', 'src/game/versus-seats.js']);
});

for (const mode of ['solo', 'coop', 'versus', 'hives']) {
  test(`${mode} runs 600 updates with no session and no connection`, async () => {
    // createGame; set the mode; start; 600 updates: game.online stays null and every seat's remote flag false;
    // the wiring created beside it with a counting factory and updated each frame constructs 0 connections.
  });
}
```

Adjust the two fixed lists to the files the earlier tasks actually touched, and no others.

- [ ] **Step 2: Run it**

Run: `node --test tests/net/online-guard.test.js`
Expected: PASS. If a list differs, the difference is a stray import or hook to remove, not a list to widen.

- [ ] **Step 3: Commit**

```bash
git add tests/net/online-guard.test.js
git commit -m "Guard that nothing reaches the networking without a session"
```

### Task 7.2: Two-context browser check

**Files:**
- Create: `tests/browser/online.mjs`
- Modify: `tests/browser/launch.mjs` (`launchWebGpuBrowser` gains `extraArguments = []`, appended to the flags; `tests/browser/launch.test.js` gets one assertion that they are appended)

**Interfaces:**
- Consumes: `launchWebGpuBrowser`, `startServer` (`server.stop()` for teardown, as `tests/browser/browser-launchers.test.js` requires), `window.__murmuration.online`, `window.__murmuration.game`.

- [ ] **Step 1: Write the check** (header comment in the style of `tests/browser/hives.mjs:1-16`; usage `SMOKE_PORT=5198 node tests/browser/online.mjs`; exit 0 ok, 1 failure, 2 no adapter)

Two contexts from one browser launched with `extraArguments: ['--disable-features=WebRtcHideLocalIpsWithMdns']`, each granted `clipboard-read` and `clipboard-write`, both at `?probe=off&capacity=262144`. Steps, each asserted on both pages:
1. Host: ONLINE, wait for `online.inviteUrl`. Guest: open that URL; the Join panel shows; read `online.replyText`. Host: fill the reply box, press Paste reply's submit; both reach the connected title (the host's status line names the round trip, the guest's Play reads WAITING FOR THE HOST TO START).
2. Host chooses HIVES (already the default) and Play; both pages reach `playing` in mode `hives` within 1 s of each other (frame counts sampled).
3. Hold the host seat's ships on the center hive (as `hives.mjs` does); both pages' `state.hives.hives[2].owner` become 0; screenshot `artifacts/online-captured-host.png` and `-guest.png`.
4. Give the host every hive and wind the hold to its last 2 s on the host; both game over titles read `PLAYER 1 WINS` in seat 1's color.
5. Guest presses Play again; both runs restart in hives with neutral hives.
6. Guest presses Escape: the host's pause menu shows with a PLAYER 2 PAUSED note; host Resume: both show 3, then both reach `playing`.
7. Close the guest page: the host pauses with CONNECTION LOST and returns to a co-op title within 12 s.
No console errors on either page.

- [ ] **Step 2: Run it on the GPU machine**

Run: `SMOKE_PORT=5198 node tests/browser/online.mjs`
Expected: exit 0 and the four screenshots written.

- [ ] **Step 3: Commit**

```bash
git add tests/browser/online.mjs tests/browser/launch.mjs tests/browser/launch.test.js
git commit -m "Add the two-context online browser check"
```

### Task 7.3: Documentation

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add an "Online (stage 4)" section after "Hives (stage 3)"** in that file's style (one bullet per topic, real identifiers, numbers in place): roles and seats (host seat index 0, guest seat index 1, `Game.localSeatIndex`, `setLocalSeat`, `seat.remote`), the driver seam and `game.online` (null without a session; the hook points in `game.js`, `seats.js`, `versus-seats.js`, `bomb-step.js`), who decides what (own deaths, the remote seat uploaded `invulnerable`, the host's director, hives, contact with generations, pickups with ids and claims, bomb pool with `ONLINE_BOMB_RADIUS`, score, the referee's 200 ms draw window), what travels (the two channels, snapshot rates and layout, events), growth scaled by `DENSITY_REFERENCE_CAPACITY / capacity`, the lifecycle (ready flags, start 0.5 s ahead, shared pause, the 3, 2, 1 countdown, restart, quit, 10 s connection loss), the full-rate lock, the screens (ONLINE item, panels, connected title, the `#join=` link), STUN in `src/net/ice-configuration.js`, and what is unavailable online.
- [ ] **Step 2: Add the file map entries**: a `src/net/` bullet listing every module and its one job; the new `src/ui/` and `src/game/` files (`online-panel.js`, `online-title.js`, `online-wiring.js`, `resume-countdown.js`, `online.css`, `bomb-step.js`, `pickup-collect.js`); `tests/net/`; `tests/browser/online.mjs` (with `SMOKE_PORT`, not part of `check:gpu`). Update the Frame order of operations steps that now carry an online branch with one clause each, and `MAXIMUM_PLAYER_SEATS` text where it says the local player is seat 1.
- [ ] **Step 3: Run the docs-update check** across `AGENTS.md`, `README.md`, in-repo docs and the inline headers of every file this plan touched; fix drifted statements; confirm no U+2014 in the diff (`git diff | node -e "let t='';process.stdin.on('data',(c)=>{t+=c}).on('end',()=>console.log(t.split(String.fromCharCode(0x2014)).length-1))"` prints 0).
- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md
git commit -m "Document online play in AGENTS.md"
```

### Task 7.4: Whole-suite pass

- [ ] **Step 1: Run every gate, each in the background teed to a file**

Run: `npm test`; `npm run coverage`; `npm run build`; `npm run check:gpu`; `SMOKE_PORT=5195 node tests/browser/coop.mjs`; `SMOKE_PORT=5196 node tests/browser/versus.mjs`; `SMOKE_PORT=5197 node tests/browser/hives.mjs`; `SMOKE_PORT=5198 node tests/browser/online.mjs`.
Expected: every one exits 0; coverage lines at least 92 and functions at least 86; `wc -l` shows `game.js` at most 849, `main.js` at most 500, every file under `src/net/` and every new `src/ui/` file under 500.

- [ ] **Step 2: Record the evidence** in the branch's final report as counts and the commands above (no logs committed). The attended exit test (the owner and a friend on different networks playing a full hives match) is the last stage and does not block the branch.
