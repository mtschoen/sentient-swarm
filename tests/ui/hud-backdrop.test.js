import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = (name) => readFileSync(new URL(`../../src/ui/${name}`, import.meta.url), 'utf8');
const rule = (source, selector) => {
  const start = source.indexOf(`${selector} {`);
  assert.ok(start >= 0, `rule ${selector}`);
  return source.slice(start, source.indexOf('}', start));
};

test('every HUD readout, the pause and settings buttons and the mute hint sit on a dark semitransparent backdrop', () => {
  for (const [file, selector] of [['hud.css', '.hud-panel > *'], ['hud.css', '.hud-pause'], ['settings.css', '.settings-open'], ['hud.css', '#audio-hint:not(:empty)']]) {
    const body = rule(css(file), selector);
    const alpha = Number(/background:\s*rgba\(0, 0, 0, ([0-9.]+)\)/.exec(body)?.[1]);
    assert.ok(alpha >= 0.55 && alpha <= 0.8, `${selector} alpha ${alpha}`);
  }
});

test('the readout backdrop grows by box-shadow, so it moves no layout and a hidden row hides it too', () => {
  const body = rule(css('hud.css'), '.hud-panel > *');
  assert.match(body, /box-shadow: 0 0 0 3px/);
  assert.doesNotMatch(body, /padding|margin|display|position/);
});
