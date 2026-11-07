import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../../src/audio/audio.js';
import { ProceduralMusic } from '../../src/audio/music.js';
import { FakeAudioContext } from './fake-audio-context.js';

function startedMusic(intensity, options = {}) {
  const context = new FakeAudioContext();
  const engine = new AudioEngine({ contextFactory: () => context });
  engine.unlock();
  const notes = [];
  const music = new ProceduralMusic(engine, { onNote: (note) => notes.push(note), ...options });
  music.setIntensity(intensity);
  music.start();
  return { context, engine, music, notes };
}

// Drives the music like the page timer does, in 25 ms ticks, from 0 up to endTime.
function play(played, endTime) {
  for (let time = 0; time < endTime; time += 0.025) {
    played.context.currentTime = time;
    played.music.update(time);
  }
}

// Four bars; the first step lands one lookahead (origin) after the first update.
function playFourBars(intensity) {
  const played = startedMusic(intensity);
  const stepDuration = 60 / played.music.tempo / 4;
  const origin = played.music.sequencer.lookaheadSeconds;
  play(played, origin + 64 * stepDuration - 0.1);
  const inWindow = played.notes.filter((note) => note.step < 64);
  return { ...played, stepDuration, origin, notes: inWindow };
}

const byVoice = (notes, voice) => notes.filter((note) => note.voice === voice);
const countVoices = (notes) => {
  const counts = {};
  for (const note of notes) counts[note.voice] = (counts[note.voice] ?? 0) + 1;
  return counts;
};

test('setIntensity(0) keeps the lead silent and setIntensity(1) sets tempo 134', () => {
  const { music } = startedMusic(0);
  assert.equal(music.levels.lead, 0);
  assert.equal(music.tempo, 124);
  music.setIntensity(1);
  assert.equal(music.tempo, 134);
  assert.ok(music.levels.lead > 0);
});

test('the AudioEngine creates its context only on unlock', () => {
  let created = 0;
  const engine = new AudioEngine({ contextFactory: () => { created += 1; return new FakeAudioContext(); } });
  assert.equal(engine.context, null);
  assert.equal(created, 0);
  engine.unlock();
  engine.unlock();
  assert.equal(created, 1);
  assert.ok(engine.context instanceof FakeAudioContext);
});

test('a failing context factory warns once and leaves the engine silent', (testContext) => {
  const warnings = [];
  testContext.mock.method(console, 'warn', (...parts) => warnings.push(parts.join(' ')));
  const engine = new AudioEngine({ contextFactory: () => { throw new Error('no audio'); } });
  assert.equal(engine.unlock(), null);
  assert.equal(engine.unlock(), null);
  assert.equal(warnings.length, 1);
  const music = new ProceduralMusic(engine);
  music.start();
  music.update(1);
});

for (const [intensity, tempo] of [[0.2, 126], [0.9, 133]]) {
  test(`four bars at intensity ${intensity}: kick on beats, hats on offbeats, tempo ${tempo}`, () => {
    const { music, notes, stepDuration, origin, context } = playFourBars(intensity);
    assert.equal(music.tempo, tempo);
    const onGrid = (note, steps) => Math.abs(note.time - (origin + note.step * stepDuration)) < 1e-9 && steps.includes(note.step % 16);

    const kicks = byVoice(notes, 'kick');
    assert.equal(kicks.length, 16);
    kicks.forEach((note, index) => {
      assert.equal(note.step, index * 4);
      assert.ok(onGrid(note, [0, 4, 8, 12]));
    });
    // The kick oscillators themselves start on the beats and drop from 150 to 50 Hz.
    const kickOscillators = context.started.filter((node) => node.kind === 'oscillator'
      && node.frequency.events[0]?.value === 150
      && node.frequency.events.some((event) => event.kind === 'exponential' && event.value === 50));
    assert.equal(kickOscillators.length, 16);
    kickOscillators.forEach((node, index) => assert.ok(Math.abs(node.startTime - (origin + index * 4 * stepDuration)) < 1e-9));

    const hats = [...byVoice(notes, 'closed-hat'), ...byVoice(notes, 'open-hat')];
    assert.equal(hats.length, 16);
    hats.forEach((note) => assert.ok(onGrid(note, [2, 6, 10, 14])));
    assert.equal(byVoice(notes, 'open-hat').length, 4);

    const bassRoots = [...new Set(byVoice(notes, 'bass').map((note) => `${Math.floor(note.step / 16)}:${note.rootNote}`))];
    assert.equal(bassRoots.length, 4, 'one bass root per bar across the four-bar progression');
    assert.equal(new Set(byVoice(notes, 'bass').map((note) => note.rootNote)).size, 4, 'four distinct roots');

    const lead = byVoice(notes, 'lead');
    if (intensity < 0.4) assert.equal(lead.length, 0);
    else assert.ok(lead.length >= 32, `lead notes ${lead.length}`);
  });
}

test('four bars schedule exactly the expected notes and source nodes', () => {
  const low = playFourBars(0.2);
  assert.deepEqual(countVoices(low.notes), { kick: 16, 'closed-hat': 12, bass: 16, 'open-hat': 4 });
  assert.equal(low.context.started.length, 80);
  const high = playFourBars(0.9);
  assert.deepEqual(countVoices(high.notes), { kick: 16, crash: 1, lead: 64, shaker: 32, 'closed-hat': 12, bass: 32, clap: 8, 'open-hat': 4 });
  assert.equal(high.context.started.length, 297);
});

test('the death cue drops out two beats, then every layer returns', () => {
  const death = startedMusic(0.9);
  death.music.cue('death');
  play(death, 3);
  assert.equal(death.notes.filter((note) => note.step < 8).length, 0);
  const after = death.notes.filter((note) => note.step >= 8 && note.step < 24);
  assert.deepEqual(byVoice(after, 'kick').map((note) => note.step), [8, 12, 16, 20]);
  for (const voice of ['closed-hat', 'bass', 'lead', 'clap']) assert.ok(byVoice(after, voice).length > 0, `${voice} returns`);
});

test('the expiry cue drops lead and hats for two bars, then they return', () => {
  const expiry = startedMusic(0.9);
  expiry.music.cue('expiry');
  play(expiry, 0.1 + 48 * expiry.music.sequencer.stepDuration);
  const during = expiry.notes.filter((note) => note.step < 32);
  const after = expiry.notes.filter((note) => note.step >= 32 && note.step < 48);
  assert.equal(byVoice(during, 'kick').length, 8);
  for (const voice of ['lead', 'closed-hat', 'open-hat', 'shaker']) assert.equal(byVoice(during, voice).length, 0, `${voice} dropped`);
  for (const voice of ['lead', 'closed-hat', 'open-hat', 'shaker']) assert.ok(byVoice(after, voice).length > 0, `${voice} returns`);
});

test('a tempo change mid-bar waits for the bar start, and the delay moves with it', () => {
  const played = startedMusic(0.2);
  const slowStep = 60 / 126 / 4;
  const origin = played.music.sequencer.lookaheadSeconds;
  play(played, origin + 8 * slowStep - 0.1);
  played.music.setIntensity(0.9);
  assert.equal(played.music.tempo, 133);
  played.context.currentTime = origin + 30 * slowStep;
  for (let time = origin + 8 * slowStep - 0.1; time < origin + 30 * slowStep; time += 0.025) played.music.update(time);
  const kicks = byVoice(played.notes, 'kick');
  const fastStep = 60 / 133 / 4;
  const barTwo = origin + 16 * slowStep;
  for (const note of kicks) {
    const expected = note.step < 16 ? origin + note.step * slowStep : barTwo + (note.step - 16) * fastStep;
    assert.ok(Math.abs(note.time - expected) < 1e-9, `kick ${note.step} at ${note.time}, expected ${expected}`);
  }
  const delayEvents = played.engine.context.nodes.find((node) => node.kind === 'delay').delayTime.events;
  assert.deepEqual(delayEvents.map((event) => event.kind), ['set', 'set']);
  assert.ok(Math.abs(delayEvents[0].time - origin) < 1e-9);
  assert.ok(Math.abs(delayEvents[1].time - barTwo) < 1e-9);
  assert.ok(Math.abs(delayEvents[1].value - 3 * fastStep) < 1e-9);
});

test('start drives its own timer when given one, and stop clears it', () => {
  const intervals = new Map();
  let nextIdentifier = 1;
  const timers = {
    setInterval: (callback, milliseconds) => { intervals.set(nextIdentifier, { callback, milliseconds }); return nextIdentifier++; },
    clearInterval: (identifier) => intervals.delete(identifier),
  };
  const played = startedMusic(0.5, { timers });
  assert.equal(intervals.size, 1);
  const [{ callback, milliseconds }] = intervals.values();
  assert.equal(milliseconds, 25);
  played.context.currentTime = 0.5;
  callback();
  assert.ok(played.notes.length > 0);
  played.music.stop();
  assert.equal(intervals.size, 0);
});

test('pickup and bomb cues schedule sound and the music gain follows setMusicVolume', () => {
  const { music, engine, context } = startedMusic(0.5);
  const before = context.started.length;
  music.cue('pickup');
  music.cue('bomb');
  assert.ok(context.started.length > before);
  engine.setMusicVolume(0);
  assert.equal(engine.musicVolume, 0);
  assert.equal(engine.musicOutput.gain.events.at(-1).value, 0);
});

test('setMuted silences music and effects together and restores both', () => {
  const { engine } = startedMusic(0.5);
  const muteGain = engine.muteOutput;
  // Both buses reach the destination only through the mute gain.
  const reachesMute = (node) => node === muteGain || node.outputs.some(reachesMute);
  assert.ok(reachesMute(engine.musicOutput) && reachesMute(engine.effectsOutput));
  engine.setMuted(true);
  assert.equal(engine.muted, true);
  assert.equal(muteGain.gain.events.at(-1).value, 0);
  engine.setMuted(false);
  assert.equal(muteGain.gain.events.at(-1).value, 1);
  assert.equal(engine.musicVolume, 1);
  assert.equal(engine.effectsVolume, 1);
});
