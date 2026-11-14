// One player's seat: the controlled point (PlayerShip), its swarm (PlayerSwarm), the swarm's fire
// (SwarmFire), the armed weapon (WeaponState) and the held-button state that turns a level into a
// press. Game owns a list of seats and loops over it; stage 1 of co-op adds the second.
import { PlayerShip } from './player.js';
import { PlayerSwarm } from './player-swarm.js';
import { SwarmFire } from './swarm-fire.js';
import { WeaponState } from './weapons.js';
import { blendedPoint } from './swarm-blend.js';
import { cameraFocus as focusOf } from './camera.js';
import { WORLD_BOUNDS } from '../sim/layout.js';

// A swarm ship collects pickups this close (the point collects within the director's own reach).
export const SWARM_PICKUP_RADIUS = 0.2;
const NO_AIM = Object.freeze({ x: 0, y: 0 });
const NO_SWARM_HITS = Object.freeze([]);

export class PlayerSeat {
  constructor({ index = 0, random = Math.random, bounds = WORLD_BOUNDS } = {}) {
    this.index = index;
    this.player = new PlayerShip({ bounds });
    this.swarm = new PlayerSwarm({ random, bounds });
    this.swarmFire = new SwarmFire();
    this.weapons = new WeaponState({ random });
    // Reused each update: the swarm's attack-run controls (firing, unit aim).
    this.swarmControls = { firing: false, aimX: 0, aimY: 0 };
    this.firingHeld = false;
    this.bombHeld = false;
    this.down = false;
  }

  get point() {
    return this.player.position;
  }

  get aliveCount() {
    return this.swarm.aliveCount;
  }

  get centroid() {
    return this.swarm.centroid;
  }

  // What the camera frames for this seat: the point and the swarm centroid (the point alone when none is alive).
  get cameraFocus() {
    return focusOf(this.player.position, this.swarm.aliveCount > 0 ? this.swarm.centroid : null);
  }

  // True on the update the fire input rises (the level is remembered).
  firingEdge(inputState) {
    const pressed = inputState.firing && !this.firingHeld;
    this.firingHeld = inputState.firing;
    return pressed;
  }

  // True on the update the bomb input rises, as firingEdge.
  bombEdge(inputState) {
    const pressed = inputState.bomb && !this.bombHeld;
    this.bombHeld = inputState.bomb;
    return pressed;
  }

  // This seat's share of Game.state.
  hudFields() {
    const { weapons } = this;
    return {
      // The swarm size stands in for lives (the HUD's life icons).
      lives: this.swarm.aliveCount,
      armed: weapons.armed,
      tier: weapons.tier,
      charge: weapons.charge,
      railTurrets: weapons.railTurrets,
      railTier: weapons.railTier,
      playerX: this.player.position.x,
      playerY: this.player.position.y,
    };
  }

  // The renderer's swarm entry: ships and the point extrapolated by alpha, as the camera samples.
  sceneEntry(alpha, lastDeltaSeconds, pointShown) {
    const { player } = this;
    const point = blendedPoint(player.position, player.velocityX, player.velocityY, alpha, lastDeltaSeconds);
    return {
      ships: this.swarm.shipsAt(alpha),
      facing: player.facing,
      pointX: point.x,
      pointY: point.y,
      pointShown,
      armed: this.weapons.armed,
    };
  }

  // Applies the GPU's swarm hit mask: { killed, last, wiped } where wiped is true when this call
  // killed the final ship (last is then that ship).
  applyHits(stats) {
    const killed = this.swarm.applyHits(stats.swarmHitMask ?? NO_SWARM_HITS, stats.frameSequence);
    const wiped = killed.length > 0 && this.swarm.aliveCount === 0;
    return { killed, last: wiped ? killed[killed.length - 1] : null, wiped };
  }

  // Drops the weapons, puts the point back at the bounds center (or at start) and refills the swarm.
  reset(initialShips, start = null) {
    this.weapons.dropAll();
    this.player.respawn();
    if (start !== null) {
      this.player.positionX = start.x;
      this.player.positionY = start.y;
    }
    const point = this.player.position;
    this.swarm.reset(point.x, point.y, initialShips);
    this.swarmFire.reset();
    this.down = false;
  }

  // Stick or touch aim wins while it is pushed; otherwise the mouse aims from the ship to the
  // pointer. A pointer on top of the ship gives no aim, so the ship keeps its last one.
  controlsFrom(inputState) {
    let aim = inputState.aim;
    if (aim.x === 0 && aim.y === 0 && inputState.pointerWorld) {
      const offsetX = inputState.pointerWorld.x - this.player.position.x;
      const offsetY = inputState.pointerWorld.y - this.player.position.y;
      const length = Math.hypot(offsetX, offsetY);
      aim = length > this.player.radius ? { x: offsetX / length, y: offsetY / length } : NO_AIM;
    }
    return { move: inputState.move, aim, firing: inputState.firing || inputState.pointerPrimaryDown };
  }

  // Moves the point; with the beam armed the aim turns at most beamTurnRevolutionsPerSecond (0 is instant).
  steer(deltaSeconds, controls, { beamTurnRevolutionsPerSecond }) {
    const limited = this.weapons.armed === 'beam' && beamTurnRevolutionsPerSecond > 0;
    const maximumTurnRadians = limited ? beamTurnRevolutionsPerSecond * 2 * Math.PI * deltaSeconds : Infinity;
    this.player.update(deltaSeconds, controls, { maximumTurnRadians });
  }

  // Steps the swarm around the point. firing is the GATED value (playing && fire input), unlike fire's raw firing plus playing.
  flock(deltaSeconds, firing) {
    const { x, y } = this.player.position;
    const aimLength = Math.hypot(this.player.aim.x, this.player.aim.y);
    const swarmControls = this.swarmControls;
    swarmControls.firing = firing;
    swarmControls.aimX = aimLength > 0 ? this.player.aim.x / aimLength : 0;
    swarmControls.aimY = aimLength > 0 ? this.player.aim.y / aimLength : 0;
    this.swarm.update(deltaSeconds, x, y, swarmControls);
  }

  // The weapon step and the ships' shots; kind and tier are those this frame fires at (the update
  // itself drops to base on expiry).
  fire(deltaSeconds, { playing, firing }) {
    const { x, y } = this.player.position;
    const aim = this.player.aim;
    const swarmControls = this.swarmControls;
    const kind = this.weapons.armed;
    const tier = this.weapons.tier;
    const fire = this.weapons.update(deltaSeconds, { firing: playing && firing, aimX: aim.x, aimY: aim.y, x, y });
    const railTier = this.weapons.railTier;
    const shots = this.swarmFire.distribute(fire, this.swarm.ships, { x, y }, this.swarm.centroid, {
      firing: playing && firing,
      aimX: swarmControls.aimX,
      aimY: swarmControls.aimY,
      deltaSeconds,
      kind,
      tier,
    });
    return { fire, shots, kind, tier, railTier };
  }

  // A pickup at the controlled point, else at the first swarm ship close enough; null for none.
  collectPickup(pickups) {
    const { x, y } = this.player.position;
    const atPoint = pickups.collect(x, y);
    if (atPoint !== null) return atPoint;
    for (const ship of this.swarm.ships) {
      const collected = pickups.collect(ship.x, ship.y, SWARM_PICKUP_RADIUS);
      if (collected !== null) return collected;
    }
    return null;
  }
}
