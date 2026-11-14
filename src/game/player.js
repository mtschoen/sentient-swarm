// The player ship on the CPU: position, aim and facing, stepped from the unified InputState.
// Pure: no GPU, DOM or clock. Each update moves by inputState.move * speed * deltaSeconds and
// clamps the center inside the arena bounds by radius (the playable rectangle, setBounds). The aim follows inputState.aim while that vector
// is longer than AIM_DEADZONE and otherwise holds its last value; facing is the aim's angle. An
// optional maximumTurnRadians per update limits how far the aim turns toward the input aim.
// Getters return copies.
import { WORLD_BOUNDS } from '../sim/layout.js';

const AIM_DEADZONE = 0.2;
const INITIAL_AIM = { x: 1, y: 0 };

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

// Rotates the vector (currentX, currentY) toward the direction of (targetX, targetY) by the shortest
// way, by at most maximumTurnRadians; within the limit it returns the target itself. The result has
// the target's length. An exactly opposite target turns counterclockwise, so it never jitters.
export function turnAimToward(currentX, currentY, targetX, targetY, maximumTurnRadians) {
  if (!(maximumTurnRadians < Infinity)) return { x: targetX, y: targetY };
  let delta = Math.atan2(currentX * targetY - currentY * targetX, currentX * targetX + currentY * targetY);
  if (delta <= -Math.PI) delta = Math.PI;
  const limit = Math.max(0, maximumTurnRadians);
  if (Math.abs(delta) <= limit) return { x: targetX, y: targetY };
  const angle = Math.atan2(currentY, currentX) + Math.sign(delta) * limit;
  const length = Math.hypot(targetX, targetY);
  return { x: Math.cos(angle) * length, y: Math.sin(angle) * length };
}

export class PlayerShip {
  constructor({ speed = 6, radius = 0.12, bounds = WORLD_BOUNDS } = {}) {
    PlayerShip.#validate(bounds, radius);
    this.speed = speed;
    this.velocityX = 0;
    this.velocityY = 0;
    this.radius = radius;
    this.bounds = bounds;
    this.respawn();
  }

  static #validate(bounds, radius) {
    if (!(bounds.width > 2 * radius) || !(bounds.height > 2 * radius)) {
      throw new Error(`PlayerShip needs an arena wider and taller than its diameter; got ${bounds.width} by ${bounds.height} for radius ${radius}`);
    }
  }

  // Playable rectangle change (a canvas resize): validates, stores and pulls the ship inside.
  setBounds(bounds) {
    PlayerShip.#validate(bounds, this.radius);
    this.bounds = bounds;
    this.positionX = clamp(this.positionX, bounds.minX + this.radius, bounds.maxX - this.radius);
    this.positionY = clamp(this.positionY, bounds.minY + this.radius, bounds.maxY - this.radius);
  }

  get velocity() { return { x: this.velocityX, y: this.velocityY }; }
  get position() { return { x: this.positionX, y: this.positionY }; }
  get aim() { return { x: this.aimX, y: this.aimY }; }
  get facing() { return Math.atan2(this.aimY, this.aimX); }

  // Back to the arena center with the initial aim.
  respawn() {
    this.positionX = (this.bounds.minX + this.bounds.maxX) / 2;
    this.positionY = (this.bounds.minY + this.bounds.maxY) / 2;
    this.aimX = INITIAL_AIM.x;
    this.aimY = INITIAL_AIM.y;
    this.velocityX = 0;
    this.velocityY = 0;
  }

  update(deltaSeconds, inputState, { maximumTurnRadians = Infinity } = {}) {
    const step = this.speed * deltaSeconds;
    const previousX = this.positionX;
    const previousY = this.positionY;
    this.positionX = clamp(this.positionX + inputState.move.x * step, this.bounds.minX + this.radius, this.bounds.maxX - this.radius);
    this.positionY = clamp(this.positionY + inputState.move.y * step, this.bounds.minY + this.radius, this.bounds.maxY - this.radius);
    // The velocity of this step (world units per second), so a wall stops it; zero for a zero step.
    this.velocityX = deltaSeconds > 0 ? (this.positionX - previousX) / deltaSeconds : 0;
    this.velocityY = deltaSeconds > 0 ? (this.positionY - previousY) / deltaSeconds : 0;
    if (Math.hypot(inputState.aim.x, inputState.aim.y) > AIM_DEADZONE) {
      const aim = turnAimToward(this.aimX, this.aimY, inputState.aim.x, inputState.aim.y, maximumTurnRadians);
      this.aimX = aim.x;
      this.aimY = aim.y;
    }
  }
}
