// Gamepad rumble (owner ruling R16, a PS5 DualSense). Effects are fire and forget through
// gamepad.vibrationActuator, feature detected: 'trigger-rumble' is tried first when the actuator
// lists it (falling back to 'dual-rumble' if it rejects), else 'dual-rumble'; nothing happens
// when no connected pad has an actuator or the setting is off.
const DUAL_RUMBLE = 'dual-rumble';
const TRIGGER_RUMBLE = 'trigger-rumble';

// strong drives the heavy motor, weak the light one (both 0 to 1).
export const RUMBLE_PATTERNS = Object.freeze({
  bomb: Object.freeze({ duration: 250, strong: 1, weak: 0.6 }),
  death: Object.freeze({ duration: 400, strong: 1, weak: 0.8 }),
  pickup: Object.freeze({ duration: 80, strong: 0.2, weak: 0.5 }),
  extraLife: Object.freeze({ duration: 160, strong: 0.4, weak: 0.7 }),
});

function supports(actuator, type) {
  if (Array.isArray(actuator.effects)) return actuator.effects.includes(type);
  return actuator.type === type;
}

function findActuator(navigatorObject) {
  const gamepads = navigatorObject.getGamepads?.() ?? [];
  for (const gamepad of gamepads) {
    const actuator = gamepad?.vibrationActuator;
    if (actuator && typeof actuator.playEffect === 'function') return actuator;
  }
  return null;
}

function play(actuator, { duration, strong, weak }) {
  const common = { startDelay: 0, duration, weakMagnitude: weak, strongMagnitude: strong };
  const dual = () => (supports(actuator, DUAL_RUMBLE) ? actuator.playEffect(DUAL_RUMBLE, common) : undefined);
  if (supports(actuator, TRIGGER_RUMBLE)) {
    Promise.resolve(actuator.playEffect(TRIGGER_RUMBLE, { ...common, leftTrigger: strong, rightTrigger: strong }))
      .catch(() => dual())
      .catch(() => {});
    return;
  }
  Promise.resolve(dual()).catch(() => {});
}

export function createRumble({ navigatorObject = typeof navigator === 'undefined' ? {} : navigator, isEnabled = () => true } = {}) {
  const fire = (name) => () => {
    if (!isEnabled()) return;
    const actuator = findActuator(navigatorObject);
    if (actuator) play(actuator, RUMBLE_PATTERNS[name]);
  };
  return { bomb: fire('bomb'), death: fire('death'), pickup: fire('pickup'), extraLife: fire('extraLife') };
}

// The game has no extra-life cue, so a rise in lives while playing (not a restart, which resets
// them from a different phase) is detected from the game state each rendered frame.
export function createLifeWatcher(rumble) {
  let previous = null;
  return {
    update({ phase, lives }) {
      if (phase === 'playing' && previous?.phase === 'playing' && lives > previous.lives) rumble.extraLife();
      previous = { phase, lives };
    },
  };
}
