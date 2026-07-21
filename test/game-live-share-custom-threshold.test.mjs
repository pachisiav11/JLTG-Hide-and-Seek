// Phase 28 (req #4): custom km approach-threshold parsing.
//
// The live-share sheet offers 500 m / 1 / 2 / 5 km presets plus a "Custom"
// km number input. parseApproachKm(str) is the pure bridge between what the
// hider types (kilometres, possibly junk) and what the game stores
// (settings.approachThresholdM, always metres). The reject/clamp rules keep a
// mistyped value from silently disarming the seeker-close alert.
import test from "node:test";
import assert from "node:assert/strict";

const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };
Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });

const { parseApproachKm, MAX_APPROACH_KM, evaluateApproach } = await import("../src/live-share.js");

test("parse 1: a plain km value converts to metres", () => {
  assert.equal(parseApproachKm("1.5"), 1500);
  assert.equal(parseApproachKm("1"), 1000);
  assert.equal(parseApproachKm("0.5"), 500);
  assert.equal(parseApproachKm("3"), 3000);
});

test("parse 2: whitespace and numeric input are tolerated", () => {
  assert.equal(parseApproachKm("  2  "), 2000);
  assert.equal(parseApproachKm(2.5), 2500, "accepts a number, not just a string");
});

test("parse 3: fractional km round to whole metres", () => {
  assert.equal(parseApproachKm("1.2345"), 1235, "0.0005 km rounds up to the nearest metre");
  assert.equal(parseApproachKm("0.001"), 1);
});

test("parse 4: junk, empty, zero, and negative are rejected as null", () => {
  // null (not 0) so the caller can fall back to the stored preset instead of
  // storing a threshold that never fires.
  assert.equal(parseApproachKm("abc"), null);
  assert.equal(parseApproachKm(""), null);
  assert.equal(parseApproachKm("   "), null);
  assert.equal(parseApproachKm(null), null);
  assert.equal(parseApproachKm(undefined), null);
  assert.equal(parseApproachKm("0"), null, "0 km is 'off' territory — that's the preset, not a custom value");
  assert.equal(parseApproachKm("-3"), null);
  assert.equal(parseApproachKm(NaN), null);
  assert.equal(parseApproachKm(Infinity), null);
});

test("parse 5: leading-number junk parses its numeric prefix (parseFloat semantics)", () => {
  assert.equal(parseApproachKm("2km"), 2000, "parseFloat reads the 2, ignores the unit suffix");
  assert.equal(parseApproachKm("1.5 kilometres"), 1500);
});

test("parse 6: absurdly large values clamp to MAX_APPROACH_KM, never disarm the alert", () => {
  assert.equal(parseApproachKm("500"), MAX_APPROACH_KM * 1000, "a fat-fingered 500 (meant 5?) clamps, not silently huge");
  assert.equal(parseApproachKm("9999"), MAX_APPROACH_KM * 1000);
  assert.equal(parseApproachKm(String(MAX_APPROACH_KM)), MAX_APPROACH_KM * 1000, "exactly the max is allowed");
});

test("game 1: a custom threshold drives an evaluateApproach crossing", () => {
  // The whole point: whatever the hider types must behave exactly like a
  // preset once it's in metres. Type 1.5 km, and a seeker at ~1 km crosses in.
  const thresholdM = parseApproachKm("1.5");
  assert.equal(thresholdM, 1500);
  const HIDING = { lat: 19.24, lng: 72.87 };
  const FAR = { lat: 19.222, lng: 72.87 };   // ~2 km away → outside 1.5 km
  const NEAR = { lat: 19.231, lng: 72.87 };  // ~1 km away → inside 1.5 km

  const outside = evaluateApproach({ seekerPoint: FAR, zoneCentre: HIDING, thresholdM, prior: null });
  assert.equal(outside.notify, null, "2 km away is outside the custom 1.5 km ring");
  assert.equal(outside.state.inside, false);

  const crossing = evaluateApproach({ seekerPoint: NEAR, zoneCentre: HIDING, thresholdM, prior: outside.state });
  assert.ok(crossing.notify, "crossing into the custom ring fires exactly one alert");
  assert.equal(crossing.notify.kind, "seeker-close");
  assert.equal(crossing.state.inside, true);
});

test("game 2: a clamped custom value still behaves as a valid ring", () => {
  const thresholdM = parseApproachKm("500"); // clamps to 50 km
  assert.equal(thresholdM, 50000);
  const HIDING = { lat: 19.24, lng: 72.87 };
  const SEEKER = { lat: 19.30, lng: 72.87 }; // ~6.7 km away → well inside 50 km
  const r = evaluateApproach({ seekerPoint: SEEKER, zoneCentre: HIDING, thresholdM, prior: null });
  assert.ok(r.notify, "inside the clamped 50 km ring");
});
