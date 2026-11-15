// The title's mode choice: co-op (the default), versus or hives, chosen once player 2 has joined. The menu
// item is always laid out beside Play (menu.js modeItem); without player 2 it is ghosted and reads
// MODE: SOLO. Pad, keyboard and mouse reach it through the menu's own focus ring and confirm, which
// steps the mode through MODE_CYCLE (co-op, versus, hives, then co-op again). Player 2 leaving (or a quit, or the lab, which unseat player 2) returns to co-op.
import { GameMode, ONLINE_MODES } from '../game/versus.js';

export const MODE_ITEM_ID = 'mode';
export const MODE_CYCLE = Object.freeze([GameMode.Coop, GameMode.Versus, GameMode.Hives]);
// Online (a host and a guest on two machines) cycles hives and versus only; the guest sees the host's pick read-only.
export const ONLINE_MODE_CYCLE = ONLINE_MODES;
const MODE_LABELS = Object.freeze({ [GameMode.Coop]: 'MODE: CO-OP', [GameMode.Versus]: 'MODE: VERSUS', [GameMode.Hives]: 'MODE: HIVES' });

// The pure choice: the mode picked, honored only while player 2 is joined.
export class ModeChoice {
  constructor() {
    this.joined = false;
    this.picked = GameMode.Coop;
    this.role = null;
    this.remoteMode = ONLINE_MODE_CYCLE[0];
  }

  // The online role: 'host' (starts on hives, toggles hives and versus), 'guest' (read-only, shows
  // the host's mode) or null (the couch choice: co-op, SOLO until player 2 joins).
  setOnline(role) {
    this.role = role ?? null;
    this.picked = this.role === 'host' ? ONLINE_MODE_CYCLE[0] : GameMode.Coop;
    this.remoteMode = ONLINE_MODE_CYCLE[0];
  }

  // The guest's view of the host's mode.
  setRemoteMode(mode) {
    this.remoteMode = mode;
  }

  // Player 2 joined or not; leaving resets the pick to co-op.
  setJoined(joined) {
    this.joined = Boolean(joined);
    if (!this.joined) this.picked = GameMode.Coop;
  }

  // Steps to the next mode of MODE_CYCLE; returns false (nothing changes) without player 2.
  toggle() {
    if (this.role === 'guest') return false;
    if (this.role === 'host') {
      this.picked = ONLINE_MODE_CYCLE[(ONLINE_MODE_CYCLE.indexOf(this.picked) + 1) % ONLINE_MODE_CYCLE.length];
      return true;
    }
    if (!this.joined) return false;
    this.picked = MODE_CYCLE[(MODE_CYCLE.indexOf(this.picked) + 1) % MODE_CYCLE.length];
    return true;
  }

  // The mode a run started now plays.
  get mode() {
    if (this.role === 'guest') return this.remoteMode;
    if (this.role === 'host') return this.picked;
    return this.joined ? this.picked : GameMode.Coop;
  }
}

// The item's label and whether it can be chosen.
export function modeItemView(choice) {
  if (choice.role !== null) return { label: MODE_LABELS[choice.mode], enabled: choice.role === 'host' };
  if (!choice.joined) return { label: 'MODE: SOLO', enabled: false };
  return { label: MODE_LABELS[choice.mode], enabled: true };
}

// The choice plus its menu item: pass menuItem to createMenu, then attach the menu; update each
// frame with whether player 2 is joined.
export function createModeControl() {
  const choice = new ModeChoice();
  let menu = null;
  const refresh = () => menu?.setItem(MODE_ITEM_ID, modeItemView(choice));
  return {
    choice,
    menuItem: {
      id: MODE_ITEM_ID,
      ...modeItemView(choice),
      action: () => {
        if (choice.toggle()) refresh();
      },
    },
    attach(attachedMenu) {
      menu = attachedMenu;
      refresh();
    },
    // The online role (see ModeChoice.setOnline); while it holds one, update() leaves the choice alone.
    setOnline(role) {
      choice.setOnline(role);
      refresh();
    },
    setRemoteMode(mode) {
      choice.setRemoteMode(mode);
      refresh();
    },
    update({ joined }) {
      if (choice.role !== null) return;
      if (Boolean(joined) === choice.joined) return;
      choice.setJoined(joined);
      refresh();
    },
    get mode() {
      return choice.mode;
    },
  };
}
