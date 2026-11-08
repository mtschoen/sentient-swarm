// Rotate overlay: on a phone held in portrait the game shows this full-screen message and nothing
// else (the main loop also pauses the run while it shows and resumes it when the phone turns back).
// The landscape lock is attempted once, on the first update of a mobile device; browsers usually
// refuse outside fullscreen, and the rejection (or a missing API) is ignored on purpose.
export function createRotateOverlay({
  screenObject = globalThis.screen,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  isMobile,
  documentObject = document,
}) {
  const element = documentObject.createElement('div');
  element.classList.add('rotate-overlay');
  element.setAttribute('role', 'alert');
  const message = documentObject.createElement('div');
  message.classList.add('rotate-overlay-message');
  message.textContent = 'Rotate your device to landscape';
  element.append(message);
  element.hidden = true;

  let lockAttempted = false;
  function attemptLandscapeLock() {
    if (lockAttempted) return;
    lockAttempted = true;
    try {
      Promise.resolve(screenObject?.orientation?.lock?.('landscape')).catch(() => {});
    } catch {
      // A synchronous throw is the same refusal.
    }
  }

  // Returns true while the overlay is showing (mobile and portrait).
  function update() {
    if (isMobile) attemptLandscapeLock();
    const portrait = Boolean(matchMedia?.('(orientation: portrait)').matches);
    const showing = Boolean(isMobile) && portrait;
    if (element.hidden === showing) element.hidden = !showing;
    return showing;
  }

  return { element, update };
}
