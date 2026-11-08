// Offline audio render: runs the real music and effects code against an OfflineAudioContext, so
// nothing reaches the speakers. window.__audioRender exposes:
//   renderMusic({ intensity, seconds, solo, musicVolume }): the whole song at a fixed intensity,
//     or only the solo layers (keys of music.nodes.layers), as levels, a 16-bit WAV (base64) and a
//     per-phrase summary of the note events.
//   renderEffects({ effectsVolume }): one shot of every effect, levels per effect.
//   renderPlay({ intensity, seconds, kind, tier, fireInterval }): music plus a held weapon, kill
//     splashes and melodic hits on a play-like schedule (OfflineAudioContext.suspend steps the
//     clock the music and effects read).
// ?source=<path> loads the audio modules from another directory the dev server serves (an older
// copy, for before and after measurements); the default is /src/audio.
const SOURCE = new URLSearchParams(location.search).get('source') ?? '/src/audio';
const { AudioEngine } = await import(`${SOURCE}/audio.js`);
const { ProceduralMusic } = await import(`${SOURCE}/music.js`);
const { EffectsSynth } = await import(`${SOURCE}/sfx.js`);

const SAMPLE_RATE = 48000;
const SCHEDULE_TICK_SECONDS = 0.05;
const BARS_PER_PHRASE = 8;
const STEPS_PER_BAR = 16;

function decibels(value) {
  return value > 0 ? Math.round(20 * Math.log10(value) * 10) / 10 : -Infinity;
}

// Small laptop and phone speakers reproduce little below about 200 Hz, so a kick-heavy mix can
// measure loud and still sound quiet there. speakerRmsDecibels is the RMS after a 200 Hz
// second-order highpass (RBJ biquad), a rough proxy for what such a speaker plays.
const SPEAKER_HIGHPASS_HERTZ = 200;

function highpass(samples) {
  const omega = 2 * Math.PI * SPEAKER_HIGHPASS_HERTZ / SAMPLE_RATE;
  const alpha = Math.sin(omega) / (2 * Math.SQRT1_2);
  const cosine = Math.cos(omega);
  const a0 = 1 + alpha;
  const b0 = (1 + cosine) / 2 / a0;
  const b1 = -(1 + cosine) / a0;
  const a1 = -2 * cosine / a0;
  const a2 = (1 - alpha) / a0;
  const output = new Float32Array(samples.length);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const x0 = samples[index];
    const y0 = b0 * x0 + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    output[index] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return output;
}

function peakAndRms(samples, from, to) {
  let peak = 0;
  let sumOfSquares = 0;
  for (let index = from; index < to; index += 1) {
    const value = Math.abs(samples[index]);
    if (value > peak) peak = value;
    sumOfSquares += value * value;
  }
  return { peak, rms: Math.sqrt(sumOfSquares / Math.max(1, to - from)) };
}

// Peak, RMS and speaker RMS in dBFS over samples[from..to).
function measure(samples, from = 0, to = samples.length) {
  const full = peakAndRms(samples, from, to);
  const speaker = peakAndRms(highpass(samples), from, to);
  return { peakDecibels: decibels(full.peak), rmsDecibels: decibels(full.rms), speakerRmsDecibels: decibels(speaker.rms) };
}

function encodeWav(samples) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const writeText = (offset, text) => { for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index); };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, samples[index])) * 32767), true);
  }
  let text = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) text += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return btoa(text);
}

function createEngine(seconds) {
  const context = new OfflineAudioContext(1, Math.ceil(SAMPLE_RATE * seconds), SAMPLE_RATE);
  const engine = new AudioEngine({ contextFactory: () => context });
  engine.unlock();
  return { context, engine };
}

// The layer nodes music.nodes.layers names (each feeds the music bus once); the ones not in solo
// are disconnected so only the solo layers reach the output.
function layerMap(music) {
  const legacy = { drums: music.nodes.drums, hats: music.nodes.hatFilter, clap: music.nodes.clapFilter, bassAndLead: music.nodes.pump };
  return music.nodes.layers ?? legacy;
}

function soloLayers(music, solo) {
  const layers = layerMap(music);
  for (const [name, node] of Object.entries(layers)) if (!solo.includes(name)) node.disconnect();
  return Object.keys(layers);
}

// Section starts and per-phrase note counts by voice, from the onNote events.
function summarize(events) {
  const sections = events.filter((event) => event.voice === 'section').map((event) => ({ bar: event.bar, name: event.name, key: event.key, progression: event.progression }));
  const phrases = new Map();
  for (const event of events) {
    if (event.voice === 'section') continue;
    const phrase = Math.floor(event.step / STEPS_PER_BAR / BARS_PER_PHRASE);
    if (!phrases.has(phrase)) phrases.set(phrase, {});
    const counts = phrases.get(phrase);
    counts[event.voice] = (counts[event.voice] ?? 0) + 1;
  }
  const melodyByPhrase = new Map();
  for (const event of events) {
    if (event.voice !== 'melody') continue;
    const phrase = Math.floor(event.step / STEPS_PER_BAR / BARS_PER_PHRASE);
    if (!melodyByPhrase.has(phrase)) melodyByPhrase.set(phrase, []);
    const notes = melodyByPhrase.get(phrase);
    if (notes.length < 12) notes.push(event.note);
  }
  return {
    sections,
    phrases: [...phrases.entries()].map(([phrase, counts]) => ({ phrase, counts, melodyStart: melodyByPhrase.get(phrase) ?? [] })),
  };
}

async function renderMusic({ intensity, seconds, solo = null, musicVolume = null, withWav = false }) {
  const { context, engine } = createEngine(seconds);
  if (musicVolume !== null) engine.setMusicVolume(musicVolume);
  const events = [];
  const music = new ProceduralMusic(engine, { onNote: (event) => events.push(event) });
  music.setIntensity(intensity);
  music.start();
  const layerNames = solo === null ? Object.keys(layerMap(music)) : soloLayers(music, solo);
  for (let time = 0; time < seconds; time += SCHEDULE_TICK_SECONDS) music.update(time);
  const buffer = await context.startRendering();
  const samples = buffer.getChannelData(0);
  const skip = Math.min(samples.length - 1, SAMPLE_RATE);
  return {
    intensity,
    solo,
    layerNames,
    levels: measure(samples, skip),
    tempo: music.tempo,
    summary: solo === null ? summarize(events) : null,
    wav: withWav ? encodeWav(samples) : null,
  };
}

// OfflineAudioContext.suspend times must sit on a render quantum.
const QUANTUM_SECONDS = 128 / SAMPLE_RATE;
const atQuantum = (time) => Math.round(time / QUANTUM_SECONDS) * QUANTUM_SECONDS;
const EFFECT_SHOT_SECONDS = 0.5;

// One shot of each effect, half a second in (the output compressor has settled by then).
async function renderEffects({ effectsVolume = null } = {}) {
  const shots = [
    ['weaponFire', 'base', 1], ['weaponFire', 'base', 3],
    ['weaponFire', 'beam', 1], ['weaponFire', 'beam', 3],
    ['weaponFire', 'scatter', 1], ['weaponFire', 'scatter', 3],
    ['weaponFire', 'rail', 1], ['weaponFire', 'rail', 3],
    ['weaponFire', 'pulse', 1], ['weaponFire', 'pulse', 3],
    ['weaponFire', 'sidewinders', 1], ['weaponFire', 'sidewinders', 3],
    ['kills', 1], ['kills', 40], ['pickup'], ['bomb'], ['death'], ['expiry'],
  ];
  const results = [];
  for (const [method, ...parameters] of shots) {
    const { context, engine } = createEngine(2);
    if (effectsVolume !== null) engine.setEffectsVolume(effectsVolume);
    const effects = new EffectsSynth(engine);
    context.suspend(atQuantum(EFFECT_SHOT_SECONDS)).then(() => {
      effects[method](...parameters);
      context.resume();
    });
    const samples = (await context.startRendering()).getChannelData(0);
    results.push({ effect: [method, ...parameters].join(' '), levels: measure(samples, Math.round(EFFECT_SHOT_SECONDS * SAMPLE_RATE)) });
  }
  return results;
}

// Music plus a weapon held down (base gun: a shot every 0.12 s) and a kill splash with its
// melodic hit every 0.24 s, from second 2 on. The clock advances in suspend ticks, so the music
// schedules ahead exactly as the page timer does and the effects read a live currentTime.
async function renderPlay({ intensity, seconds, kind = 'base', tier = 1, fireInterval = 0.12 }) {
  const { context, engine } = createEngine(seconds);
  const music = new ProceduralMusic(engine);
  const effects = new EffectsSynth(engine);
  music.setIntensity(intensity);
  music.start();
  music.update(0);
  const tick = 0.04;
  let nextFire = 2;
  let shots = 0;
  for (let time = tick; time < seconds - 0.1; time += tick) {
    const tickTime = atQuantum(time);
    context.suspend(tickTime).then(() => {
      try {
        music.update(context.currentTime);
        if (context.currentTime >= nextFire) {
          nextFire += fireInterval;
          effects.weaponFire(kind, tier);
          shots += 1;
          if (shots % 2 === 0) {
            effects.kills(6);
            // Older copies (the before measurement) have no melodic hits.
            music.hit?.(6);
          }
        }
      } finally {
        context.resume();
      }
    });
  }
  const samples = (await context.startRendering()).getChannelData(0);
  return { intensity, levels: measure(samples, SAMPLE_RATE * 2), wav: encodeWav(samples) };
}

window.__audioRender = { renderMusic, renderEffects, renderPlay };
window.__audioRenderReady = true;
