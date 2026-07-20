// Phase 8 (§C3) game test: vibrate + tone fires alongside the geofence
// notification, gated on the alert-style setting.
//
// The playtest scenario for this addition: a hider is standing at the edge of
// their zone with the phone in a pocket. Phase 3's text-only notification is
// invisible. §C3 adds a buzz you can feel and (optionally) a tone you can
// hear — the ONE physical channel a pocketed phone reliably delivers.
//
// We drive Geofence's private _buzzAndBeep through the settings toggles by
// mocking navigator.vibrate + AudioContext and asserting who was called under
// each style.
import test from "node:test";
import assert from "node:assert/strict";

const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };

const { Geofence } = await import("../src/geofence.js");
const store = await import("../src/store.js");
const { createGame } = await import("../src/model.js");

// A fresh Geofence + a fresh game with the alert-style setting we're testing.
function bootWithStyle(style) {
  const g = createGame({ name: "phase-8 test", settings: { geofenceMetres: 100, geofenceAlertStyle: style } });
  store.setCurrent(g);
  const buzzes = [];
  const tones = [];
  // navigator is a read-only global in Node 18+; redefine it via defineProperty
  // so tests can mock (and later strip) vibrate.
  Object.defineProperty(globalThis, "navigator", {
    value: { vibrate: (pat) => { buzzes.push(pat); return true; } },
    configurable: true, writable: true,
  });
  class MockOsc { constructor() { this.frequency = { value: 0 }; } connect(t) { return t; } start() { tones.push("start"); } stop() {} }
  class MockGain { constructor() { this.gain = { setValueAtTime: () => {}, linearRampToValueAtTime: () => {} }; } connect(t) { return t; } }
  class MockCtx { constructor() { this.currentTime = 0; this.destination = {}; this.state = "running"; } createOscillator() { return new MockOsc(); } createGain() { return new MockGain(); } resume() {} }
  globalThis.window.AudioContext = MockCtx;
  const gf = new Geofence({ Notification: null, geolocation: null });
  return { gf, buzzes, tones };
}

test("game 1: 'silent' fires neither vibrate nor tone", () => {
  const { gf, buzzes, tones } = bootWithStyle("silent");
  gf._buzzAndBeep();
  assert.equal(buzzes.length, 0);
  assert.equal(tones.length, 0);
});

test("game 2: 'vibrate' buzzes but does NOT play a tone", () => {
  const { gf, buzzes, tones } = bootWithStyle("vibrate");
  gf._buzzAndBeep();
  assert.equal(buzzes.length, 1);
  assert.deepEqual(buzzes[0], [200, 100, 200], "pattern is the same shape Phase 3's notify used to describe");
  assert.equal(tones.length, 0);
});

test("game 3: 'vibrate-tone' fires BOTH", () => {
  const { gf, buzzes, tones } = bootWithStyle("vibrate-tone");
  gf._buzzAndBeep();
  assert.equal(buzzes.length, 1);
  assert.equal(tones.length, 1);
});

test("game 4: an unset alert-style defaults to 'vibrate-tone' (the model default)", () => {
  // Cover the case of a game restored from before this setting existed. The
  // radio in Settings falls back to vibrate-tone; the geofence code must too.
  const { gf, buzzes, tones } = bootWithStyle(undefined);
  gf._buzzAndBeep();
  assert.equal(buzzes.length, 1);
  assert.equal(tones.length, 1);
});

test("game 5: no navigator.vibrate (iOS in practice) — the tone still fires", () => {
  const { gf, tones } = bootWithStyle("vibrate-tone");
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true }); // strip vibrate
  gf._buzzAndBeep();
  assert.equal(tones.length, 1, "the auditory channel still reaches a pocketed phone");
});

test("game 6: no AudioContext at all — buzz still fires; tone silently skipped", () => {
  const { gf, buzzes } = bootWithStyle("vibrate-tone");
  delete globalThis.window.AudioContext;
  gf._buzzAndBeep();
  assert.equal(buzzes.length, 1, "the tactile channel still fires when audio is unavailable");
});
