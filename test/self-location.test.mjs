// Phase 36 (req #7a): the blue self-dot tracks the shared watch's latest fix.
//
// The dot + accuracy ring are created on the first fix and MOVED (not recreated)
// on every later one. Uses a fake google.maps + a fake watch so no real Maps or
// GPS is needed.
import test from "node:test";
import assert from "node:assert/strict";

// A tiny fake watch matching GeoWatch's subscribe(onFix, onErr, {replayLast}) API.
function fakeWatch() {
  let sub = null, replay = false;
  return {
    lastFix: null,
    subscribe(onFix, onErr, opts = {}) { sub = onFix; replay = !!opts.replayLast; if (replay && this.lastFix) onFix(this.lastFix); return () => { sub = null; }; },
    fire(fix) { this.lastFix = fix; sub?.(fix); },
    get subscribed() { return sub != null; },
    get askedReplay() { return replay; },
  };
}

class FakeMarker {
  constructor(opts) { this.opts = opts; this.position = opts.position; this.map = opts.map; }
  setPosition(p) { this.position = p; }
  setMap(m) { this.map = m; }
}
class FakeCircle {
  constructor(opts) { this.opts = opts; this.center = opts.center; this.radius = opts.radius; this.map = opts.map; }
  setCenter(c) { this.center = c; }
  setRadius(r) { this.radius = r; }
  setMap(m) { this.map = m; }
}
globalThis.window = Object.assign(globalThis.window || {}, {
  google: { maps: { Marker: FakeMarker, Circle: FakeCircle, SymbolPath: { CIRCLE: 0 } } },
});
globalThis.google = globalThis.window.google;

const { SelfLocation } = await import("../src/self-location.js");

test("self 1: init subscribes with replayLast so a cached fix draws at once", () => {
  const watch = fakeWatch();
  watch.lastFix = { lat: 19.1, lng: 72.9, accuracy: 15 };
  const self = new SelfLocation({}, { watch });
  self.init();
  assert.equal(watch.askedReplay, true, "the self-dot opts into replayLast");
  assert.ok(self.marker, "a cached fix drew the dot immediately");
  assert.deepEqual(self.marker.position, { lat: 19.1, lng: 72.9 });
  assert.equal(self.circle.radius, 15, "accuracy ring sized from the fix");
});

test("self 2: a later fix MOVES the dot, not recreates it", () => {
  const watch = fakeWatch();
  const self = new SelfLocation({}, { watch });
  self.init();
  watch.fire({ lat: 19.0, lng: 72.0, accuracy: 20 });
  const firstMarker = self.marker;
  const firstCircle = self.circle;
  watch.fire({ lat: 19.5, lng: 72.5, accuracy: 10 });
  assert.equal(self.marker, firstMarker, "same Marker instance, moved");
  assert.equal(self.circle, firstCircle, "same Circle instance, moved");
  assert.deepEqual(self.marker.position, { lat: 19.5, lng: 72.5 });
  assert.equal(self.circle.radius, 10);
});

test("self 3: a fix with no accuracy still draws the dot, just no ring", () => {
  const watch = fakeWatch();
  const self = new SelfLocation({}, { watch });
  self.init();
  watch.fire({ lat: 1, lng: 2, accuracy: undefined });
  assert.ok(self.marker, "dot drawn");
  assert.equal(self.circle, null, "no accuracy ring without a radius");
});

test("self 4: destroy unsubscribes and clears the overlays", () => {
  const watch = fakeWatch();
  const self = new SelfLocation({}, { watch });
  self.init();
  watch.fire({ lat: 1, lng: 2, accuracy: 5 });
  self.destroy();
  assert.equal(watch.subscribed, false, "unsubscribed from the shared watch");
  assert.equal(self.marker, null);
  assert.equal(self.circle, null);
});

test("self 5: a non-finite fix is ignored, never throws", () => {
  const watch = fakeWatch();
  const self = new SelfLocation({}, { watch });
  self.init();
  assert.doesNotThrow(() => watch.fire({ lat: NaN, lng: 2, accuracy: 5 }));
  assert.equal(self.marker, null, "garbage fix draws nothing");
});
