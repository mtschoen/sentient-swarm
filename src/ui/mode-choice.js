// The title's mode choice: co-op (the default) or versus, chosen once player 2 has joined. The menu
// item is always laid out beside Play (menu.js modeItem); without player 2 it is ghosted and reads
// MODE: SOLO. Pad, keyboard and mouse reach it through the menu's own focus ring and confirm, which
// toggles the mode. Player 2 leaving (or a quit, or the lab, which unseat player 2) returns to co-op.
import { GameMode } from '../game/versus.js';

export const MODE_ITEM_ID = 'mode';

// The pure choice: the mode picked, honored only while player 2 is joined.
export class ModeChoice {
  constructor() {
    this.joined = false;
    this.picked = GameMode.Coop;
  }

  // Player 2 joined or not; leaving resets the pick to co-op.
  setJoined(joined) {
    this.joined = Boolean(joined);
    if (!this.joined) this.picked = GameMode.Coop;
  }

  // Flips co-op and versus; returns false (nothing changes) without player 2.
  toggle() {
    if (!this.joined) return false;
    this.picked = this.picked === GameMode.Coop ? GameMode.Versus : GameMode.Coop;
    return true;
  }

  // The mode a run started now plays.
  get mode() {
    return this.joined ? this.picked : GameMode.Coop;
  }
}

// The item's label and whether it can be chosen.
export function modeItemView(choice) {
  if (!choice.joined) return { label: 'MODE: SOLO', enabled: false };
  return { label: choice.mode === GameMode.Versus ? 'MODE: VERSUS' : 'MODE: CO-OP', enabled: true };
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
    update({ joined }) {
      if (Boolean(joined) === choice.joined) return;
      choice.setJoined(joined);
      refresh();
    },
    get mode() {
      return choice.mode;
    },
  };
}
