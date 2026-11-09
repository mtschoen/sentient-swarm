// Fullscreen for the run (phones): the page goes fullscreen inside the gesture that starts, resumes
// or restarts a run, which hides the browser's URL bar and the system bars, and leaves it when the
// title menu shows. Entering needs a user activation, so enter() is called from those handlers and
// a refusal (no activation, no API as on iPhone Safari, a policy) is ignored on purpose; exit()
// needs none. Once fullscreen, the landscape lock that browsers refuse outside it is asked for
// again (it ends with fullscreen). When the player leaves fullscreen some other way (the back
// gesture, a system swipe), onExternalExit runs so the caller can pause the run.
export function createFullscreenController({
  enabled,
  documentObject = globalThis.document,
  screenObject = globalThis.screen,
  onExternalExit = () => {},
}) {
  const element = documentObject?.documentElement;
  const supported = Boolean(enabled) && typeof element?.requestFullscreen === 'function';
  let wasActive = false;
  let exitRequested = false;

  const isActive = () => Boolean(documentObject.fullscreenElement);

  // Runs fn and swallows a synchronous throw or a rejection: both are the same refusal.
  function attempt(fn) {
    try {
      return Promise.resolve(fn()).then(() => true, () => false);
    } catch {
      return Promise.resolve(false);
    }
  }

  if (supported) {
    documentObject.addEventListener('fullscreenchange', () => {
      if (isActive()) {
        wasActive = true;
        return;
      }
      const external = wasActive && !exitRequested;
      wasActive = false;
      exitRequested = false;
      if (external) onExternalExit();
    });
  }

  return {
    get supported() { return supported; },
    get active() { return supported && isActive(); },
    // Call inside a user gesture's handler. Resolves true when the page is fullscreen.
    enter() {
      if (!supported) return Promise.resolve(false);
      if (isActive()) return Promise.resolve(true);
      exitRequested = false;
      return attempt(() => element.requestFullscreen({ navigationUI: 'hide' })).then((entered) => {
        if (entered) attempt(() => screenObject?.orientation?.lock?.('landscape'));
        return entered;
      });
    },
    // Safe to call every frame: does nothing unless the page is fullscreen.
    exit() {
      if (!supported || !isActive() || exitRequested) return;
      exitRequested = true;
      attempt(() => documentObject.exitFullscreen()).then((left) => {
        if (!left) exitRequested = false;
      });
    },
  };
}
