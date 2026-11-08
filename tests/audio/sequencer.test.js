import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StepSequencer } from '../../src/audio/sequencer.js';

function recordingSequencer(options) {
  const sequencer = new StepSequencer(options);
  const scheduled = [];
  const scheduleStep = (stepIndex, stepTime) => scheduled.push({ stepIndex, stepTime });
  return { sequencer, scheduled, scheduleStep };
}

test('schedules steps 0 to 3 at 128 bpm with a 0.1 s lookahead, each exactly once, one lookahead after the first update', () => {
  const { sequencer, scheduled, scheduleStep } = recordingSequencer({ lookaheadSeconds: 0.1 });
  sequencer.setTempo(128);
  sequencer.update(0, scheduleStep);
  assert.equal(scheduled.length, 0, 'the first step is one lookahead out, not already late');
  for (const time of [0.1, 0.1, 0.2, 0.3, 0.4, 0.4]) sequencer.update(time, scheduleStep);
  assert.deepEqual(scheduled.map((entry) => entry.stepIndex), [0, 1, 2, 3]);
  const stepDuration = 60 / 128 / 4;
  scheduled.forEach((entry, index) => assert.ok(Math.abs(entry.stepTime - (0.1 + index * stepDuration)) < 1e-9));
});

test('a 10 second jump skips missed steps instead of scheduling hundreds', () => {
  const { sequencer, scheduled, scheduleStep } = recordingSequencer({ lookaheadSeconds: 0.1 });
  sequencer.setTempo(128);
  sequencer.update(0, scheduleStep);
  sequencer.update(10, scheduleStep);
  assert.ok(scheduled.length >= 1 && scheduled.length <= 2, `scheduled ${scheduled.length} steps`);
  for (const entry of scheduled) assert.ok(entry.stepTime >= 10 - 1e-9 && entry.stepTime < 10.1);
  // The step index keeps counting musical time, so the bar position survives the jump.
  const stepDuration = 60 / 128 / 4;
  assert.ok(Math.abs(scheduled[0].stepTime - (0.1 + scheduled[0].stepIndex * stepDuration)) < 1e-9);
});

test('a tempo change waits for the next bar start', () => {
  const { sequencer, scheduled, scheduleStep } = recordingSequencer({ stepsPerBar: 4, lookaheadSeconds: 0.05 });
  sequencer.setTempo(120); // at 4 steps per bar a step is one beat: 0.5 s
  sequencer.update(0, scheduleStep);
  sequencer.update(0.02, scheduleStep);
  sequencer.setTempo(60);
  assert.equal(sequencer.targetBeatsPerMinute, 60);
  for (let time = 0.2; time < 3.5; time += 0.025) sequencer.update(time, scheduleStep);
  const times = scheduled.map((entry) => entry.stepTime);
  const expected = [0.05, 0.55, 1.05, 1.55, 2.05, 3.05];
  assert.equal(times.length, expected.length);
  times.forEach((time, index) => assert.ok(Math.abs(time - expected[index]) < 1e-9, `${time} vs ${expected[index]}`));
  assert.equal(sequencer.beatsPerMinute, 60);
});

// Owner ruling R31: a time warp tempo change lands on the next beat (quantumSteps 4).
test('setTempo with a beat quantum applies at the next beat start; a later bar-quantum call keeps the beat', () => {
  const { sequencer, scheduled, scheduleStep } = recordingSequencer({ lookaheadSeconds: 0.1 });
  sequencer.setTempo(120);
  sequencer.update(0, scheduleStep);
  let time = 0;
  while (sequencer.nextStepIndex < 5) {
    time += 0.025;
    sequencer.update(time, scheduleStep);
  }
  sequencer.setTempo(60, { quantumSteps: 4 });
  sequencer.setTempo(60);
  while (sequencer.nextStepIndex < 10) {
    time += 0.025;
    sequencer.update(time, scheduleStep);
  }
  assert.equal(sequencer.beatsPerMinute, 60);
  const atBeat = scheduled.find((entry) => entry.stepIndex === 8);
  const after = scheduled.find((entry) => entry.stepIndex === 9);
  assert.ok(Math.abs(after.stepTime - atBeat.stepTime - 0.25) < 1e-9, 'steps after the beat use the new tempo');
});
