import { ONLINE_MODES } from '../game/versus.js';
import { WEAPON_TYPE_NAMES } from '../game/weaponTypes.js';

export const PROTOCOL_VERSION = 1;
export const Channel = Object.freeze({ State: 'state', Events: 'events' });

// Message type codes: the snapshot is 1; events use 16 and up (see event-codec.js).
export const MESSAGE_SNAPSHOT = 1;
export const FIRST_EVENT_CODE = 16;

export const WEAPON_KIND_CODES = Object.freeze(['base', ...WEAPON_TYPE_NAMES]);
export { ONLINE_MODES };

// Fixed updates between snapshots (30 per second) and between host-state blocks (10 per second).
export const SNAPSHOT_UPDATE_INTERVAL = 2;
export const HOST_STATE_UPDATE_INTERVAL = 6;

export const INTERPOLATION_DELAY_SECONDS = 0.1;
export const MAXIMUM_EXTRAPOLATION_SECONDS = 0.1;
export const DRAW_WINDOW_SECONDS = 0.2;
export const START_LEAD_SECONDS = 0.5;
export const RESUME_COUNTDOWN_SECONDS = 3;
export const CONNECT_TIMEOUT_SECONDS = 10;
export const CONNECTION_LOST_SECONDS = 10;
export const PING_INTERVAL_SECONDS = 1;
