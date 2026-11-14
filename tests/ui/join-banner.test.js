import test from 'node:test';
import assert from 'node:assert/strict';
import { joinBannerText, createJoinBanner } from '../../src/ui/join-banner.js';
import { SEAT_COLORS } from '../../src/game/seat-colors.js';

function fakeDocument() {
  return {
    createElement: () => {
      const element = { hidden: false, className: '', style: {}, writes: 0, appended: [], append(child) { this.appended.push(child); } };
      let text = '';
      Object.defineProperty(element, 'textContent', {
        get: () => text,
        set: (value) => { text = value; element.writes += 1; },
      });
      return element;
    },
  };
}

test('joinBannerText gives the two exact strings; the banner hides when the title closes', () => {
  assert.equal(
    joinBannerText({ joined: false }),
    'PLAYER 2: PRESS A BUTTON ON A SECOND CONTROLLER TO JOIN (WITH ONE CONTROLLER AND THE KEYBOARD: A SHOULDER BUTTON)',
  );
  assert.equal(joinBannerText({ joined: true }), 'PLAYER 2 JOINED. PRESS A SHOULDER BUTTON TO LEAVE');
  const parent = { appended: [], append(child) { this.appended.push(child); } };
  const banner = createJoinBanner(parent, { documentObject: fakeDocument() });
  assert.deepEqual(parent.appended, [banner.element]);
  assert.equal(banner.element.style.color, SEAT_COLORS[1].css);
  banner.update({ joined: false, visible: true });
  assert.equal(banner.element.hidden, false);
  assert.equal(banner.element.textContent, joinBannerText({ joined: false }));
  banner.update({ joined: true, visible: true });
  assert.equal(banner.element.textContent, joinBannerText({ joined: true }));
  banner.update({ joined: true, visible: false });
  assert.equal(banner.element.hidden, true);
});

test('the banner writes the DOM only on a change', () => {
  const parent = { append() {} };
  const banner = createJoinBanner(parent, { documentObject: fakeDocument() });
  banner.update({ joined: false, visible: true });
  banner.update({ joined: false, visible: true });
  banner.update({ joined: false, visible: true });
  assert.equal(banner.element.writes, 1);
  banner.update({ joined: true, visible: true });
  assert.equal(banner.element.writes, 2);
});
