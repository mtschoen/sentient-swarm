import test from 'node:test';
import assert from 'node:assert/strict';
import { FireLog, MAXIMUM_RELEASES, MAXIMUM_SILENCES, MAXIMUM_THIN, SILENCE_SECONDS, silenceReason } from '../../src/game/fire-log.js';

const STEP = 1 / 60;
const FIRING = { ships: 12, inCone: 12, ready: 1, fired: 1, shotsPerSecond: 65 };
const quiet = (overrides) => ({ ...FIRING, fired: 0, ...overrides });

function sample(overrides = {}) {
  return { phase: 'playing', inputFiring: true, armed: 'base', report: FIRING, aimX: 1, aimY: 0, moveX: -1, moveY: 0, ...overrides };
}

function run(log, seconds, overrides) {
  for (let step = 0; step < Math.round(seconds / STEP); step += 1) log.sample(STEP, sample(overrides));
}

test('silenceReason names the layer that stopped the shots', () => {
  assert.equal(silenceReason('base', quiet({ ships: 0 })), 'no ships alive');
  assert.equal(silenceReason('beam', quiet({ shotsPerSecond: 0 })), 'armed beam fires no ship shots');
  assert.equal(silenceReason('base', quiet({ inCone: 0 })), '0 of 12 ships in the aim cone');
  assert.equal(silenceReason('base', quiet({ inCone: 5, ready: 0 })), '5 of 12 in the cone, none off cooldown');
  assert.match(silenceReason('base', quiet({ inCone: 5, ready: 2 })), /no ship is both/);
});

test('steady fire logs nothing and the status line shows the measured rate', () => {
  const log = new FireLog();
  run(log, 2);
  assert.deepEqual([log.silences, log.releases, log.thin], [[], [], []]);
  assert.match(log.lines()[0], /^fire HELD \| playing \| base \| ships 12 cone 12 ready 1 \| 60\/s \| thin 0\/7 \| touch: none$/);
});

test('held fire with no shots opens one silence with its reason, aim and movement, and its length grows', () => {
  const log = new FireLog();
  run(log, 1);
  run(log, SILENCE_SECONDS / 2, { report: quiet({ inCone: 0 }) });
  assert.equal(log.silences.length, 0, 'shorter than the threshold');
  run(log, 1, { report: quiet({ inCone: 0 }) });
  assert.equal(log.silences.length, 1);
  assert.match(log.silences[0].reason, /^0 of 12 ships in the aim cone; armed base, aim 0deg, move 180deg$/);
  assert.ok(Math.abs(log.silences[0].seconds - (1 + SILENCE_SECONDS / 2)) < 0.05, `${log.silences[0].seconds}`);
  run(log, 0.5);
  run(log, 1, { report: quiet({ ready: 0 }) });
  assert.equal(log.silences.length, 2, 'a shot ends a silence, the next one is its own entry');
  assert.ok(log.lines().some((line) => /s SILENT \d\.\ds: 0 of 12 ships/.test(line)));
});

test('a slow weapon gets longer before its quiet counts, and nothing counts off the trigger or out of play', () => {
  const log = new FireLog();
  run(log, 1, { armed: 'pulse', report: quiet({ shotsPerSecond: 3.3 }) });
  assert.equal(log.silences.length, 0, 'five pulse intervals are 1.5 s');
  run(log, 1, { armed: 'pulse', report: quiet({ shotsPerSecond: 3.3 }) });
  assert.equal(log.silences.length, 1);
  const idle = new FireLog();
  run(idle, 2, { inputFiring: false, report: quiet() });
  run(idle, 2, { phase: 'dying', report: quiet() });
  assert.equal(idle.silences.length, 0);
});

test('a release records how long fire was held and the touch event that came last', () => {
  let event = { type: 'start', role: 'aim', sequence: 1 };
  const log = new FireLog({ touchEvent: () => event });
  run(log, 2);
  event = { type: 'cancel', role: 'aim', sequence: 2 };
  run(log, 0.1, { inputFiring: false, report: quiet() });
  assert.equal(log.releases.length, 1);
  assert.match(log.releases[0].text, /^released after 2\.0s held, last touch event: cancel aim$/);
  assert.match(log.lines()[0], /^fire off .* touch: cancel aim$/);
  assert.match(log.lines().at(-1), /s released after/);
});

test('both lists keep only their newest entries', () => {
  const log = new FireLog();
  for (let round = 0; round < 10; round += 1) {
    run(log, 1, { report: quiet({ inCone: 0 }) });
    run(log, 0.1, { inputFiring: false, report: quiet() });
  }
  assert.equal(log.silences.length, MAXIMUM_SILENCES);
  assert.equal(log.releases.length, MAXIMUM_RELEASES);
  assert.ok(log.silences[0].time > 4);
});

test('fire that sputters without stopping is logged as one thin stretch with its worst share', () => {
  const log = new FireLog();
  run(log, 1);
  // One shot every sixth step: a sixth of the 65 per second the law gives, never a long silence.
  for (let step = 0; step < 60; step += 1) {
    log.sample(STEP, sample({ report: step % 6 === 0 ? { ...FIRING, inCone: 2 } : quiet({ inCone: 2 }) }));
  }
  run(log, 1);
  assert.equal(log.silences.length, 0);
  assert.equal(log.thin.length, 1, 'thin windows in a row are one entry');
  assert.ok(log.thin[0].seconds > 0.7 && log.thin[0].seconds < 1.1, `${log.thin[0].seconds}`);
  assert.ok(log.thin[0].share < 0.3, `${log.thin[0].share}`);
  assert.match(log.thin[0].detail, /^cone 2\.0 ready 1\.0 of 12\.0 ships; aim 0deg, move 180deg$/);
  assert.match(log.lines()[1], /s THIN \d\.\d\ds at \d+% of the law: cone 2\.0/);
  assert.match(log.lines()[0], /thin [34]\/1[12] \|/);
});

test('windows the law gives too few shots are not judged, and a release or the beam starts the window over', () => {
  const log = new FireLog();
  run(log, 3, { armed: 'pulse', report: quiet({ shotsPerSecond: 3.3 }) });
  run(log, 3, { armed: 'beam', report: quiet({ shotsPerSecond: 0, inCone: 0, ready: 0 }) });
  run(log, 3, { inputFiring: false, report: quiet() });
  assert.deepEqual([log.thin.length, log.judgedWindows], [0, 0]);
  for (let round = 0; round < 10; round += 1) {
    run(log, 0.5, { report: quiet({ inCone: 0 }) });
    run(log, 0.5);
  }
  assert.equal(log.thin.length, MAXIMUM_THIN);
});
