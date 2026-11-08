// The player ship on the CPU: position, aim and facing, stepped from the unified InputState.
// Pure: no GPU, DOM or clock. Each update moves by inputState.move * speed * deltaSeconds and
// clamps the center inside the arena by radius. The aim follows inputState.aim while that vector
// is longer than AIM_DEADZONE and otherwise holds its last value; facing is the aim's angle.
// Getters return copies.
const AIM_DEADZONE = 0.2;
const INITIAL_AIM = { x: 1, y: 0 };

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export class PlayerShip {
  constructor({ speed = 6, radius = 0.12, arenaWidth, arenaHeight }) {
    if (!(arenaWidth > 2 * radius) || !(arenaHeight > 2 * radius)) {
      throw new Error(`PlayerShip needs an arena wider and taller than its diameter; got ${arenaWidth} by ${arenaHeight} for radius ${radius}`);
    }
    this.speed = speed;
    this.velocityX = 0;
    this.velocityY = 0;
    this.radius = radius;
    this.arenaWidth = arenaWidth;
    this.arenaHeight = arenaHeight;
    this.respawn();
  }

  get velocity() { return { x: this.velocityX, y: this.velocityY }; }
  get position() { return { x: this.positionX, y: this.positionY }; }
  get aim() { return { x: this.aimX, y: this.aimY }; }
  get facing() { return Math.atan2(this.aimY, this.aimX); }

  // Back to the arena center with the initial aim.
  respawn() {
    this.positionX = this.arenaWidth / 2;
    this.positionY = this.arenaHeight / 2;
    this.aimX = INITIAL_AIM.x;
    this.aimY = INITIAL_AIM.y;
    this.velocityX = 0;
    this.velocityY = 0;
  }

  update(deltaSeconds, inputState) {
    const step = this.speed * deltaSeconds;
    const previousX = this.positionX;
    const previousY = this.positionY;
    this.positionX = clamp(this.positionX + inputState.move.x * step, this.radius, this.arenaWidth - this.radius);
    this.positionY = clamp(this.positionY + inputState.move.y * step, this.radius, this.arenaHeight - this.radius);
    // The velocity of this step (world units per second), so a wall stops it; zero for a zero step.
    this.velocityX = deltaSeconds > 0 ? (this.positionX - previousX) / deltaSeconds : 0;
    this.velocityY = deltaSeconds > 0 ? (this.positionY - previousY) / deltaSeconds : 0;
    if (Math.hypot(inputState.aim.x, inputState.aim.y) > AIM_DEADZONE) {
      this.aimX = inputState.aim.x;
      this.aimY = inputState.aim.y;
    }
  }
}
