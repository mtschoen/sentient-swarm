// HUD: plain DOM in the letterbox bands (or along the arena top edge when the bands are narrow,
// as on a phone in landscape). Everything is pointer-events none except the game-over overlay,
// so it never steals touches from the touch sticks.
const MINIMUM_BAND_CSS_PIXELS = 80;
const TOP_OPACITY = '0.6';
const RESTART_GUARD_MILLISECONDS = 700;
const ROMAN = ['', 'I', 'II', 'III'];
const LIFE_ICON = '▲';
const BOMB_ICON = '●';

const groupDigits = (value) => Math.round(value).toLocaleString('en-US');

function weaponText(armed, tier) {
  if (!armed || armed === 'base') return 'BASE';
  return `${armed.toUpperCase()} ${ROMAN[tier] ?? tier}`;
}

export function createHud(rootElement, {
  documentObject = document,
  now = () => performance.now(),
} = {}) {
  const make = (tagName, className, textContent = '') => {
    const created = documentObject.createElement(tagName);
    for (const name of className.split(' ')) created.classList.add(name);
    created.textContent = textContent;
    return created;
  };
  const row = (className, children) => {
    const created = make('div', className);
    created.append(...children);
    return created;
  };

  const score = make('div', 'hud-score', '0');
  const multiplier = make('div', 'hud-multiplier', 'x1');
  const weapon = make('div', 'hud-weapon', 'BASE');
  const chargeFill = make('div', 'hud-charge-fill');
  const charge = row('hud-charge', [chargeFill]);
  const offer = make('div', 'hud-offer');
  const lives = make('div', 'hud-lives');
  const bombs = make('div', 'hud-bombs');
  const leftPanel = row('hud-panel hud-left', [score, multiplier]);
  const rightPanel = row('hud-panel hud-right', [weapon, charge, offer, row('hud-icons', [lives, bombs])]);

  const finalScore = make('div', 'hud-final-score');
  const playAgain = make('button', 'hud-play-again', 'Play again');
  const gameOver = row('hud-gameover', [make('div', 'hud-gameover-title', 'GAME OVER'), finalScore, playAgain]);
  gameOver.hidden = true;
  rootElement.append(leftPanel, rightPanel, gameOver);

  // Skip DOM writes for unchanged text: update runs every rendered frame.
  const lastText = new Map();
  const setText = (element, text) => {
    if (lastText.get(element) === text) return;
    lastText.set(element, text);
    element.textContent = text;
  };

  let restartHandler = null;
  let shownAt = 0;
  const restart = () => restartHandler?.();
  playAgain.addEventListener('click', restart);
  // A touch tap anywhere restarts, but not from the touch that ended the run.
  gameOver.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch') return;
    if (now() - shownAt < RESTART_GUARD_MILLISECONDS) return;
    restart();
  });

  return {
    update(state) {
      setText(score, groupDigits(state.score ?? 0));
      setText(multiplier, `x${state.multiplier ?? 1}`);
      setText(weapon, weaponText(state.armed, state.tier));
      setText(lives, LIFE_ICON.repeat(Math.max(0, state.lives ?? 0)));
      setText(bombs, BOMB_ICON.repeat(Math.max(0, state.bombs ?? 0)));
      setText(offer, state.offeredType ? `NEXT ${String(state.offeredType).toUpperCase()}` : '');
      const armedNow = state.armed && state.armed !== 'base';
      charge.style.visibility = armedNow ? 'visible' : 'hidden';
      chargeFill.style.width = `${Math.round(Math.min(1, Math.max(0, state.charge ?? 0)) * 100)}%`;
    },

    showGameOver(finalPoints, onRestart) {
      restartHandler = onRestart;
      shownAt = now();
      setText(finalScore, groupDigits(finalPoints));
      gameOver.hidden = false;
    },

    hideGameOver() {
      gameOver.hidden = true;
      restartHandler = null;
    },

    // Rectangles are in CSS pixels. Returns 'bands' or 'top'.
    layout(arenaRect, viewportSize) {
      const leftWidth = arenaRect.x;
      const rightWidth = viewportSize.width - arenaRect.x - arenaRect.width;
      const bands = Math.min(leftWidth, rightWidth) >= MINIMUM_BAND_CSS_PIXELS;
      const mode = bands ? 'bands' : 'top';
      for (const panel of [leftPanel, rightPanel]) {
        panel.classList.remove('hud-bands');
        panel.classList.remove('hud-top');
        panel.classList.add(bands ? 'hud-bands' : 'hud-top');
        panel.style.opacity = bands ? '1' : TOP_OPACITY;
        panel.style.top = `${arenaRect.y}px`;
      }
      if (bands) {
        leftPanel.style.left = '0px';
        leftPanel.style.width = `${leftWidth}px`;
        rightPanel.style.left = `${arenaRect.x + arenaRect.width}px`;
        rightPanel.style.width = `${rightWidth}px`;
      } else {
        leftPanel.style.left = `${arenaRect.x}px`;
        leftPanel.style.width = `${arenaRect.width / 2}px`;
        rightPanel.style.left = `${arenaRect.x + arenaRect.width / 2}px`;
        rightPanel.style.width = `${arenaRect.width / 2}px`;
      }
      return mode;
    },
  };
}
