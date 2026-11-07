// Run state machine: lives, bombs, death and respawn timing, invulnerability.
// Actions are queued by playerHit, useBomb and the phase timers, and are returned
// (in queue order) by the next update call; update is the only way to drain them.
// Actions queued by playerHit and useBomb therefore drain on the next update call, not immediately.

export const RunPhase = {
  Ready: 'ready',
  Playing: 'playing',
  Dying: 'dying',
  Respawning: 'respawning',
  GameOver: 'gameOver',
};

const ARENA_CENTER = { x: 8, y: 4.5 };
const SHOCKWAVE_STRENGTH = 1;
const TIME_EPSILON = 1e-9;

export class RunState {
  constructor({ lives = 3, bombs = 3, dyingSeconds = 0.8, respawnSeconds = 0.6, invulnerableSeconds = 2 } = {}) {
    this._startLives = lives;
    this._startBombs = bombs;
    this._dyingSeconds = dyingSeconds;
    this._respawnSeconds = respawnSeconds;
    this._invulnerableSeconds = invulnerableSeconds;
    this._phase = RunPhase.Ready;
    this._lives = lives;
    this._bombs = bombs;
    this._phaseRemaining = 0;
    this._invulnerableRemaining = 0;
    this._respawnSequence = 0;
    this._queue = [];
  }

  get phase() { return this._phase; }
  get lives() { return this._lives; }
  get bombs() { return this._bombs; }
  get invulnerable() { return this._invulnerableRemaining > 0; }
  get respawnSequence() { return this._respawnSequence; }

  start() {
    this._phase = RunPhase.Playing;
    this._lives = this._startLives;
    this._bombs = this._startBombs;
    this._phaseRemaining = 0;
    this._invulnerableRemaining = 0;
    this._queue = [];
  }

  // RunState never learns the frame sequence on its own: the respawn action carries no
  // sequence. The game must call setRespawnSequence(nextFrameSequence) when it handles the
  // respawn action, using the sequence of the first step simulated with the respawned player.
  // Hits with a smaller frameSequence are then rejected as stale.
  setRespawnSequence(frameSequence) {
    this._respawnSequence = frameSequence;
  }

  addLife() { this._lives += 1; }
  addBomb() { this._bombs += 1; }

  playerHit(frameSequence, position = ARENA_CENTER) {
    if (this._phase !== RunPhase.Playing || this.invulnerable || frameSequence < this._respawnSequence) {
      return false;
    }
    this._lives -= 1;
    this._phase = RunPhase.Dying;
    this._phaseRemaining = this._dyingSeconds;
    this._queue.push({ type: 'clearArena' });
    this._queue.push({ type: 'shockwave', x: position.x, y: position.y, strength: SHOCKWAVE_STRENGTH });
    return true;
  }

  useBomb(position = ARENA_CENTER) {
    if (this._phase !== RunPhase.Playing || this._bombs <= 0) return false;
    this._bombs -= 1;
    this._queue.push({ type: 'bomb' });
    this._queue.push({ type: 'shockwave', x: position.x, y: position.y, strength: SHOCKWAVE_STRENGTH });
    return true;
  }

  update(deltaSeconds) {
    let remaining = deltaSeconds;
    if (this._phase === RunPhase.Playing && this._invulnerableRemaining > 0) {
      this._invulnerableRemaining -= remaining;
      if (this._invulnerableRemaining < TIME_EPSILON) this._invulnerableRemaining = 0;
    }
    while (this._phase === RunPhase.Dying || this._phase === RunPhase.Respawning) {
      if (this._phaseRemaining - remaining > TIME_EPSILON) {
        this._phaseRemaining -= remaining;
        break;
      }
      remaining = Math.max(0, remaining - this._phaseRemaining);
      this._phaseRemaining = 0;
      if (this._phase === RunPhase.Dying) {
        if (this._lives <= 0) {
          this._phase = RunPhase.GameOver;
          this._queue.push({ type: 'gameOver' });
        } else {
          this._phase = RunPhase.Respawning;
          this._phaseRemaining = this._respawnSeconds;
        }
      } else {
        this._phase = RunPhase.Playing;
        this._invulnerableRemaining = Math.max(0, this._invulnerableSeconds - remaining);
        this._queue.push({ type: 'respawn' });
      }
    }
    const actions = this._queue;
    this._queue = [];
    return actions;
  }
}
