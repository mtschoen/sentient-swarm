// Fake AudioContext for node tests: records node creation, connections, parameter automation and
// start times. Nothing here produces sound. currentTime is set by the test.

class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
  }

  record(kind, value, time, extra) {
    if (!Number.isFinite(time)) throw new TypeError(`${kind} automation time must be finite, got ${time}`);
    this.events.push({ kind, value, time, extra });
    return this;
  }

  setValueAtTime(value, time) { return this.record('set', value, time); }
  linearRampToValueAtTime(value, time) { return this.record('linear', value, time); }
  exponentialRampToValueAtTime(value, time) {
    if (!(value > 0)) throw new RangeError('exponential ramp target must be positive');
    return this.record('exponential', value, time);
  }
  setTargetAtTime(value, time, constant) { return this.record('target', value, time, constant); }
  cancelScheduledValues(time) { return this.record('cancel', null, time); }
}

class FakeNode {
  constructor(context, kind) {
    this.context = context;
    this.kind = kind;
    this.outputs = [];
    context.nodes.push(this);
  }

  connect(target) {
    this.outputs.push(target);
    return target;
  }

  disconnect() { this.outputs = []; }
}

class FakeSourceNode extends FakeNode {
  constructor(context, kind) {
    super(context, kind);
    this.startTime = null;
    this.startOffset = 0;
    this.stopTime = null;
    this.onended = null;
  }

  start(time = 0, offset = 0) {
    if (this.startTime !== null) throw new Error('start called twice');
    this.startTime = time;
    this.startOffset = offset;
    this.context.started.push(this);
  }

  stop(time = 0) { this.stopTime = time; }

  // What the browser does once the source has stopped.
  fireEnded() { this.onended?.(); }
}

export class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
    this.nodes = [];
    this.started = [];
    this.destination = new FakeNode(this, 'destination');
  }

  createGain() {
    const node = new FakeNode(this, 'gain');
    node.gain = new FakeParam(1);
    return node;
  }

  createOscillator() {
    const node = new FakeSourceNode(this, 'oscillator');
    node.type = 'sine';
    node.frequency = new FakeParam(440);
    node.detune = new FakeParam(0);
    return node;
  }

  createBiquadFilter() {
    const node = new FakeNode(this, 'filter');
    node.type = 'lowpass';
    node.frequency = new FakeParam(350);
    node.Q = new FakeParam(1);
    return node;
  }

  createDelay(maximumDelayTime = 1) {
    const node = new FakeNode(this, 'delay');
    node.maximumDelayTime = maximumDelayTime;
    node.delayTime = new FakeParam(0);
    return node;
  }

  createDynamicsCompressor() {
    const node = new FakeNode(this, 'compressor');
    for (const name of ['threshold', 'knee', 'ratio', 'attack', 'release']) node[name] = new FakeParam(0);
    return node;
  }

  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (index) => data[index] };
  }

  createBufferSource() {
    const node = new FakeSourceNode(this, 'buffer-source');
    node.buffer = null;
    node.loop = false;
    node.playbackRate = new FakeParam(1);
    return node;
  }

  resume() { this.state = 'running'; return Promise.resolve(); }

  // A context that starts suspended and only runs on the resumeCallsToRun-th resume() call, like a
  // context created from a touch pointerdown that a later gesture finally unlocks.
  static suspendedUntilResumedTimes(resumeCallsToRun) {
    const context = new FakeAudioContext();
    context.state = 'suspended';
    context.resumeCalls = 0;
    context.resume = () => {
      context.resumeCalls += 1;
      if (context.resumeCalls >= resumeCallsToRun) context.state = 'running';
      return Promise.resolve();
    };
    return context;
  }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
}
