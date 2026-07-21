// Phase 23 game test: seeker publishes via watchPosition + throttled emit.
//
// Regression pin for observation #11 (2026-07-21). The old startAsSeeker
// used setInterval(60_000) + getCurrentPosition, waking the GPS radio to a
// fresh fix every minute for a 45-minute game — a real cost on a phone.
// Now uses watchPosition (shared subscription with the geofence) plus a
// client-side throttle so outbound share-location cadence is capped at one
// emit per emitIntervalMs.
//
// The public LiveShare API is unchanged; only the internal publish path
// switched. This test asserts (a) watchPosition is the call made (not
// getCurrentPosition + setInterval), (b) the throttle drops emits within
// the window, (c) an emit lands as soon as the window elapses, and
// (d) stop() clears the watch.
import test from "node:test";
import assert from "node:assert/strict";

const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };
Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });

const { LiveShare } = await import("../src/live-share.js");

function makeMockGeo() {
  const calls = { watchPosition: 0, getCurrentPosition: 0, clearWatch: [] };
  let handler = null;
  let errHandler = null;
  return {
    calls,
    fire(coords) { handler?.({ coords }); },
    fireErr(err) { errHandler?.(err); },
    watchPosition(onPos, onErr) {
      calls.watchPosition++;
      handler = onPos;
      errHandler = onErr;
      return 42;
    },
    getCurrentPosition() { calls.getCurrentPosition++; },
    clearWatch(id) { calls.clearWatch.push(id); handler = null; },
  };
}

function makeMockTransport() {
  const listeners = new Map();
  const emitted = [];
  return {
    listeners,
    emitted,
    on: (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); },
    off: (ev, fn) => listeners.get(ev)?.delete(fn),
    emit: (ev, payload) => emitted.push({ ev, payload }),
  };
}

test("game 1: startAsSeeker calls watchPosition, not getCurrentPosition (battery win)", () => {
  const geo = makeMockGeo();
  const transport = makeMockTransport();
  const share = new LiveShare({ transport, geolocation: geo });
  share.startAsSeeker("abcdef");
  assert.equal(geo.calls.watchPosition, 1, "must subscribe once via watchPosition");
  assert.equal(geo.calls.getCurrentPosition, 0, "must not spin up per-tick getCurrentPosition");
  share.stop();
});

test("game 2: the first fix emits immediately (no wait for the interval)", () => {
  const geo = makeMockGeo();
  const transport = makeMockTransport();
  let clock = 1000;
  const share = new LiveShare({ transport, geolocation: geo, emitIntervalMs: 60_000, now: () => clock });
  share.startAsSeeker("abcdef");
  geo.fire({ latitude: 19.076, longitude: 72.877 });
  const emits = transport.emitted.filter((e) => e.ev === "share-location");
  assert.equal(emits.length, 1, "first fix must land — the hider is waiting");
  assert.deepEqual(emits[0].payload, { lat: 19.076, lng: 72.877 });
  share.stop();
});

test("game 3: fixes inside the emit window are silently dropped", () => {
  const geo = makeMockGeo();
  const transport = makeMockTransport();
  let clock = 1000;
  const share = new LiveShare({ transport, geolocation: geo, emitIntervalMs: 60_000, now: () => clock });
  share.startAsSeeker("abcdef");
  // Fires ten fixes over ten seconds — a phone with fast GPS lock produces
  // exactly this shape. Only the first should reach the wire.
  for (let i = 0; i < 10; i++) {
    geo.fire({ latitude: 19.076 + i * 0.0001, longitude: 72.877 });
    clock += 1000;
  }
  const emits = transport.emitted.filter((e) => e.ev === "share-location");
  assert.equal(emits.length, 1, "throttle must drop everything within the 60 s window");
  share.stop();
});

test("game 4: as soon as the window elapses, the next fix emits", () => {
  const geo = makeMockGeo();
  const transport = makeMockTransport();
  let clock = 1000;
  const share = new LiveShare({ transport, geolocation: geo, emitIntervalMs: 60_000, now: () => clock });
  share.startAsSeeker("abcdef");
  geo.fire({ latitude: 19.076, longitude: 72.877 }); // t=1000
  clock = 61_001; // just past 60 s later
  geo.fire({ latitude: 19.100, longitude: 72.900 });
  const emits = transport.emitted.filter((e) => e.ev === "share-location");
  assert.equal(emits.length, 2, "second emit lands after the window");
  assert.deepEqual(emits[1].payload, { lat: 19.100, lng: 72.900 });
  share.stop();
});

test("game 5: stop() clears the watch — GPS radio stops when the feature stops", () => {
  const geo = makeMockGeo();
  const transport = makeMockTransport();
  const share = new LiveShare({ transport, geolocation: geo });
  share.startAsSeeker("abcdef");
  assert.equal(geo.calls.clearWatch.length, 0);
  share.stop();
  assert.deepEqual(geo.calls.clearWatch, [42], "clearWatch must be called with the id watchPosition returned");
});

test("game 6: an error from the GPS surfaces as a pill update, not a throw", () => {
  const geo = makeMockGeo();
  const transport = makeMockTransport();
  const share = new LiveShare({ transport, geolocation: geo });
  share.startAsSeeker("abcdef");
  // Should not throw even without a document/pill in the environment.
  assert.doesNotThrow(() => geo.fireErr(new Error("permission denied")));
  share.stop();
});

test("game 7: switching to a fresh session resets the throttle so the first fix is not held up", () => {
  const geo = makeMockGeo();
  const transport = makeMockTransport();
  let clock = 1000;
  const share = new LiveShare({ transport, geolocation: geo, emitIntervalMs: 60_000, now: () => clock });
  share.startAsSeeker("first");
  geo.fire({ latitude: 19.076, longitude: 72.877 });
  clock = 5000; // still inside the window
  share.startAsSeeker("second"); // new session — should re-arm
  geo.fire({ latitude: 19.100, longitude: 72.900 });
  const emits = transport.emitted.filter((e) => e.ev === "share-location");
  assert.equal(emits.length, 2, "session switch must reset the throttle — a fresh hider is waiting");
  share.stop();
});
