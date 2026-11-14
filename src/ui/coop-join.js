// Ties press-to-join to the page: polls SeatJoin at the title, seats the pad in the input and menus,
// toasts, and keeps the banner current.
import { SeatJoin } from '../input/seat-join.js';
import { createJoinBanner } from './join-banner.js';

export function createCoopJoin({ input, menuInput, hud, menuElement, navigatorObject = navigator, documentObject = document }) {
  const seatJoin = new SeatJoin();
  const banner = createJoinBanner(menuElement, { documentObject });
  const gamepads = () => Array.from(navigatorObject.getGamepads?.() ?? []);

  function seatPad(padIndex) {
    input.setSeatTwoPad(padIndex);
    menuInput.setExtraPad(padIndex);
  }

  return {
    update({ titleOpen }) {
      const outcome = seatJoin.poll(gamepads(), { open: titleOpen });
      if (outcome === 'joined') {
        seatPad(seatJoin.seatTwoPad);
        hud.showToast('Player 2 joined');
      } else if (outcome === 'left') {
        seatPad(null);
        hud.showToast('Player 2 left');
      }
      banner.update({ joined: seatJoin.joined, visible: titleOpen });
    },
    get playerCount() {
      return seatJoin.joined ? 2 : 1;
    },
    reset() {
      seatJoin.reset();
      seatPad(null);
      banner.update({ joined: false, visible: false });
    },
    padForSeat(seat) {
      if (seat === 1) return seatJoin.seatTwoPad ?? undefined;
      return seatJoin.joined ? input.seatOnePadIndex() : undefined;
    },
    handleDisconnect(padIndex) {
      return seatJoin.joined && padIndex === seatJoin.seatTwoPad;
    },
    handleConnect(padIndex) {
      const reconnected = seatJoin.reconnect(padIndex, gamepads());
      if (reconnected) seatPad(padIndex);
      return reconnected;
    },
  };
}
