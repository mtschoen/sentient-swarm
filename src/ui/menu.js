// Menus (title and pause): a DOM overlay with a vertical list of buttons and a visible focus ring.
// Mouse and touch click the buttons; the keyboard and gamepad drive the same list through
// handleAction(action) with the actions from src/input/menuInput.js ('up', 'down', 'confirm',
// 'altConfirm', 'back'). Focus wraps, hovering a button moves it, and show() resets it to the first
// item; Enter or Space after only hovering still means the primary item. A hidden menu ignores
// everything. The title menu (createMenu) also starts play on any tap on the arena behind the
// buttons and on a non-primary face button; Lab and Settings never start play. Callers hide the menu themselves once the run has started.
// The title menu also carries a footer link to the source repository (SOURCE_URL): a plain anchor
// that opens a new tab, outside the focus list, and following it is not a tap on the arena.
// An item may carry an id, a className and enabled: false (ghosted: aria-disabled, the menu-disabled
// class, skipped by the focus ring, its click and confirm do nothing); setItem(id, { label, enabled })
// changes one in place, so the list never gains or loses a button. The title menu's optional
// modeItem (the co-op, versus or hives choice, mode-choice.js) is such an item, second in the focus order.
export const SOURCE_URL = 'https://github.com/mtschoen/sentient-swarm';

function buildMenu({ documentObject, className, title, items, footerLink = null, onBackdrop = null, onAltConfirm = null, onBack = null }) {
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

  const enabled = items.map((item) => item.enabled !== false);
  const buttons = items.map(({ label, primary, action, className: itemClass }, index) => {
    const button = make('button', ['menu-item', primary ? 'menu-primary' : '', itemClass ?? ''].filter(Boolean).join(' '), label);
    // The menu owns the focus ring; a natively focused button would also fire on Enter or Space.
    button.setAttribute('tabindex', '-1');
    if (!enabled[index]) renderEnabled(button, false);
    button.addEventListener('click', (event) => {
      event.stopPropagation?.();
      button.blur?.();
      if (!visible || !enabled[index]) return;
      focusIndex = index;
      renderFocus();
      action();
    });
    button.addEventListener('pointerenter', () => {
      if (!enabled[index]) return;
      focusIndex = index;
      focusFromPointer = true;
      renderFocus();
    });
    list.append(button);
    return button;
  });

  if (footerLink) {
    const link = make('a', 'menu-link', footerLink.label);
    link.setAttribute('href', footerLink.url);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    link.addEventListener('click', (event) => event.stopPropagation?.());
    element.append(link);
  }

  function renderEnabled(button, on) {
    button.setAttribute('aria-disabled', on ? 'false' : 'true');
    button.classList.toggle('menu-disabled', !on);
  }

  // The next enabled index from focusIndex in direction (1 or -1), wrapping; focusIndex when none is.
  function stepFocus(direction) {
    for (let offset = 1; offset <= buttons.length; offset += 1) {
      const index = (focusIndex + direction * offset + buttons.length * offset) % buttons.length;
      if (enabled[index]) return index;
    }
    return focusIndex;
  }

  function renderFocus() {
    buttons.forEach((button, index) => button.classList.toggle('menu-focused', index === focusIndex));
  }
  renderFocus();

  // The arena behind the buttons: anything but a button or the footer link counts (their clicks are
  // stopped above).
  element.addEventListener('click', (event) => {
    if (!visible || !onBackdrop) return;
    const target = event.target;
    if (target && (target.closest ? target.closest('button, a') : target.tagName === 'BUTTON' || target.tagName === 'A')) return;
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
      if (action === 'down') focusIndex = stepFocus(1);
      else if (action === 'up') focusIndex = stepFocus(-1);
      else if (action === 'confirm' && enabled[focusIndex]) items[focusIndex].action();
      else if (action === 'altConfirm') onAltConfirm?.();
      else if (action === 'back') onBack?.();
      renderFocus();
    },
    // Relabels and enables or ghosts the item with this id; a ghosted focused item hands the focus
    // to the first item.
    setItem(id, { label, enabled: on }) {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) throw new RangeError(`no menu item ${id}`);
      if (buttons[index].textContent !== label) buttons[index].textContent = label;
      if (enabled[index] === on) return;
      enabled[index] = on;
      renderEnabled(buttons[index], on);
      if (!on && focusIndex === index) {
        focusIndex = 0;
        renderFocus();
      }
    },
  };
}

// modeItem (optional): { id, label, enabled, action } for the mode choice, placed beside Play; onlineItem (optional, the same shape, id 'online')
// is the ONLINE / DISCONNECT item after it. Play ('play') and Lab ('lab') carry ids so online-title.js can relabel and ghost them.
export function createMenu({ onStart, onLab, onSettings, modeItem = null, onlineItem = null, documentObject = document }) {
  return buildMenu({
    documentObject,
    className: 'menu-title-screen',
    title: 'SENTIENT SWARM',
    items: [
      { id: 'play', label: 'Play', primary: true, action: () => onStart() },
      ...(modeItem === null ? [] : [{ ...modeItem, className: 'menu-mode' }]),
      ...(onlineItem === null ? [] : [{ ...onlineItem, className: 'menu-online' }]),
      { id: 'lab', label: 'Lab', action: () => onLab() },
      { label: 'Settings', action: () => onSettings() },
    ],
    footerLink: { label: 'Source on GitHub', url: SOURCE_URL },
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
