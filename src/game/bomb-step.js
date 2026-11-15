// The bomb presses of one update, taking the Game as context like versus-seats.js: a rising bomb
// edge of a seat that is not down spends the shared pool (RunState.useBomb) and clears around the
// seat's swarm out past the view's corners (bombRadiusForView), not the whole world. Online
// (game.online) the press goes to OnlineGame.pressBomb instead: the host keeps the one pool.
import { bombRadiusForView } from './camera.js';
import { SOLO_ZOOM_BOMB_HOLD_SECONDS } from './solo-zoom-step.js';

// inputs: each seat's input state this update (every seat's bomb edge is read, pressed or not).
export function pressBombs(game, inputs) {
  game.seats.forEach((seat, index) => {
    const pressed = seat.bombEdge(inputs[index]);
    if (!pressed || seat.down) return;
    if (game.online) {
      game.online.pressBomb(game, seat);
      return;
    }
    if (!game.run.useBomb(seat.point)) return;
    game.bombHoldRemaining = SOLO_ZOOM_BOMB_HOLD_SECONDS;
    const center = seat.aliveCount > 0 ? seat.centroid : seat.point;
    game.simulation.requestRadialKill(center.x, center.y, bombRadiusForView(game.viewSize.width, game.viewSize.height));
    game.effects?.bomb(...(game.seats.length > 1 ? [seat.index] : []));
  });
}
