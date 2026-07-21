// Phase 37 (req #7b): the seeker's live position renders as a red dot on the
// hider's map, moves on each ping, and is removed on disconnect.
//
// Two halves: LiveShare emits the seeker point through onSeekerPoint (a ping →
// the point, teardown → null), and SeekerDot turns those into a marker it
// creates / moves / removes.
import test from "node:test";
import assert from "node:assert/strict";

const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };
Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });

class FakeMarker {
  constructor(opts) { this.opts = opts; this.position = opts.position; this.map = opts.map; }
  setPosition(p) { this.position = p; }
  setMap(m) { this.map = m; }
}
globalThis.window.google = { maps: { Marker: FakeMarker, SymbolPath: { CIRCLE: 0 } } };
globalThis.google = globalThis.window.google;

const { LiveShare } = await import("../src/live-share.js");
const { SeekerDot } = await import("../src/seeker-dot.js");

function makeTransport() {
  const listeners = new Map();
  return {
    on: (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); },
    off: (ev, fn) => listeners.get(ev)?.delete(fn),
    emit: () => {},
    deliver: (ev, payload) => listeners.get(ev)?.forEach((fn) => fn(payload)),
  };
}

test("dot 1: SeekerDot creates a red marker on the first point, moves it after", () => {
  const dot = new SeekerDot(null);
  dot.update({ lat: 19.1, lng: 72.9 });
  assert.ok(dot.marker, "first point draws the dot");
  assert.equal(dot.marker.opts.icon.fillColor, "#ef4444", "the seeker dot is red");
  const first = dot.marker;
  dot.update({ lat: 19.2, lng: 72.8 });
  assert.equal(dot.marker, first, "same marker instance, moved");
  assert.deepEqual(dot.marker.position, { lat: 19.2, lng: 72.8 });
});

test("dot 2: null / garbage removes the dot", () => {
  const dot = new SeekerDot(null);
  dot.update({ lat: 1, lng: 2 });
  dot.update(null);
  assert.equal(dot.marker, null, "null removes the marker");
  dot.update({ lat: 1, lng: 2 });
  dot.update({ lat: NaN, lng: 2 });
  assert.equal(dot.marker, null, "a non-finite point removes it too");
});

test("wire 1: a seeker ping drives onSeekerPoint; disconnect signals removal", () => {
  const transport = makeTransport();
  const dot = new SeekerDot(null);
  const share = new LiveShare({ transport, onSeekerPoint: (pt) => dot.update(pt) });
  share.startAsHider("abcdef");

  transport.deliver("location", { lat: 19.24, lng: 72.87, at: 1000 });
  assert.ok(dot.marker, "the ping rendered the seeker dot");
  assert.deepEqual(dot.marker.position, { lat: 19.24, lng: 72.87 });

  // A later ping moves it.
  transport.deliver("location", { lat: 19.20, lng: 72.85, at: 2000 });
  assert.deepEqual(dot.marker.position, { lat: 19.20, lng: 72.85 });

  // Disconnect removes it.
  share.stop();
  assert.equal(dot.marker, null, "stop() clears the seeker dot");
});

test("wire 2: the point is emitted even with no Hider zone set", () => {
  // The hider wants to SEE the seeker regardless of whether they've placed a
  // zone (the zone only gates the close-approach ALERT, not the dot).
  const transport = makeTransport();
  const seen = [];
  const share = new LiveShare({ transport, onSeekerPoint: (pt) => seen.push(pt) });
  share.startAsHider("abcdef");
  transport.deliver("location", { lat: 19.1, lng: 72.9, at: 1 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].lat, 19.1);
  share.stop();
});
