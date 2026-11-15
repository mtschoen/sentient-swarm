// The session clock: session time from connect, match time advanced by the game, and ping/pong offset estimates.

export const CLOCK_SAMPLE_COUNT = 8;

function pushSample(samples, sample) {
  samples.push(sample);
  if (samples.length > CLOCK_SAMPLE_COUNT) samples.shift();
}

// The sample with the smallest round trip; the newest wins a tie.
function bestSample(samples) {
  let best = null;
  for (const sample of samples) {
    if (best === null || sample.roundTripSeconds <= best.roundTripSeconds) best = sample;
  }
  return best;
}

export class SessionClock {
  #now;
  #connectedAt = null;
  #matchSeconds = 0;
  #matchRunning = false;
  #sessionSamples = [];
  #matchSamples = [];

  constructor({ now }) {
    this.#now = now;
  }

  connect() {
    this.#connectedAt = this.#now();
    this.#sessionSamples = [];
    this.#matchSamples = [];
  }

  get sessionSeconds() {
    return this.#connectedAt === null ? 0 : this.#now() - this.#connectedAt;
  }

  get matchSeconds() {
    return this.#matchSeconds;
  }

  advanceMatch(deltaSeconds) {
    this.#matchSeconds += deltaSeconds;
  }

  resetMatch() {
    this.#matchSeconds = 0;
    this.#matchSamples = [];
  }

  setMatchRunning(running) {
    this.#matchRunning = Boolean(running);
  }

  ping() {
    return { type: 'ping', sessionSeconds: this.sessionSeconds, matchSeconds: this.#matchSeconds };
  }

  pong(ping) {
    return {
      type: 'pong',
      echoSessionSeconds: ping.sessionSeconds,
      sessionSeconds: this.sessionSeconds,
      matchSeconds: this.#matchSeconds,
    };
  }

  receivePong(pong) {
    const sessionNow = this.sessionSeconds;
    const roundTripSeconds = sessionNow - pong.echoSessionSeconds;
    const halfTrip = roundTripSeconds / 2;
    pushSample(this.#sessionSamples, {
      roundTripSeconds,
      offsetSeconds: pong.sessionSeconds + halfTrip - sessionNow,
    });
    if (this.#matchRunning) {
      pushSample(this.#matchSamples, {
        roundTripSeconds,
        offsetSeconds: pong.matchSeconds + halfTrip - this.#matchSeconds,
      });
    }
  }

  get roundTripSeconds() {
    const best = bestSample(this.#sessionSamples);
    return best === null ? null : best.roundTripSeconds;
  }

  get sessionOffsetSeconds() {
    const best = bestSample(this.#sessionSamples);
    return best === null ? 0 : best.offsetSeconds;
  }

  get matchOffsetSeconds() {
    const best = bestSample(this.#matchSamples);
    return best === null ? 0 : best.offsetSeconds;
  }

  toLocalSession(remoteSessionSeconds) {
    return remoteSessionSeconds - this.sessionOffsetSeconds;
  }

  remoteMatchNow() {
    return this.#matchSeconds + this.matchOffsetSeconds;
  }
}
