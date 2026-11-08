// Menus (title and pause): a DOM overlay with a vertical list of buttons and a visible focus ring.
// Mouse and touch click the buttons; the keyboard and gamepad drive the same list through
// handleAction(action) with the actions from src/input/menuInput.js ('up', 'down', 'confirm',
// 'altConfirm', 'back'). Focus wraps, hovering a button moves it, and show() resets it to the first
// item; Enter or Space after only hovering still means the primary item. A hidden menu ignores
// everything. The title menu (createMenu) also starts play on any tap on the arena behind the
// buttons and on a non-primary face button; Lab and Settings never start play. Callers hide the menu themselves once the run has started.
function buildMenu({ documentObject, className, title, items, onBackdrop = null, onAltConfirm = null, onBack = null }) {
  const make = (tagName, classNames, textContent = '') => {
    const created = documentObject.createElement(tagName);
    for (const name of classNames.split(' ')) created.classList.add(name);
    created.textContent = textContent;
    return created;
  };
  const element = make('div', `menu ${className}`);
  element.setAttribute('role', 'dialog');
  element.append(make('div', 'menu-title', title));
  const list = make('div', 'menu-list');
  element.append(list);
  let focusIndex = 0;
  // Focus follows the pointer, but the keyboard and gamepad confirm means the primary item until
  // they move.
  let focusFromPointer = false;
  let visible = true;

  const buttons = items.map(({ label, primary, action }, index) => {
    const button = make('button', primary ? 'menu-item menu-primary' : 'menu-item', label);
    // The menu owns the focus ring; a natively focused button would also fire on Enter or Space.
    button.setAttribute('tabindex', '-1');
    button.addEventListener('click', (event) => {
      event.stopPropagation?.();
      button.blur?.();
      if (!visible) return;
      focusIndex = index;
      renderFocus();
      action();
    });
    button.addEventListener('pointerenter', () => {
      focusIndex = index;
      focusFromPointer = true;
      renderFocus();
    });
    list.append(button);
    return button;
  });

  function renderFocus() {
    buttons.forEach((button, index) => button.classList.toggle('menu-focused', index === focusIndex));
  }
  renderFocus();

  // The arena behind the buttons: anything but a button counts (a button click is stopped above).
  element.addEventListener('click', (event) => {
    if (!visible || !onBackdrop) return;
    const target = event.target;
    if (target && (target.closest ? target.closest('button') : target.tagName === 'BUTTON')) return;
    onBackdrop();
  });

  return {
    element,
    get visible() { return visible; },
    show() {
      visible = true;
      element.hidden = false;
      focusIndex = 0;
      focusFromPointer = false;
      renderFocus();
    },
    hide() {
      visible = false;
      element.hidden = true;
    },
    handleAction(action) {
      if (!visible) return;
      if (focusFromPointer && action === 'confirm') {
        focusFromPointer = false;
        const primaryIndex = items.findIndex((item) => item.primary);
        if (primaryIndex >= 0) focusIndex = primaryIndex;
      }
      if (action === 'down' || action === 'up') focusFromPointer = false;
      if (action === 'down') focusIndex = (focusIndex + 1) % buttons.length;
      else if (action === 'up') focusIndex = (focusIndex + buttons.length - 1) % buttons.length;
      else if (action === 'confirm') items[focusIndex].action();
      else if (action === 'altConfirm') onAltConfirm?.();
      else if (action === 'back') onBack?.();
      renderFocus();
    },
  };
}

export function createMenu({ onStart, onLab, onSettings, documentObject = document }) {
  return buildMenu({
    documentObject,
    className: 'menu-title-screen',
    title: 'SENTIENT SWARM',
    items: [
      { label: 'Play', primary: true, action: () => onStart() },
      { label: 'Lab', action: () => onLab() },
      { label: 'Settings', action: () => onSettings() },
    ],
    onBackdrop: () => onStart(),
    onAltConfirm: () => onStart(),
  });
}

export function createPauseMenu({ onResume, onSettings, onRestart, onQuit, documentObject = document }) {
  return buildMenu({
    documentObject,
    className: 'menu-pause',
    title: 'PAUSED',
    items: [
      { label: 'Resume', primary: true, action: () => onResume() },
      { label: 'Settings', action: () => onSettings() },
      { label: 'Restart run', action: () => onRestart() },
      { label: 'Quit to title', action: () => onQuit() },
    ],
    onBack: () => onResume(),
  });
}
