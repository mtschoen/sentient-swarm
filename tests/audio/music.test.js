import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../../src/audio/audio.js';
import { ProceduralMusic } from '../../src/audio/music.js';
import { FakeAudioContext } from './fake-audio-context.js';

function startedMusic(intensity) {
  const context = new FakeAudioContext();
  const engine = new AudioEngine({ contextFactory: () => context });
  engine.unlock();
  const notes = [];
  const music = new ProceduralMusic(engine, { onNote: (note) => notes.push(note) });
  music.setIntensity(intensity);
  music.start();
  return { context, engine, music, notes };
}

// Drives the music like the browser hook does, in 25 ms scheduling ticks, for four bars.
function playFourBars(intensity) {
  const played = startedMusic(intensity);
  const stepDuration = 60 / played.music.tempo / 4;
  const fourBars = 64 * stepDuration;
  for (let time = 0; time < fourBars - 0.1; time += 0.025) {
    played.context.currentTime = time;
    played.music.update(time);
  }
  const inWindow = played.notes.filter((note) => note.step < 64);
  return { ...played, stepDuration, notes: inWindow };
}

const byVoice = (notes, voice) => notes.filter((note) => note.voice === voice);

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
    const { music, notes, stepDuration, context } = playFourBars(intensity);
    assert.equal(music.tempo, tempo);
    const onGrid = (note, steps) => Math.abs(note.time - note.step * stepDuration) < 1e-9 && steps.includes(note.step % 16);

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
    assert.equal(kickOscillators.filter((node) => node.startTime < 64 * stepDuration - 1e-9).length, 16);
    kickOscillators.slice(0, 16).forEach((node, index) => assert.ok(Math.abs(node.startTime - index * 4 * stepDuration) < 1e-9));

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

test('records scheduled event counts for four bars at both intensities', () => {
  for (const intensity of [0.2, 0.9]) {
    const { notes, context } = playFourBars(intensity);
    const counts = {};
    for (const note of notes) counts[note.voice] = (counts[note.voice] ?? 0) + 1;
    console.log(`intensity ${intensity}: notes ${JSON.stringify(counts)}, source nodes started ${context.started.length}`);
    assert.ok(context.started.length < 1200, 'node budget stays small');
  }
});

test('the death cue drops out two beats and the expiry cue drops lead and hats for two bars', () => {
  const death = startedMusic(0.9);
  death.music.cue('death');
  death.context.currentTime = 0.8;
  death.music.update(0.8);
  assert.equal(death.notes.length, 0);

  const expiry = startedMusic(0.9);
  expiry.music.cue('expiry');
  for (let time = 0; time < 1.5; time += 0.025) expiry.music.update(time);
  assert.ok(byVoice(expiry.notes, 'kick').length > 0);
  assert.equal(byVoice(expiry.notes, 'lead').length, 0);
  assert.equal(byVoice(expiry.notes, 'closed-hat').length, 0);
});

test('pickup and bomb cues schedule sound and the music gain follows setMusicVolume', () => {
  const { music, engine, context } = startedMusic(0.5);
  const before = context.started.length;
  music.cue('pickup');
  music.cue('bomb');
  assert.ok(context.started.length > before);
  engine.setMusicVolume(0);
  assert.equal(engine.musicVolume, 0);
  const lastEvent = engine.musicOutput.gain.events.at(-1);
  assert.equal(lastEvent.value, 0);
});
