import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasSizeFromEntry, observeCanvasSize } from '../../src/render/canvas-size.js';

test('device pixel content box wins over the content rect', () => {
  const entry = {
    devicePixelContentBoxSize: [{ inlineSize: 1921, blockSize: 1081 }],
    contentRect: { width: 960, height: 540 },
  };
  assert.deepEqual(canvasSizeFromEntry(entry, 2), { width: 1921, height: 1081 });
});

test('the content rect is scaled by the ratio and rounded when no device box exists', () => {
  const entry = { contentRect: { width: 800.4, height: 450.6 } };
  assert.deepEqual(canvasSizeFromEntry(entry, 1.5), { width: 1201, height: 676 });
});

test('the ratio defaults to 1', () => {
  assert.deepEqual(canvasSizeFromEntry({ contentRect: { width: 640, height: 360 } }), { width: 640, height: 360 });
});

test('an empty device box array falls back to the content rect', () => {
  const entry = { devicePixelContentBoxSize: [], contentRect: { width: 100, height: 50 } };
  assert.deepEqual(canvasSizeFromEntry(entry, 2), { width: 200, height: 100 });
});

// Fakes for observeCanvasSize: a ResizeObserver class that records its instance, a settable
// device pixel ratio, and matchMedia queries whose change listeners the test fires.
function createObserverFixture({ rejectDeviceBox = false, ratio = 1 } = {}) {
  const fixture = { ratio, observer: null, queries: [], sizes: [] };
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      fixture.observer = this;
    }

    observe(target, options) {
      if (rejectDeviceBox && options?.box === 'device-pixel-content-box') throw new TypeError('unsupported box');
      this.observed.push(options ?? null);
    }
  }
  const matchMediaFunction = (query) => {
    const media = new EventTarget();
    media.query = query;
    fixture.queries.push(media);
    return media;
  };
  const canvas = { clientWidth: 640, clientHeight: 360 };
  fixture.sizeNow = observeCanvasSize(canvas, (size) => fixture.sizes.push(size), {
    ResizeObserverClass: FakeResizeObserver,
    getDevicePixelRatio: () => fixture.ratio,
    matchMediaFunction,
  });
  fixture.deliver = (...entries) => fixture.observer.callback(entries);
  return fixture;
}

const deviceEntry = (width, height) => ({ devicePixelContentBoxSize: [{ inlineSize: width, blockSize: height }], contentRect: { width: 0, height: 0 } });

test('observeCanvasSize reports the initial size with the ratio and skips duplicates', () => {
  const fixture = createObserverFixture({ ratio: 2 });
  fixture.sizeNow();
  fixture.deliver(deviceEntry(1280, 720));
  assert.deepEqual(fixture.sizes, [{ width: 1280, height: 720, devicePixelRatio: 2 }]);
  assert.deepEqual(fixture.observer.observed, [{ box: 'device-pixel-content-box' }]);
});

test('observeCanvasSize ignores zero sizes and uses the last entry of a batch', () => {
  const fixture = createObserverFixture();
  fixture.deliver(deviceEntry(0, 300));
  fixture.deliver(deviceEntry(100, 0));
  assert.deepEqual(fixture.sizes, []);
  fixture.deliver(deviceEntry(10, 10), deviceEntry(800, 450));
  assert.deepEqual(fixture.sizes, [{ width: 800, height: 450, devicePixelRatio: 1 }]);
});

test('observeCanvasSize falls back to the content box when device-pixel-content-box throws', () => {
  const fixture = createObserverFixture({ rejectDeviceBox: true, ratio: 1.5 });
  assert.deepEqual(fixture.observer.observed, [null]);
  fixture.deliver({ contentRect: { width: 800, height: 450 } });
  assert.deepEqual(fixture.sizes, [{ width: 1200, height: 675, devicePixelRatio: 1.5 }]);
});

test('a pure device pixel ratio change re-reports the size and re-arms the resolution query', () => {
  const fixture = createObserverFixture({ ratio: 1 });
  fixture.deliver(deviceEntry(1280, 720));
  assert.equal(fixture.queries.length, 1);
  assert.equal(fixture.queries[0].query, '(resolution: 1dppx)');
  fixture.ratio = 1.25;
  fixture.queries[0].dispatchEvent(new Event('change'));
  assert.deepEqual(fixture.sizes.at(-1), { width: 1280, height: 720, devicePixelRatio: 1.25 });
  assert.equal(fixture.queries.length, 2);
  assert.equal(fixture.queries[1].query, '(resolution: 1.25dppx)');
  // The first query was unsubscribed, so a stale change event reports nothing new.
  fixture.queries[0].dispatchEvent(new Event('change'));
  assert.equal(fixture.sizes.length, 2);
});

test('observeCanvasSize reports a size once: an unchanged size and ratio fires nothing more', () => {
  const fixture = createObserverFixture({ ratio: 2 });
  fixture.deliver(deviceEntry(1280, 720));
  fixture.deliver(deviceEntry(1280, 720));
  fixture.sizeNow();
  assert.equal(fixture.sizes.length, 1, 'the same device size from the entry and from the initial read is one report');
  // Changing only one axis is a change.
  fixture.deliver(deviceEntry(1280, 721));
  assert.equal(fixture.sizes.length, 2);
  // A ratio change event with the ratio unchanged reports nothing.
  fixture.queries[0].dispatchEvent(new Event('change'));
  assert.equal(fixture.sizes.length, 2);
  // A ratio change before any size arrived has no size to re-report.
  const fresh = createObserverFixture({ ratio: 1 });
  fresh.ratio = 3;
  fresh.queries[0].dispatchEvent(new Event('change'));
  assert.deepEqual(fresh.sizes, []);
});

test('observeCanvasSize uses only the last entry of a batch, so a trailing empty entry reports nothing', () => {
  const fixture = createObserverFixture();
  fixture.deliver(deviceEntry(640, 360), deviceEntry(0, 0));
  assert.deepEqual(fixture.sizes, []);
  fixture.deliver(deviceEntry(0, 0), deviceEntry(640, 360));
  assert.deepEqual(fixture.sizes, [{ width: 640, height: 360, devicePixelRatio: 1 }]);
});

test('observeCanvasSize works without matchMedia and the initial read of an unsized canvas reports nothing', () => {
  const sizes = [];
  let instance = null;
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; instance = this; }
    observe() {}
  }
  const canvas = { clientWidth: 0, clientHeight: 0 };
  const sizeNow = observeCanvasSize(canvas, (size) => sizes.push(size), {
    ResizeObserverClass: FakeResizeObserver,
    getDevicePixelRatio: () => 1,
    matchMediaFunction: null,
  });
  sizeNow();
  assert.deepEqual(sizes, []);
  canvas.clientWidth = 300.4;
  canvas.clientHeight = 200;
  sizeNow();
  assert.deepEqual(sizes, [{ width: 300, height: 200, devicePixelRatio: 1 }]);
  instance.callback([deviceEntry(300, 200)]);
  assert.equal(sizes.length, 1);
});
