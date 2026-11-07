// Procedural four-on-the-floor techno. A 16-step sequencer drives: kick on every beat, closed hat on
// the offbeats with an open hat every fourth, a clap on two and four, a resonant saw plus sine sub
// bass on a four-bar minor progression (Am F C G), a detuned saw lead arpeggio above intensity 0.4,
// and a dotted-eighth delay on the lead. Bass and lead duck under each kick (sidechain pump).
// Intensity (0..1) maps to tempo 124 + 10 * intensity, the bass and lead lowpass cutoffs, and the
// layer levels. Cues: pickup is a one-bar riser, expiry drops lead and hats for two bars, death is a
// two-beat dropout, bomb is a crash.
// An optional onNote({ voice, step, time, rootNote }) listener sees every scheduled note, for
// beat-synced visuals later and for structural tests.
import { StepSequencer } from './sequencer.js';
import { playBass, playClap, playCrash, playHat, playKick, playLead, playRiser } from './voices.js';

const STEPS_PER_BAR = 16;
const PROGRESSION = [
  { root: 33, chord: [69, 72, 76] }, // A minor
  { root: 29, chord: [65, 69, 72] }, // F major
  { root: 36, chord: [67, 72, 76] }, // C major
  { root: 31, chord: [67, 71, 74] }, // G major
];
// Chord-tone index per eighth note; 3 is the root an octave up.
const LEAD_PATTERN = [0, 2, 1, 2, 3, 2, 1, 2];
const LEAD_THRESHOLD = 0.4;
const DEATH_DROPOUT_STEPS = 8;
const EXPIRY_DROP_STEPS = 32;
const PARAMETER_SMOOTHING_SECONDS = 0.08;

export function levelsForIntensity(intensity) {
  return {
    kick: 0.95,
    hat: 0.22 + 0.2 * intensity,
    shaker: intensity >= 0.6 ? 0.08 + 0.08 * intensity : 0,
    clap: intensity >= 0.3 ? 0.45 + 0.2 * intensity : 0,
    bass: 0.5 + 0.2 * intensity,
    rollingBass: intensity >= 0.5,
    lead: intensity > LEAD_THRESHOLD ? 0.14 + 0.2 * (intensity - LEAD_THRESHOLD) / (1 - LEAD_THRESHOLD) : 0,
    leadSixteenths: intensity >= 0.75,
    crash: intensity >= 0.6 ? 0.3 : 0,
    bassCutoff: 220 + 1600 * intensity ** 1.5,
    leadCutoff: 900 + 6000 * intensity,
  };
}

export class ProceduralMusic {
  constructor(engine, { onNote = null } = {}) {
    this.engine = engine;
    this.onNote = onNote;
    this.sequencer = new StepSequencer({ stepsPerBar: STEPS_PER_BAR });
    this.started = false;
    this.nodes = null;
    this.muteUntilStep = -1;
    this.dropUntilStep = -1;
    this.setIntensity(0.2);
    this.scheduleStep = this.scheduleStep.bind(this);
  }

  get tempo() {
    return this.sequencer.beatsPerMinute;
  }

  start() {
    const context = this.engine.context;
    if (context === null) return;
    if (this.nodes === null) this.nodes = this.buildGraph(context);
    this.sequencer.reset();
    this.started = true;
    this.applyParameters();
  }

  stop() {
    this.started = false;
  }

  setIntensity(value) {
    const intensity = Math.min(1, Math.max(0, value));
    // Called every frame; skip changes too small to hear so the parameter timeline stays short.
    if (Math.abs(intensity - this.intensity) < 0.002) return;
    this.intensity = intensity;
    this.levels = levelsForIntensity(intensity);
    this.sequencer.setTempo(Math.round((124 + 10 * intensity) * 100) / 100);
    this.applyParameters();
  }

  cue(name) {
    const context = this.engine.context;
    const next = this.sequencer.nextStepIndex;
    if (name === 'death') this.muteUntilStep = next + DEATH_DROPOUT_STEPS;
    else if (name === 'expiry') this.dropUntilStep = next + EXPIRY_DROP_STEPS;
    else if (this.nodes !== null && context !== null) {
      const barSeconds = this.sequencer.stepDuration * STEPS_PER_BAR;
      if (name === 'pickup') playRiser(context, this.engine.noiseBuffer, this.nodes.bus, context.currentTime, { level: 0.35, durationSeconds: barSeconds });
      else if (name === 'bomb') playCrash(context, this.engine.noiseBuffer, this.nodes.bus, context.currentTime, { level: 0.6 });
    }
  }

  update(currentTime) {
    if (!this.started || this.engine.context === null) return;
    this.sequencer.update(currentTime, this.scheduleStep);
  }

  buildGraph(context) {
    const output = (node) => { node.connect(bus); return node; };
    const bus = context.createGain();
    bus.connect(this.engine.musicOutput);
    const drums = output(context.createGain());
    const hatFilter = output(context.createBiquadFilter());
    hatFilter.type = 'highpass';
    hatFilter.frequency.setValueAtTime(7500, 0);
    const clapFilter = output(context.createBiquadFilter());
    clapFilter.type = 'bandpass';
    clapFilter.frequency.setValueAtTime(1600, 0);
    clapFilter.Q.setValueAtTime(0.8, 0);
    // Bass and lead share a pump gain that ducks under each kick.
    const pump = output(context.createGain());
    const leadBus = context.createGain();
    leadBus.connect(pump);
    const leadFilter = context.createBiquadFilter();
    leadFilter.type = 'lowpass';
    leadFilter.Q.setValueAtTime(4, 0);
    leadFilter.connect(leadBus);
    const delay = context.createDelay(1);
    const feedback = context.createGain();
    feedback.gain.setValueAtTime(0.38, 0);
    const delayWet = output(context.createGain());
    delayWet.gain.setValueAtTime(0.3, 0);
    leadBus.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(delayWet);
    return { bus, drums, hatFilter, clapFilter, pump, leadFilter, delay };
  }

  applyParameters() {
    const context = this.engine.context;
    if (this.nodes === null || context === null) return;
    const now = context.currentTime;
    this.nodes.leadFilter.frequency.setTargetAtTime(this.levels.leadCutoff, now, PARAMETER_SMOOTHING_SECONDS);
    this.nodes.delay.delayTime.setTargetAtTime(this.sequencer.stepDuration * 3, now, PARAMETER_SMOOTHING_SECONDS);
  }

  note(voice, step, time, extra = {}) {
    this.onNote?.({ voice, step, time, ...extra });
  }

  scheduleStep(step, time) {
    if (step < this.muteUntilStep) return;
    const context = this.engine.context;
    const noise = this.engine.noiseBuffer;
    const { levels, nodes } = this;
    const stepDuration = this.sequencer.stepDuration;
    const position = step % STEPS_PER_BAR;
    const bar = Math.floor(step / STEPS_PER_BAR);
    const harmony = PROGRESSION[bar % PROGRESSION.length];
    const dropped = step < this.dropUntilStep;

    if (position % 4 === 0) {
      playKick(context, nodes.drums, time, levels.kick);
      this.note('kick', step, time);
      nodes.pump.gain.setValueAtTime(0.35, time);
      nodes.pump.gain.linearRampToValueAtTime(1, time + stepDuration * 2.5);
    }
    if (position === 0 && bar % 4 === 0 && levels.crash > 0 && !dropped) {
      playCrash(context, noise, nodes.bus, time, { level: levels.crash, seed: bar });
      this.note('crash', step, time);
    }
    if (position % 4 === 2 && !dropped) {
      const open = position === 14;
      playHat(context, noise, nodes.hatFilter, time, { level: levels.hat * (open ? 0.9 : 1), open, seed: step });
      this.note(open ? 'open-hat' : 'closed-hat', step, time);
    }
    if (position % 2 === 1 && levels.shaker > 0 && !dropped) {
      playHat(context, noise, nodes.hatFilter, time, { level: levels.shaker, open: false, seed: step + 101 });
      this.note('shaker', step, time);
    }
    if ((position === 4 || position === 12) && levels.clap > 0) {
      playClap(context, noise, nodes.clapFilter, time, { level: levels.clap, seed: step });
      this.note('clap', step, time);
    }
    const offbeatBass = position % 4 === 2;
    const rollingBass = position % 4 === 3 && levels.rollingBass;
    if (offbeatBass || rollingBass) {
      const note = harmony.root + (rollingBass ? 12 : 0);
      playBass(context, nodes.pump, time, { note, level: levels.bass, cutoff: levels.bassCutoff, lengthSeconds: stepDuration * (offbeatBass ? 1.4 : 0.9) });
      this.note('bass', step, time, { rootNote: harmony.root });
    }
    const eighth = position % 2 === 0;
    if (levels.lead > 0 && !dropped && (eighth || levels.leadSixteenths)) {
      const patternIndex = Math.floor(position / 2) + (eighth ? 0 : 3);
      const tone = LEAD_PATTERN[patternIndex % LEAD_PATTERN.length];
      const note = tone === 3 ? harmony.chord[0] + 12 : harmony.chord[tone];
      playLead(context, nodes.leadFilter, time, { note, level: levels.lead * (eighth ? 1 : 0.55), lengthSeconds: stepDuration * (eighth ? 1.8 : 0.9) });
      this.note('lead', step, time, { rootNote: harmony.root });
    }
  }
}
