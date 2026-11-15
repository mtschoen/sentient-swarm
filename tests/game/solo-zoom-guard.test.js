import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { SOLO_ZOOM_DEFAULTS, SoloZoomController } from '../../src/game/solo-zoom.js';
import { createGame } from './game-harness.js';

const SOURCE_DIRECTORY = new URL('../../src/', import.meta.url);

function sourceFiles(directory = SOURCE_DIRECTORY, prefix = 'src/') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`);
    return entry.name.endsWith('.js') ? [{ path: `${prefix}${entry.name}`, url: new URL(entry.name, directory) }] : [];
  });
}

function filesContaining(text) {
  return sourceFiles().filter(({ url }) => readFileSync(url, 'utf8').includes(text)).map(({ path }) => path);
}

// The lab owns the solo zoom knobs: src/ui/lab*.js, labPresets.js (the mix ranges), labPanel.js and panelModel.js.
const LAB_FILE = /^src\/ui\/(lab[A-Za-z]*|panelModel)\.js$/;

// Only the lab changes the solo zoom settings (and reduced motion, through setReducedMotion), so shipped play keeps the defaults pinned below.
test('setSoloZoomSetting is called only from the lab files (the Game defines it)', () => {
  const callers = filesContaining('setSoloZoomSetting').filter((path) => path !== 'src/game/game.js' && !LAB_FILE.test(path));
  assert.deepEqual(callers, []);
  assert.ok(filesContaining('setSoloZoomSetting').includes('src/game/game.js'), 'the Game still defines it');
});

test('soloZoom.set is called only by the Game (its one delegate)', () => {
  assert.deepEqual(filesContaining('soloZoom.set(').sort(), ['src/game/game.js']);
});

test('nothing outside the lab files sets enabled on the solo zoom', () => {
  const spellings = ["'enabled', true", '"enabled", true', "'enabled', false", '"enabled", false'];
  const offenders = sourceFiles()
    .filter(({ path, url }) => !LAB_FILE.test(path) && spellings.some((spelling) => readFileSync(url, 'utf8').includes(spelling)))
    .map(({ path }) => path);
  assert.deepEqual(offenders, []);
});

test('the shipped solo zoom defaults are on at the strongest settings', () => {
  assert.deepEqual({ ...SOLO_ZOOM_DEFAULTS }, {
    enabled: true,
    minimum: 0.5,
    maximum: 2.5,
    punchIn: 1,
    pullOut: 1,
    smoothSeconds: 0.2,
    rateLimit: 2,
    crowdReference: 0.25,
    fitFraction: 1.25,
  });
});

test('a fresh controller and a fresh Game boot with the shipped defaults', async () => {
  assert.deepEqual(new SoloZoomController().settings, { ...SOLO_ZOOM_DEFAULTS });
  const { game } = await createGame();
  assert.deepEqual(game.soloZoom.settings, { ...SOLO_ZOOM_DEFAULTS });
  assert.equal(game.reducedMotion, false);
});
