import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine, DEFAULT_EFFECTS_VOLUME, DEFAULT_MUSIC_VOLUME } from '../../src/audio/audio.js';
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

// Drives the music like the page timer does, in tick-second steps, from startTime up to endTime.
function play(played, endTime, { startTime = 0, tick = 0.025 } = {}) {
  for (let time = startTime; time < endTime; time += tick) {
    played.context.currentTime = time;
    played.music.update(time);
  }
}

// Plays from the start until the given bar and returns every note before it.
function playBars(intensity, bars) {
  const played = startedMusic(intensity);
  const stepDuration = 60 / played.music.tempo / 4;
  const origin = played.music.sequencer.lookaheadSeconds;
  play(played, origin + bars * 16 * stepDuration - 0.1, { tick: 0.05 });
  return { ...played, stepDuration, origin, notes: played.notes.filter((note) => note.step < bars * 16) };
}

const byVoice = (notes, voice) => notes.filter((note) => note.voice === voice);
const barOf = (note) => Math.floor(note.step / 16);

test('setIntensity(0) keeps the lead silent and setIntensity(1) sets tempo 134', () => {
  const { music } = startedMusic(0);
  assert.equal(music.levels.lead, 0);
  assert.equal(music.tempo, 124);
  music.setIntensity(1);
  assert.equal(music.tempo, 134);
  assert.ok(music.levels.lead > 0);
});

test('the default volumes are the settings defaults, music 80 and effects 80 percent', () => {
  assert.equal(DEFAULT_MUSIC_VOLUME, 0.8);
  assert.equal(DEFAULT_EFFECTS_VOLUME, 0.8);
  const engine = new AudioEngine({ contextFactory: () => new FakeAudioContext() });
  engine.unlock();
  assert.equal(engine.musicOutput.gain.events[0].value, 0.8);
  assert.equal(engine.effectsOutput.gain.events[0].value, 0.8);
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
  music.hit(3);
  music.cue('pickup');
});

for (const [intensity, tempo] of [[0.2, 126], [0.9, 133]]) {
  test(`four intro bars at intensity ${intensity}: kick on beats, hats on offbeats, melody, tempo ${tempo}`, () => {
    const { music, notes, stepDuration, origin, context } = playBars(intensity, 4);
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

    const hats = byVoice(notes, 'closed-hat');
    assert.equal(hats.length, 16);
    hats.forEach((note) => assert.ok(onGrid(note, [2, 6, 10, 14])));

    const bassRoots = [...new Set(byVoice(notes, 'bass').map((note) => `${barOf(note)}:${note.rootNote}`))];
    assert.equal(bassRoots.length, 4, 'one bass root per bar across the four-bar progression');
    assert.equal(new Set(byVoice(notes, 'bass').map((note) => note.rootNote)).size, 4, 'four distinct roots');

    assert.ok(byVoice(notes, 'melody').length >= 10, 'the melody plays from the first bar');
    assert.equal(byVoice(notes, 'lead').length, 0, 'the intro has no saw arpeggio');
  });
}

test('sections change only every 8 or 16 bars: intro, groove, build, drop, breakdown, then round again', () => {
  const { notes } = playBars(0.2, 88);
  const sections = byVoice(notes, 'section');
  assert.deepEqual(sections.map((note) => note.name), ['intro', 'groove', 'build', 'drop', 'breakdown', 'groove', 'build', 'drop', 'breakdown']);
  assert.deepEqual(sections.map((note) => note.bar), [0, 8, 16, 24, 40, 48, 56, 64, 80]);
  sections.forEach((note) => assert.equal(note.step % 16, 0));
  for (let index = 1; index < sections.length; index += 1) {
    assert.ok([8, 16].includes(sections[index].bar - sections[index - 1].bar));
  }
});

test('a hot run skips the groove after a breakdown and goes straight back to a build', () => {
  const { notes } = playBars(0.9, 56);
  assert.deepEqual(byVoice(notes, 'section').map((note) => note.name), ['intro', 'groove', 'build', 'drop', 'breakdown', 'build']);
});

test('every phrase ends in a fill and no other bar has one', () => {
  const { notes } = playBars(0.2, 64);
  const fillBars = new Set(byVoice(notes, 'fill').map(barOf));
  assert.deepEqual([...fillBars].sort((first, second) => first - second), [7, 15, 23, 31, 39, 47, 55, 63]);
  const kinds = new Set(byVoice(notes, 'fill').map((note) => note.fill));
  assert.ok(kinds.size >= 3, `fill kinds ${[...kinds]}`);
});

test('the beat is interrupted: no kick in the last bar of a build or in a breakdown, a riser into each', () => {
  const { notes } = playBars(0.2, 48);
  const kicksInBar = (bar) => byVoice(notes, 'kick').filter((note) => barOf(note) === bar).length;
  assert.equal(kicksInBar(23), 0, 'the last bar of the build drops the kick');
  for (let bar = 40; bar < 48; bar += 1) assert.equal(kicksInBar(bar), 0, `breakdown bar ${bar} has no kick`);
  for (const bar of [1, 9, 17, 25, 33]) assert.equal(kicksInBar(bar), 4, `four on the floor in bar ${bar}`);
  const riserBars = byVoice(notes, 'riser').map(barOf);
  assert.ok(riserBars.includes(23) && riserBars.includes(47), `risers in bars ${riserBars}`);
  assert.ok(byVoice(notes, 'crash').some((note) => barOf(note) === 24), 'the drop opens on a crash');
});

test('the melody plays at intensity 0.2, follows the chords and varies per phrase', () => {
  const { notes } = playBars(0.2, 32);
  const melody = byVoice(notes, 'melody');
  for (const note of melody) {
    const pitchClasses = note.chord.map((tone) => tone % 12);
    assert.ok(pitchClasses.includes(note.note % 12), `melody note ${note.note} in chord ${note.chord}`);
  }
  const phrase = (index) => melody.filter((note) => Math.floor(barOf(note) / 8) === index).map((note) => `${note.step % 128}:${note.note}`).join(' ');
  for (let index = 1; index < 4; index += 1) assert.notEqual(phrase(index), phrase(index - 1), `phrase ${index} differs from phrase ${index - 1}`);
});

test('two progressions and a key change: the build turns to E minor and the second drop lifts to B minor', () => {
  const { notes } = playBars(0.2, 80);
  const roots = (from, to) => new Set(byVoice(notes, 'bass').filter((note) => barOf(note) >= from && barOf(note) < to).map((note) => note.rootNote));
  assert.deepEqual([...roots(0, 8)].sort(), [29, 31, 33, 36]);
  assert.ok(roots(16, 24).has(28), 'the turn progression reaches E minor');
  assert.ok(roots(64, 80).has(35), 'the second drop is in B minor');
  const secondDrop = byVoice(notes, 'section').find((note) => note.bar === 64);
  assert.equal(secondDrop.transpose, 2);
});

test('a kill hit plays a melodic stab on the next eighth, at most one per eighth', () => {
  const played = startedMusic(0.2);
  play(played, 1);
  const next = played.music.sequencer.nextStepIndex;
  played.music.hit(5);
  played.music.hit(5);
  play(played, 1.2, { startTime: 1 });
  const hits = byVoice(played.notes, 'hit');
  assert.equal(hits.length, 1);
  assert.ok(hits[0].step >= next && hits[0].step <= next + 1 && hits[0].step % 2 === 0, `hit at ${hits[0].step} after ${next}`);
  assert.ok(hits[0].chord.map((tone) => tone % 12).includes(hits[0].note % 12));
});

test('the death cue drops out two beats, then every layer returns', () => {
  const death = startedMusic(0.9);
  death.music.cue('death');
  play(death, 3);
  assert.equal(death.notes.filter((note) => note.step < 8 && note.voice !== 'section').length, 0);
  const after = death.notes.filter((note) => note.step >= 8 && note.step < 24);
  assert.deepEqual(byVoice(after, 'kick').map((note) => note.step), [8, 12, 16, 20]);
  for (const voice of ['closed-hat', 'bass', 'melody']) assert.ok(byVoice(after, voice).length > 0, `${voice} returns`);
});

test('the expiry cue drops the melody and hats for two bars, then they return', () => {
  const expiry = startedMusic(0.9);
  expiry.music.cue('expiry');
  play(expiry, 0.1 + 48 * expiry.music.sequencer.stepDuration);
  const during = expiry.notes.filter((note) => note.step < 32);
  const after = expiry.notes.filter((note) => note.step >= 32 && note.step < 48);
  assert.equal(byVoice(during, 'kick').length, 8);
  for (const voice of ['melody', 'lead', 'closed-hat', 'open-hat', 'shaker']) assert.equal(byVoice(during, voice).length, 0, `${voice} dropped`);
  for (const voice of ['melody', 'closed-hat']) assert.ok(byVoice(after, voice).length > 0, `${voice} returns`);
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

test('pickup and bomb cues schedule a riser and a crash, and the music gain follows setMusicVolume', () => {
  const { music, engine, context, notes } = startedMusic(0.5);
  const before = context.started.length;
  music.cue('pickup');
  music.cue('bomb');
  assert.ok(context.started.length > before);
  assert.deepEqual(notes.map((note) => note.voice), ['riser', 'crash']);
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
  assert.equal(engine.musicVolume, DEFAULT_MUSIC_VOLUME);
  assert.equal(engine.effectsVolume, DEFAULT_EFFECTS_VOLUME);
});
