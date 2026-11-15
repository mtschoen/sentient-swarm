import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { STEP, createOnlinePair } from './online-harness.js';
import { decodeSnapshot, encodeSnapshot } from '../../src/net/snapshot-codec.js';
import { seatAt } from './net-fixtures.js';
import { hivesOf } from '../../src/game/hive-seats.js';

// Every gate table the side's simulation steps with (null included).
function recordStepTables(side) {
  const tables = [];
  const step = side.simulation.step.bind(side.simulation);
  side.simulation.step = (encoder, deltaSeconds, spawnPerSpecies, spawnGates, ...rest) => {
    tables.push(spawnGates);
    step(encoder, deltaSeconds, spawnPerSpecies, spawnGates, ...rest);
  };
  return tables;
}

// A host block as the guest reads it off the wire (positions f32, open and telegraph to 1/255).
function overTheWire(host) {
  return decodeSnapshot(encodeSnapshot({ ...seatAt({ sequence: 1, matchSeconds: 0, x: 6 }), host })).host;
}

function withoutHiveFields(table) {
  return { ...table, gates: table.gates.map(({ owner, target, hive, ...row }) => row) };
}

async function versusTables({ guestView = null } = {}) {
  const pair = await createOnlinePair();
  const { host, guest, stepBoth, startMatch } = pair;
  if (guestView !== null) guest.game.setView(guestView);
  const hostTables = recordStepTables(host);
  const guestTables = recordStepTables(guest);
  let directorCalls = 0;
  const update = guest.game.spawnDirector.update.bind(guest.game.spawnDirector);
  guest.game.spawnDirector.update = (...parameters) => {
    directorCalls += 1;
    update(...parameters);
  };
  await startMatch('versus');
  stepBoth(2);
  return { ...pair, hostTables, guestTables, directorCalls: () => directorCalls };
}

function assertGuestTablesFromHost(hostTables, guestTables) {
  const received = hostTables.filter((table) => table !== null).map((table) => overTheWire({ gates: table, wave: null }).gates);
  const stepped = guestTables.filter((table) => table !== null);
  assert.ok(stepped.length > 100, `${stepped.length} guest tables`);
  for (const table of stepped) {
    assert.ok(received.some((candidate) => isDeepStrictEqual(withoutHiveFields(table), candidate)), 'a guest table the host did not send');
  }
}

test('the guest runs no director and spawns at the host gates', async () => {
  const { guest, hostTables, guestTables, directorCalls } = await versusTables();
  assert.equal(directorCalls(), 0);
  assertGuestTablesFromHost(hostTables, guestTables);
  assert.ok(guest.online.hostGates !== null);
});

test('the guest refills by the host wave', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  const waves = [];
  const update = guest.game.spawnPressure.update.bind(guest.game.spawnPressure);
  guest.game.spawnPressure.update = (...parameters) => {
    waves.push(parameters[4]);
    return update(...parameters);
  };
  stepBoth(1);
  const hostWave = overTheWire({ gates: null, wave: host.game.spawnDirector.wave }).wave;
  assert.deepEqual(guest.online.hostWave, hostWave);
  assert.deepEqual(waves.at(-1), hostWave);
});

test('before the first host snapshot the guest spawns nothing', async () => {
  const { guest, stepBoth, startMatch } = await createOnlinePair({ lossFraction: 1 });
  await startMatch('versus');
  stepBoth(2);
  assert.equal(guest.online.hostGates, null);
  assert.equal(guest.online.hostWave, null);
  assert.ok(guest.simulation.spawnBudgets.length > 100);
  for (const budget of guest.simulation.spawnBudgets) assert.ok(budget.every((count) => count === 0), `${budget}`);
});

test('roaming gates follow the host view even when the guest window is narrower', async () => {
  const { hostTables, guestTables } = await versusTables({ guestView: { width: 8, height: 9 } });
  assertGuestTablesFromHost(hostTables, guestTables);
});

test('in hives the guest gate rows carry the owner and target from the host hive state', async () => {
  const { guest, pair, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('hives');
  stepBoth(0.5);
  // No host state reaches the guest any more, so the owner set here is the one the next step uses.
  pair.setLossFraction(1);
  stepBoth(0.1);
  const tables = recordStepTables(guest);
  hivesOf(guest.game).hives[2].owner = 0;
  guest.game.update(STEP);
  const row = tables.at(-1).gates.find((gate) => gate.site === 2);
  assert.equal(row.owner, 0);
  assert.equal(row.target, 1);
  assert.deepEqual(row.hive, { owner: 0, capturer: null, progress: 0 });
});

test('detached, the guest runs its own director again', async () => {
  const { guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  stepBoth(0.2);
  guest.online.detach(guest.game);
  let directorCalls = 0;
  guest.game.spawnDirector.update = () => { directorCalls += 1; };
  guest.game.update(STEP);
  assert.equal(directorCalls, 1);
});

test('resetHostState forgets the host gates and wave until the next host block', async () => {
  const { guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  stepBoth(0.2);
  guest.game.update(STEP);
  guest.online.resetHostState();
  assert.equal(guest.online.hostGates, null);
  assert.equal(guest.online.hostWave, null);
  stepBoth(0.1);
  assert.ok(guest.online.hostGates !== null);
});
