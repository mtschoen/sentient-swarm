// Song structure for the procedural techno, kept apart from the synthesis (music.js). Sections are
// states: each names its length (8 or 16 bars, so every section starts on an 8-bar phrase), its
// progression, which layers play and how, and the transitions out of it, chosen from the intensity
// when the section ends:
//   intro (8) -> groove (8) -> build (8) -> drop (16) -> breakdown (8) -> groove, or build at
//   intensity 0.5 and above (a hot run skips straight back to the next build and drop).
// Two progressions contrast: home (Am F C G) for intro, groove and drop, turn (F G Em Am) for build
// and breakdown; every second drop is lifted KEY_CHANGE_SEMITONES (A minor to B minor).
// The melody is a hand-written two-bar motif per section type, mapped onto the current chord's
// tones (so it follows the harmony) and varied per 8-bar phrase: structure repeats, surface varies.
// The last bar of every phrase is a fill bar (see fillForBar).

export const STEPS_PER_BAR = 16;
export const BARS_PER_PHRASE = 8;
export const KEY_CHANGE_SEMITONES = 2;
const HOT_INTENSITY = 0.5;

// root is the bass note, chord three tones in the melody register (MIDI).
export const PROGRESSIONS = Object.freeze({
  home: Object.freeze([
    { root: 33, chord: [69, 72, 76] }, // A minor
    { root: 29, chord: [65, 69, 72] }, // F major
    { root: 36, chord: [67, 72, 76] }, // C major
    { root: 31, chord: [67, 71, 74] }, // G major
  ]),
  turn: Object.freeze([
    { root: 29, chord: [65, 69, 72] }, // F major
    { root: 31, chord: [67, 71, 74] }, // G major
    { root: 28, chord: [67, 71, 76] }, // E minor
    { root: 33, chord: [69, 72, 76] }, // A minor
  ]),
});

// Motif notes are [step within the bar, chord degree, length in steps]; degree 0 to 2 are the
// chord tones, 3 to 5 the same an octave up.
const MOTIFS = Object.freeze({
  intro: [[[0, 0, 3], [6, 2, 2], [10, 1, 4]], [[0, 3, 3], [8, 2, 2], [12, 1, 2]]],
  groove: [[[0, 0, 2], [3, 2, 1], [6, 3, 2], [8, 2, 1], [10, 1, 2], [14, 2, 2]], [[0, 4, 2], [3, 3, 1], [6, 2, 2], [10, 1, 1], [12, 0, 4]]],
  build: [[[0, 0, 2], [2, 1, 2], [4, 2, 2], [6, 3, 2], [8, 1, 2], [10, 2, 2], [12, 3, 2], [14, 4, 2]], [[0, 2, 2], [2, 3, 2], [4, 4, 2], [6, 5, 2], [8, 3, 2], [10, 4, 2], [12, 5, 4]]],
  drop: [[[0, 3, 2], [2, 3, 1], [4, 5, 2], [7, 4, 1], [8, 3, 2], [11, 2, 1], [12, 3, 4]], [[0, 4, 2], [3, 3, 1], [4, 2, 2], [6, 1, 2], [8, 2, 3], [12, 0, 2], [14, 1, 2]]],
  breakdown: [[[0, 3, 6], [6, 4, 2], [8, 5, 8]], [[0, 4, 6], [6, 3, 2], [8, 2, 8]]],
});

// The drop hook sits on the octave-up degrees; this brings it back to the middle register (the
// offline render showed it reaching F#6 with the octave variant, which was shrill).
const MOTIF_OCTAVE = Object.freeze({ drop: -12 });

// kick: 'four' (every beat) or 'none'; hats: 'closed' (offbeats), 'full' (offbeats, open hat on the
// last offbeat, shaker when hot) or 'sparse' (the open hat only); bass: 'sparse' (two offbeats),
// 'full' (every offbeat, rolling sixteenths when hot), 'rolling' (always rolling) or 'held' (one
// long note a bar); lead: the saw arpeggio may play (it still needs intensity above 0.4); chords:
// a held pad; endRiser: a riser over the last bar, which in a build also drops the kick (kickOut).
export const SECTIONS = Object.freeze({
  intro: Object.freeze({ bars: 8, progression: 'home', kick: 'four', hats: 'closed', clap: false, bass: 'sparse', lead: false, chords: false, endRiser: false, kickOut: false, crash: false }),
  groove: Object.freeze({ bars: 8, progression: 'home', kick: 'four', hats: 'full', clap: true, bass: 'full', lead: true, chords: false, endRiser: false, kickOut: false, crash: false }),
  build: Object.freeze({ bars: 8, progression: 'turn', kick: 'four', hats: 'full', clap: true, bass: 'full', lead: true, chords: false, endRiser: true, kickOut: true, crash: false }),
  drop: Object.freeze({ bars: 16, progression: 'home', kick: 'four', hats: 'full', clap: true, bass: 'rolling', lead: true, chords: false, endRiser: false, kickOut: false, crash: true }),
  breakdown: Object.freeze({ bars: 8, progression: 'turn', kick: 'none', hats: 'sparse', clap: false, bass: 'held', lead: false, chords: true, endRiser: true, kickOut: false, crash: false }),
});

export function nextSectionName(name, intensity) {
  switch (name) {
    case 'intro': return 'groove';
    case 'groove': return 'build';
    case 'build': return 'drop';
    case 'drop': return 'breakdown';
    default: return intensity >= HOT_INTENSITY ? 'build' : 'groove';
  }
}

// Tracks the current section as bars are asked for in increasing order (bars may be skipped, as
// the sequencer skips steps after a stall). bar() returns the bar's context.
export class Arrangement {
  constructor() {
    this.reset();
  }

  reset() {
    this.sectionName = 'intro';
    this.sectionStartBar = 0;
    this.sectionNumber = 0;
    this.dropCount = 0;
    this.occurrences = { intro: 0 };
    this.transpose = 0;
  }

  get section() {
    return SECTIONS[this.sectionName];
  }

  enter(name, startBar) {
    this.sectionName = name;
    this.sectionStartBar = startBar;
    this.sectionNumber += 1;
    this.occurrences[name] = (this.occurrences[name] ?? -1) + 1;
    if (name === 'drop') {
      this.transpose = this.dropCount % 2 === 1 ? KEY_CHANGE_SEMITONES : 0;
      this.dropCount += 1;
    } else {
      this.transpose = 0;
    }
  }

  bar(barIndex, intensity) {
    while (barIndex >= this.sectionStartBar + this.section.bars) {
      this.enter(nextSectionName(this.sectionName, intensity), this.sectionStartBar + this.section.bars);
    }
    const section = this.section;
    const barInSection = barIndex - this.sectionStartBar;
    const progression = PROGRESSIONS[section.progression];
    const base = progression[barInSection % progression.length];
    return {
      bar: barIndex,
      name: this.sectionName,
      section,
      sectionNumber: this.sectionNumber,
      occurrence: this.occurrences[this.sectionName],
      barInSection,
      barInPhrase: barInSection % BARS_PER_PHRASE,
      phraseInSection: Math.floor(barInSection / BARS_PER_PHRASE),
      phraseEnd: barInSection % BARS_PER_PHRASE === BARS_PER_PHRASE - 1,
      sectionEnd: barInSection === section.bars - 1,
      progression: section.progression,
      transpose: this.transpose,
      harmony: {
        root: base.root + this.transpose,
        chord: base.chord.map((note) => note + this.transpose),
      },
    };
  }
}

function degreeToNote(chord, degree) {
  const clamped = Math.max(0, Math.min(5, degree));
  return chord[clamped % 3] + (clamped >= 3 ? 12 : 0);
}

// The melody notes of one bar: [{ position, note, lengthSteps }]. A phrase is A A' A A'' over its
// eight bars (A is the two-bar motif); the variant ((occurrence + phraseInSection) mod 4) picks
// how A' and the second A differ, so consecutive phrases never repeat exactly. The fill bar plays
// only the motif's first half, leaving room for the fill.
export function melodyForBar(context) {
  const motif = MOTIFS[context.name];
  const { barInPhrase, harmony } = context;
  const variant = (context.occurrence + context.phraseInSection) % 4;
  let notes = motif[barInPhrase % 2].map(([position, degree, lengthSteps]) => ({ position, degree, lengthSteps, octave: 0 }));
  const answer = barInPhrase === 3 || barInPhrase === 7;
  if (answer && variant === 0) notes = notes.map((entry, index) => (index >= notes.length - 2 ? { ...entry, degree: entry.degree + 1 } : entry));
  if ((barInPhrase === 2 || barInPhrase === 3) && variant === 1) notes = notes.map((entry) => ({ ...entry, octave: 12 }));
  if (answer && variant === 2) {
    const degrees = notes.map((entry) => entry.degree).reverse();
    notes = notes.map((entry, index) => ({ ...entry, degree: degrees[index] }));
  }
  if ((barInPhrase === 4 || barInPhrase === 5) && variant % 2 === 1) notes = notes.map((entry) => ({ ...entry, degree: entry.degree + 1 }));
  if (answer && variant === 3) notes = notes.flatMap((entry) => (entry.lengthSteps >= 2 ? [{ ...entry, lengthSteps: 1 }, { ...entry, position: entry.position + 1, degree: entry.degree + 1, lengthSteps: entry.lengthSteps - 1 }] : [entry]));
  if (context.phraseEnd) notes = notes.filter((entry) => entry.position < 8);
  const register = MOTIF_OCTAVE[context.name] ?? 0;
  return notes.map(({ position, degree, lengthSteps, octave }) => ({ position, note: degreeToNote(harmony.chord, degree) + octave + register, lengthSteps }));
}

// The fill of a phrase's last bar, or null on other bars:
//   'kick-out': the build's last bar, no kick at all under the riser and a snare roll;
//   'roll': a clap roll in sixteenths over the second half, getting louder;
//   'stutter': claps on the offbeat sixteenths of the last beat and a kick drop on beat four;
//   'break': the kick stops after beat two, an open hat rings into the next phrase.
// Sections without a kick (breakdown) roll into the next section under their riser.
export function fillForBar(context) {
  if (!context.phraseEnd) return null;
  if (context.section.kickOut && context.sectionEnd) return 'kick-out';
  if (context.section.kick === 'none') return 'roll';
  const rotation = ['roll', 'stutter', 'break'];
  return rotation[(context.sectionNumber + context.phraseInSection) % rotation.length];
}

// Steps of the bar a fill plays a clap or snare hit on, with a level scale for each.
export function fillHits(fill) {
  switch (fill) {
    case 'kick-out':
      return [0, 4, 8, 10, 12, 13, 14, 15].map((position, index) => ({ position, scale: 0.4 + 0.6 * index / 7 }));
    case 'roll':
      return [8, 9, 10, 11, 12, 13, 14, 15].map((position, index) => ({ position, scale: 0.35 + 0.65 * index / 7 }));
    case 'stutter':
      return [12, 13, 15].map((position) => ({ position, scale: 0.8 }));
    case 'break':
      return [10, 14].map((position) => ({ position, scale: 0.7 }));
    default:
      return [];
  }
}

// Whether the fill silences the kick at this position.
export function fillDropsKick(fill, position) {
  if (fill === 'kick-out') return true;
  if (fill === 'stutter') return position === 12;
  if (fill === 'break') return position >= 8;
  return false;
}
