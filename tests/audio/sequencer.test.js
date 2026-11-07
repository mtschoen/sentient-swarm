import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StepSequencer } from '../../src/audio/sequencer.js';

function recordingSequencer(options) {
  const sequencer = new StepSequencer(options);
  const scheduled = [];
  const scheduleStep = (stepIndex, stepTime) => scheduled.push({ stepIndex, stepTime });
  return { sequencer, scheduled, scheduleStep };
}

test('schedules steps 0 to 3 at 128 bpm with a 0.1 s lookahead, each exactly once', () => {
  const { sequencer, scheduled, scheduleStep } = recordingSequencer({ lookaheadSeconds: 0.1 });
  sequencer.setTempo(128);
  for (const time of [0, 0.1, 0.1, 0.2, 0.3, 0.3]) sequencer.update(time, scheduleStep);
  assert.deepEqual(scheduled.map((entry) => entry.stepIndex), [0, 1, 2, 3]);
  const stepDuration = 60 / 128 / 4;
  scheduled.forEach((entry, index) => assert.ok(Math.abs(entry.stepTime - index * stepDuration) < 1e-9));
});

test('a 10 second jump skips missed steps instead of scheduling hundreds', () => {
  const { sequencer, scheduled, scheduleStep } = recordingSequencer({ lookaheadSeconds: 0.1 });
  sequencer.setTempo(128);
  sequencer.update(0, scheduleStep);
  sequencer.update(10, scheduleStep);
  assert.ok(scheduled.length <= 3, `scheduled ${scheduled.length} steps`);
  const late = scheduled.filter((entry) => entry.stepIndex > 0);
  assert.ok(late.length >= 1);
  for (const entry of late) assert.ok(entry.stepTime >= 10 - 1e-9 && entry.stepTime < 10.1);
  // The step index keeps counting musical time, so the bar position survives the jump.
  const stepDuration = 60 / 128 / 4;
  assert.ok(Math.abs(late[0].stepTime - late[0].stepIndex * stepDuration) < 1e-9);
});

test('a tempo change applies to the steps after it', () => {
  const { sequencer, scheduled, scheduleStep } = recordingSequencer({ lookaheadSeconds: 0.05 });
  sequencer.setTempo(120);
  sequencer.update(0, scheduleStep);
  sequencer.setTempo(60);
  sequencer.update(0.1, scheduleStep);
  assert.deepEqual(scheduled.map((entry) => entry.stepIndex), [0, 1]);
  assert.ok(Math.abs(scheduled[1].stepTime - 0.125) < 1e-9);
  sequencer.update(0.34, scheduleStep);
  assert.deepEqual(scheduled.map((entry) => entry.stepIndex), [0, 1, 2]);
  assert.ok(Math.abs(scheduled[2].stepTime - 0.375) < 1e-9);
});
