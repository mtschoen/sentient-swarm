// Procedural four-on-the-floor techno arranged as a song (sections, phrases, fills and the melody
// come from arrangement.js; the synth voices from voices.js). A 16-step sequencer drives, per the
// current section: kick on every beat, closed hats on the offbeats (open hat on the last one and a
// shaker when hot), a clap on two and four, a resonant saw plus sine sub bass, a melody that plays
// from the first bar (a plucked detuned saw following the chords), a saw arpeggio above intensity
// 0.4, a held pad in the breakdown, and a dotted-eighth delay on the lead and melody. Bass, lead,
// melody and pad duck under each kick (sidechain pump). Fills end every 8-bar phrase; the build's
// last bar drops the kick under a riser and a snare roll; the drop opens on a crash.
// Intensity (0..1) maps to tempo 124 + 10 * intensity, the filter cutoffs, the layer levels and
// which section follows a breakdown. Cues: pickup is a one-bar riser, expiry drops the melody,
// lead and hats for two bars, death is a two-beat dropout, bomb is a crash. hit(count) plays a
// melodic stab (a chord tone) on the next eighth, at most one per eighth: kills are heard as notes.
// An optional onNote({ voice, step, time, ... }) listener sees every scheduled note and each
// section start (voice 'section'), for beat-synced visuals later and for structural tests.
import { StepSequencer } from './sequencer.js';
import { Arrangement, fillDropsKick, fillForBar, fillHits, melodyForBar, STEPS_PER_BAR } from './arrangement.js';
import { playBass, playClap, playCrash, playHat, playKick, playLead, playRiser } from './voices.js';

const LEAD_THRESHOLD = 0.4;
const DEATH_DROPOUT_STEPS = 8;
const EXPIRY_DROP_STEPS = 32;
const HIT_SPACING_STEPS = 2;
const PARAMETER_SMOOTHING_SECONDS = 0.08;
const SUB_SHELF_HERTZ = 90;
const SUB_SHELF_DECIBELS = -5;
const PRESENCE_HERTZ = 2500;
const PRESENCE_DECIBELS = 3;

export function levelsForIntensity(intensity) {
  return {
    kick: 0.62,
    hat: 0.45 + 0.25 * intensity,
    shaker: intensity >= 0.6 ? 0.14 + 0.12 * intensity : 0,
    clap: 0.7 + 0.2 * intensity,
    bass: 0.7 + 0.2 * intensity,
    rollingBass: intensity >= 0.5,
    melody: 0.75 + 0.15 * intensity,
    lead: intensity > LEAD_THRESHOLD ? 0.22 + 0.25 * (intensity - LEAD_THRESHOLD) / (1 - LEAD_THRESHOLD) : 0,
    leadSixteenths: intensity >= 0.75,
    chords: 0.35,
    hit: 0.5,
    crash: 0.4,
    repeatCrash: intensity >= 0.6,
    bassCutoff: 420 + 1800 * intensity ** 1.5,
    leadCutoff: 900 + 6000 * intensity,
    melodyCutoff: 2400 + 3600 * intensity,
  };
}

export class ProceduralMusic {
  // timers: an object with setInterval and clearInterval (the window in the page). When given,
  // start() drives update(context.currentTime) every scheduleIntervalSeconds and stop() ends it;
  // without it the owner calls update itself (the node tests do).
  constructor(engine, { onNote = null, timers = null } = {}) {
    this.engine = engine;
    this.onNote = onNote;
    this.timers = timers;
    this.timer = null;
    this.sequencer = new StepSequencer({ stepsPerBar: STEPS_PER_BAR });
    this.arrangement = new Arrangement();
    this.barContext = null;
    this.barMelody = [];
    this.started = false;
    this.nodes = null;
    this.muteUntilStep = -1;
    this.dropUntilStep = -1;
    this.pendingHit = 0;
    this.nextHitStep = 0;
    this.hitCount = 0;
    this.delayTempo = null;
    this.intensity = -1;
    this.setIntensity(0.2);
    this.scheduleStep = this.scheduleStep.bind(this);
  }

  // The tempo intensity asks for; the sequencer reaches it at the next bar start.
  get tempo() {
    return this.sequencer.targetBeatsPerMinute;
  }

  start() {
    const context = this.engine.context;
    if (context === null) return;
    if (this.nodes === null) this.nodes = this.buildGraph(context);
    this.sequencer.reset();
    this.arrangement.reset();
    this.barContext = null;
    this.started = true;
    this.applyParameters();
    if (this.timers !== null && this.timer === null) {
      const tick = () => this.update(context.currentTime);
      tick();
      this.timer = this.timers.setInterval(tick, this.sequencer.scheduleIntervalSeconds * 1000);
    }
  }

  stop() {
    this.started = false;
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
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
      const time = context.currentTime;
      if (name === 'pickup') {
        playRiser(context, this.engine.noiseBuffer, this.nodes.layers.effects, time, { level: 0.45, durationSeconds: barSeconds });
        this.note('riser', next, time, { cue: name });
      } else if (name === 'bomb') {
        playCrash(context, this.engine.noiseBuffer, this.nodes.layers.effects, time, { level: 0.7 });
        this.note('crash', next, time, { cue: name });
      }
    }
  }

  // Kills this frame: a melodic stab on the next eighth (bigger counts play louder).
  hit(count) {
    if (count > 0) this.pendingHit = Math.max(this.pendingHit, count);
  }

  update(currentTime) {
    if (!this.started || this.engine.context === null) return;
    this.sequencer.update(currentTime, this.scheduleStep);
  }

  // layers names each node that feeds the music bus or the pump once, so the offline render check
  // can solo one layer by disconnecting the others.
  buildGraph(context) {
    const filter = (type, frequency, q, destination, gainDecibels = 0) => {
      const node = context.createBiquadFilter();
      node.type = type;
      node.frequency.setValueAtTime(frequency, 0);
      node.Q.setValueAtTime(q, 0);
      if (gainDecibels !== 0) node.gain.setValueAtTime(gainDecibels, 0);
      node.connect(destination);
      return node;
    };
    // Laptop and phone speakers cannot play the sub below about 90 Hz, where it only eats the
    // output compressor's headroom: the bus trims it and lifts the presence band instead.
    const lowShelf = filter('lowshelf', SUB_SHELF_HERTZ, 0.7, this.engine.musicOutput, SUB_SHELF_DECIBELS);
    const presence = filter('peaking', PRESENCE_HERTZ, 0.8, lowShelf, PRESENCE_DECIBELS);
    const bus = context.createGain();
    bus.connect(presence);
    const toBus = (node) => { node.connect(bus); return node; };
    const pump = toBus(context.createGain());
    const toPump = (node) => { node.connect(pump); return node; };
    const kick = toBus(context.createGain());
    const hats = filter('highpass', 7000, 0.7, bus);
    const clap = filter('bandpass', 1600, 0.8, bus);
    const bass = toPump(context.createGain());
    const lead = toPump(context.createGain());
    const melody = toPump(context.createGain());
    const chords = toPump(context.createGain());
    const hits = toBus(context.createGain());
    const effects = toBus(context.createGain());
    const leadFilter = filter('lowpass', 2000, 4, lead);
    const melodyFilter = filter('lowpass', 3000, 2, melody);
    const padFilter = filter('lowpass', 1400, 1, chords);
    const hitFilter = filter('lowpass', 6500, 1, hits);
    const delay = context.createDelay(1);
    const feedback = context.createGain();
    feedback.gain.setValueAtTime(0.38, 0);
    const delayWet = toBus(context.createGain());
    delayWet.gain.setValueAtTime(0.3, 0);
    lead.connect(delay);
    const melodySend = context.createGain();
    melodySend.gain.setValueAtTime(0.5, 0);
    melody.connect(melodySend);
    melodySend.connect(delay);
    hits.connect(melodySend);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(delayWet);
    return {
      bus, pump, delay, leadFilter, melodyFilter, padFilter, hitFilter,
      layers: { kick, hats, clap, bass, lead, melody, chords, hits, effects },
    };
  }

  applyParameters() {
    const context = this.engine.context;
    if (this.nodes === null || context === null) return;
    const now = context.currentTime;
    this.nodes.leadFilter.frequency.setTargetAtTime(this.levels.leadCutoff, now, PARAMETER_SMOOTHING_SECONDS);
    this.nodes.melodyFilter.frequency.setTargetAtTime(this.levels.melodyCutoff, now, PARAMETER_SMOOTHING_SECONDS);
  }

  // The dotted-eighth delay follows the tempo the sequencer actually plays, so it only moves at a
  // bar start, together with the tempo, and never glides with the per-frame intensity.
  followTempoWithDelay(time) {
    if (this.delayTempo === this.sequencer.beatsPerMinute) return;
    this.delayTempo = this.sequencer.beatsPerMinute;
    this.nodes.delay.delayTime.setValueAtTime(this.sequencer.stepDuration * 3, time);
  }

  note(voice, step, time, extra = {}) {
    this.onNote?.({ voice, step, time, ...extra });
  }

  // The bar's arrangement context, refreshed when the step enters a new bar (steps may skip).
  enterBar(bar, step, time) {
    if (this.barContext !== null && this.barContext.bar === bar) return;
    this.barContext = this.arrangement.bar(bar, this.intensity);
    this.barMelody = melodyForBar(this.barContext);
    this.barFill = fillForBar(this.barContext);
    this.barFillHits = new Map(fillHits(this.barFill).map(({ position, scale }) => [position, scale]));
    const { name, barInSection, transpose, progression } = this.barContext;
    if (barInSection === 0) this.note('section', step, time, { name, bar, transpose, progression });
  }

  scheduleStep(step, time) {
    this.followTempoWithDelay(time);
    const position = step % STEPS_PER_BAR;
    this.enterBar(Math.floor(step / STEPS_PER_BAR), step, time);
    if (step < this.muteUntilStep) return;
    const playing = { step, time, position, dropped: step < this.dropUntilStep, stepDuration: this.sequencer.stepDuration };
    this.scheduleDrums(playing);
    this.scheduleFill(playing);
    this.scheduleBass(playing);
    this.scheduleMelody(playing);
    this.scheduleLead(playing);
    this.scheduleChords(playing);
    this.scheduleHit(playing);
  }

  scheduleDrums({ step, time, position, dropped, stepDuration }) {
    const context = this.engine.context;
    const noise = this.engine.noiseBuffer;
    const { levels, nodes } = this;
    const { section, barInSection, sectionEnd } = this.barContext;
    const kickOn = section.kick === 'four' && !fillDropsKick(this.barFill, position);
    if (position % 4 === 0 && kickOn) {
      playKick(context, nodes.layers.kick, time, levels.kick);
      this.note('kick', step, time);
      nodes.pump.gain.setValueAtTime(0.35, time);
      nodes.pump.gain.linearRampToValueAtTime(1, time + stepDuration * 2.5);
    }
    if (position === 0 && section.crash && (barInSection === 0 || (levels.repeatCrash && barInSection % 4 === 0)) && !dropped) {
      playCrash(context, noise, nodes.layers.effects, time, { level: levels.crash, seed: step });
      this.note('crash', step, time);
    }
    if (position === 0 && section.endRiser && sectionEnd) {
      playRiser(context, noise, nodes.layers.effects, time, { level: 0.4, durationSeconds: stepDuration * STEPS_PER_BAR });
      this.note('riser', step, time);
    }
    if (dropped) return;
    const hatsOn = section.hats === 'sparse' ? position === 14 : position % 4 === 2;
    if (hatsOn) {
      const open = position === 14 && section.hats !== 'closed';
      playHat(context, noise, nodes.layers.hats, time, { level: levels.hat * (open ? 0.9 : 1), open, seed: step });
      this.note(open ? 'open-hat' : 'closed-hat', step, time);
    }
    if (section.hats === 'full' && position % 2 === 1 && levels.shaker > 0) {
      playHat(context, noise, nodes.layers.hats, time, { level: levels.shaker, open: false, seed: step + 101 });
      this.note('shaker', step, time);
    }
    if (section.clap && (position === 4 || position === 12) && !this.barFillHits.has(position)) {
      playClap(context, noise, nodes.layers.clap, time, { level: levels.clap, seed: step });
      this.note('clap', step, time);
    }
  }

  scheduleFill({ step, time, position }) {
    const scale = this.barFillHits.get(position);
    if (scale === undefined) return;
    playClap(this.engine.context, this.engine.noiseBuffer, this.nodes.layers.clap, time, { level: this.levels.clap * scale, seed: step });
    this.note('fill', step, time, { fill: this.barFill });
  }

  scheduleBass({ step, time, position, stepDuration }) {
    const { section, harmony } = this.barContext;
    if (this.barFill === 'kick-out') return;
    const levels = this.levels;
    let note = null;
    let lengthSteps = 1.4;
    if (section.bass === 'held') {
      if (position === 0) {
        note = harmony.root;
        lengthSteps = STEPS_PER_BAR * 0.9;
      }
    } else if (section.bass === 'sparse') {
      if (position === 2 || position === 10) note = harmony.root;
    } else if (position % 4 === 2) {
      note = harmony.root;
    } else if (position % 4 === 3 && (section.bass === 'rolling' || levels.rollingBass)) {
      note = harmony.root + 12;
      lengthSteps = 0.9;
    }
    if (note === null) return;
    const cutoff = section.bass === 'held' ? levels.bassCutoff * 0.6 : levels.bassCutoff;
    playBass(this.engine.context, this.nodes.layers.bass, time, { note, level: levels.bass, cutoff, lengthSeconds: stepDuration * lengthSteps });
    this.note('bass', step, time, { rootNote: harmony.root });
  }

  scheduleMelody({ step, time, position, dropped, stepDuration }) {
    if (dropped) return;
    const { harmony } = this.barContext;
    for (const entry of this.barMelody) {
      if (entry.position !== position) continue;
      playLead(this.engine.context, this.nodes.melodyFilter, time, { note: entry.note, level: this.levels.melody, lengthSeconds: stepDuration * (entry.lengthSteps + 0.6) });
      this.note('melody', step, time, { note: entry.note, chord: harmony.chord });
    }
  }

  // The saw arpeggio, an octave below the melody so the two do not crowd each other.
  scheduleLead({ step, time, position, dropped, stepDuration }) {
    const { section, harmony } = this.barContext;
    const levels = this.levels;
    const eighth = position % 2 === 0;
    if (!section.lead || levels.lead === 0 || dropped || this.barFill === 'kick-out' || !(eighth || levels.leadSixteenths)) return;
    const pattern = [0, 2, 1, 2, 3, 2, 1, 2];
    const tone = pattern[(Math.floor(position / 2) + (eighth ? 0 : 3)) % pattern.length];
    const note = (tone === 3 ? harmony.chord[0] + 12 : harmony.chord[tone]) - 12;
    playLead(this.engine.context, this.nodes.leadFilter, time, { note, level: levels.lead * (eighth ? 1 : 0.55), lengthSeconds: stepDuration * (eighth ? 1.8 : 0.9) });
    this.note('lead', step, time, { rootNote: harmony.root });
  }

  scheduleChords({ step, time, position, stepDuration }) {
    const { section, harmony } = this.barContext;
    if (!section.chords || position !== 0) return;
    for (const tone of harmony.chord) {
      playLead(this.engine.context, this.nodes.padFilter, time, { note: tone - 12, level: this.levels.chords, lengthSeconds: stepDuration * STEPS_PER_BAR });
    }
    this.note('chord', step, time, { chord: harmony.chord });
  }

  scheduleHit({ step, time, position, stepDuration }) {
    if (this.pendingHit === 0 || position % 2 !== 0 || step < this.nextHitStep) return;
    const { harmony } = this.barContext;
    const note = harmony.chord[this.hitCount % harmony.chord.length] + 12;
    const level = this.levels.hit * Math.min(1, 0.5 + 0.15 * Math.log2(1 + this.pendingHit));
    playLead(this.engine.context, this.nodes.hitFilter, time, { note, level, lengthSeconds: stepDuration * 1.2 });
    this.note('hit', step, time, { note, chord: harmony.chord, count: this.pendingHit });
    this.hitCount += 1;
    this.pendingHit = 0;
    this.nextHitStep = step + HIT_SPACING_STEPS;
  }
}
