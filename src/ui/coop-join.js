// Ties press-to-join to the page: polls SeatJoin at the title, seats the pad in the input and menus,
// toasts, and keeps the banner and the per-seat controller status rows current.
import { SeatJoin } from '../input/seat-join.js';
import { createJoinBanner } from './join-banner.js';
import { createPadStatus } from './pad-status.js';

// sparring (?debug=sparring): seat 2 is a virtual seat, joined from the start and driven by no device.
export function createCoopJoin({ input, menuInput, hud, menuElement, navigatorObject = navigator, documentObject = document, sparring = false }) {
  const seatJoin = new SeatJoin();
  const banner = createJoinBanner(menuElement, { documentObject });
  const padStatus = createPadStatus(menuElement, { documentObject });
  let titleWasOpen = false;
  const gamepads = () => Array.from(navigatorObject.getGamepads?.() ?? []);

  function seatPad(padIndex) {
    input.setSeatTwoPad(padIndex);
    menuInput.setExtraPad(padIndex);
  }

  if (sparring) {
    seatJoin.seatVirtual();
    seatPad(seatJoin.seatTwoPad);
  }

  return {
    update({ titleOpen }) {
      titleWasOpen = titleOpen;
      const outcome = seatJoin.poll(gamepads(), { open: titleOpen });
      if (outcome === 'joined') {
        seatPad(seatJoin.seatTwoPad);
        hud.showToast('Player 2 joined');
      } else if (outcome === 'left') {
        seatPad(null);
        hud.showToast('Player 2 left');
      }
      banner.update({ joined: seatJoin.joined, visible: titleOpen, sparring });
      padStatus.update({ pads: gamepads(), seatTwoPad: seatJoin.joined ? seatJoin.seatTwoPad : null, visible: titleOpen, sparring });
    },
    get playerCount() {
      return seatJoin.joined ? 2 : 1;
    },
    reset() {
      seatJoin.reset();
      seatPad(seatJoin.seatTwoPad);
      banner.update({ joined: seatJoin.joined, visible: false, sparring });
    },
    padForSeat(seat) {
      if (seat === 1) return seatJoin.virtual ? null : seatJoin.seatTwoPad ?? undefined;
      return seatJoin.joined ? input.seatOnePadIndex() : undefined;
    },
    // True when seat 2's pad left mid-run (the page pauses and toasts). At the title it unseats seat 2 instead.
    handleDisconnect(padIndex) {
      if (seatJoin.virtual || !(seatJoin.joined && padIndex === seatJoin.seatTwoPad)) return false;
      if (!titleWasOpen) return true;
      seatJoin.reset();
      seatPad(null);
      banner.update({ joined: false, visible: true });
      return false;
    },
    handleConnect(padIndex) {
      const reconnected = seatJoin.reconnect(padIndex, gamepads());
      const sameIndex = seatJoin.joined && padIndex === seatJoin.seatTwoPad;
      // Seating primes the menu input, so a pad that wakes with a button down never confirms.
      if (reconnected || sameIndex) seatPad(padIndex);
      return reconnected || sameIndex;
    },
  };
}
