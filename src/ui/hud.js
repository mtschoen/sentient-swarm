// HUD: plain DOM in the letterbox bands (or along the arena top edge when the bands are narrow,
// as on a phone in landscape). Everything is pointer-events none except the game-over overlay,
// so it never steals touches from the touch sticks.
// Band text shrinks with the band so the widest content fits. Widths are each element's widest
// text at its full band font size, in CSS pixels, measured in Chromium (system-ui, weight 800)
// plus about 10 percent margin: a 7-digit grouped score at 28 px (142 measured), x10 at 54 px
// (97) and SIDEWINDERS, the longest weapon word (140; the tier numeral wraps below it), at 20 px.
export const BAND_TEXT = Object.freeze({
  score: Object.freeze({ fullSize: 28, width: 156 }),
  multiplier: Object.freeze({ fullSize: 54, width: 107 }),
  weapon: Object.freeze({ fullSize: 20, width: 154 }),
});
// hud.css .hud-panel horizontal padding, both sides.
export const BAND_PADDING_CSS_PIXELS = 16;
// Bands are used only when no band text would shrink below this; narrower bands (phones in
// landscape) use the top row. The floor is 13 px (owner ruling R8): the weapon name needs bands
// about 116 px wide, so a maximized 1080p browser (98 px bands) now uses the top row too.
export const MINIMUM_BAND_FONT_CSS_PIXELS = 13;
const TOP_OPACITY = '0.6';
const RESTART_GUARD_MILLISECONDS = 700;
const ROMAN = ['', 'I', 'II', 'III'];
const LIFE_ICON = '▲';
const BOMB_ICON = '●';

// Font sizes (CSS px) that fit each band element's widest text into a band of this width.
export function bandFontSizes(bandWidth) {
  const contentWidth = Math.max(0, bandWidth - BAND_PADDING_CSS_PIXELS);
  const sizes = {};
  for (const [name, { fullSize, width }] of Object.entries(BAND_TEXT)) {
    sizes[name] = Math.min(fullSize, (fullSize * contentWidth) / width);
  }
  return sizes;
}

const groupDigits = (value) => Math.round(value).toLocaleString('en-US');

function weaponText(armed, tier) {
  if (!armed || armed === 'base') return 'BASE';
  return `${armed.toUpperCase()} ${ROMAN[tier] ?? tier}`;
}

const PAUSE_BUTTON_SIZE_CSS_PIXELS = 34;
// Phases in which the pause button shows (pausing a Ready or GameOver screen means nothing).
const PAUSABLE_PHASES = new Set(['playing', 'dying', 'respawning']);

// onPause: the pause button's click (main.js asks the game to pause and opens the pause menu).
export function createHud(rootElement, {
  documentObject = document,
  now = () => performance.now(),
  onPause = null,
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
  // The panels are display-only: a thumb that lands on one must not start a touch stick (touch.js
  // skips touches inside data-touch-exclusive rectangles). Their rectangles are just the content.
  for (const panel of [leftPanel, rightPanel]) panel.setAttribute('data-touch-exclusive', '');
  // The settings button (bottom left, reachable on a phone) and the short gamepad toast.
  const settingsButton = make('button', 'settings-open', 'Settings');
  settingsButton.setAttribute('data-touch-exclusive', '');
  settingsButton.setAttribute('aria-label', 'Settings');
  const toast = make('div', 'hud-toast');
  
  // Top centre of the arena, clear of both panels' text; excluded from touch sticks like the panels.
  const pauseButton = make('button', 'hud-pause', 'II');
  pauseButton.setAttribute('aria-label', 'Pause');
  pauseButton.setAttribute('data-touch-exclusive', '');
  pauseButton.hidden = true;
  pauseButton.addEventListener('click', () => onPause?.());
  
  rootElement.append(leftPanel, rightPanel, settingsButton, pauseButton, toast, gameOver);

  // Skip DOM writes for unchanged text: update runs every rendered frame.
  const lastText = new Map();
  const setText = (element, text) => {
    if (lastText.get(element) === text) return;
    lastText.set(element, text);
    element.textContent = text;
  };

  let restartHandler = null;
  let shownAt = 0;
  // Idempotent per game over: a touch tap sends pointerdown and then click, and only the first
  // may restart.
  const restart = () => {
    const handler = restartHandler;
    restartHandler = null;
    handler?.();
  };
  playAgain.addEventListener('click', restart);
  // A touch tap anywhere restarts, but not from the touch that ended the run.
  gameOver.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch') return;
    if (now() - shownAt < RESTART_GUARD_MILLISECONDS) return;
    restart();
  });

  return {
    settingsButton,
    // A short message at the top center; hud.css fades it out (no timer needed).
    showToast(text) {
      toast.textContent = text;
      toast.classList.remove('hud-toast-show');
      void toast.offsetWidth;
      toast.classList.add('hud-toast-show');
    },

    update(state) {
      setText(score, groupDigits(state.score ?? 0));
      setText(multiplier, `x${state.multiplier ?? 1}`);
      pauseButton.hidden = !PAUSABLE_PHASES.has(state.phase);
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
      const fontSizes = bandFontSizes(Math.min(leftWidth, rightWidth));
      const bands = Object.values(fontSizes).every((size) => size >= MINIMUM_BAND_FONT_CSS_PIXELS);
      const mode = bands ? 'bands' : 'top';
      pauseButton.style.left = `${arenaRect.x + arenaRect.width / 2 - PAUSE_BUTTON_SIZE_CSS_PIXELS / 2}px`;
      pauseButton.style.top = `${arenaRect.y + 4}px`;
      for (const panel of [leftPanel, rightPanel]) {
        panel.classList.remove('hud-bands');
        panel.classList.remove('hud-top');
        panel.classList.add(bands ? 'hud-bands' : 'hud-top');
        panel.style.opacity = bands ? '1' : TOP_OPACITY;
        panel.style.top = `${arenaRect.y}px`;
        // Read by hud.css in band mode; both panels share the narrower band's sizes.
        for (const [name, size] of Object.entries(fontSizes)) panel.style.setProperty(`--hud-${name}-size`, `${size.toFixed(1)}px`);
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
