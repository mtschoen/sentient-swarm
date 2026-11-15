// The online resume countdown: one fixed numeral (3, 2, 1) centered over the arena, never taking a
// touch, always laid out and shown or hidden by visibility (the resume-countdown-hidden class), so
// nothing around it moves. The styles live in online.css.

export function createResumeCountdown(parent, { documentObject = document } = {}) {
  const element = documentObject.createElement('div');
  element.classList.add('resume-countdown');
  element.classList.add('resume-countdown-hidden');
  element.setAttribute('aria-live', 'assertive');
  element.textContent = '';
  parent.append(element);
  let number = null;
  return {
    element,
    get number() { return number; },
    show(next) {
      number = next;
      element.textContent = String(next);
      element.classList.toggle('resume-countdown-hidden', false);
    },
    hide() {
      number = null;
      element.classList.toggle('resume-countdown-hidden', true);
    },
  };
}
