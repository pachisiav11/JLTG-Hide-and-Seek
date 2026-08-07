// Phase 28 (req #4): custom km approach-threshold parsing.
//
// The live-share sheet offers 500 m / 1 / 2 / 5 km presets plus a "Custom"
// km number input. parseApproachKm(str) is the pure bridge between what the
// hider types (kilometres, possibly junk) and what the game stores
// (settings.approachThresholdM, always metres). The reject rules keep a
// mistyped value from silently disarming the seeker-close alert.
//
// The 50 km ceiling this used to enforce is GONE — a typed value is now stored
// as typed, however large. See "parse 6" for what replaced it and why.
import test from "node:test";
import assert from "node:assert/strict";

const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };
Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });

const liveShare = await import("../src/live-share.js");
const { parseApproachKm, evaluateApproach } = liveShare;

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

test("parse 6: there is no upper bound — a large value is stored as typed", () => {
  // This used to clamp to 50 km on the theory that "500" meant "5". Guessing at
  // intent by rewriting the number is the failure this pins against now: what
  // the hider types is what the alert uses.
  assert.equal(parseApproachKm("50"), 50000);
  assert.equal(parseApproachKm("500"), 500000, "500 km is 500 km, not a clamped 50");
  assert.equal(parseApproachKm("9999"), 9999000);
  assert.equal(parseApproachKm("20000"), 20000000, "past half the earth's circumference is still honoured");
});

test("parse 6b: the ceiling constant is gone, not merely unused", () => {
  // A leftover export would let a caller re-impose the bound by accident, and
  // the sheet's `max=` attribute is gone for the same reason.
  assert.equal(liveShare.MAX_APPROACH_KM, undefined, "MAX_APPROACH_KM must not be exported any more");
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

test("game 2: an unbounded custom value still behaves as a valid ring", () => {
  // The point of removing the ceiling: a board bigger than 50 km across can now
  // arm an alert that actually spans it. 500 km is a real cross-country ring,
  // not a value to be second-guessed into 50.
  const thresholdM = parseApproachKm("500");
  assert.equal(thresholdM, 500000, "stored as typed — no clamp");
  const HIDING = { lat: 19.24, lng: 72.87 };
  const NEAR = { lat: 19.30, lng: 72.87 };  // ~6.7 km away → inside 500 km
  const FAR = { lat: 24.50, lng: 72.87 };   // ~585 km away → outside 500 km

  const outside = evaluateApproach({ seekerPoint: FAR, zoneCentre: HIDING, thresholdM, prior: null });
  assert.equal(outside.notify, null, "585 km away is outside the 500 km ring — the ring is real, not saturated");
  assert.equal(outside.state.inside, false);

  const crossing = evaluateApproach({ seekerPoint: NEAR, zoneCentre: HIDING, thresholdM, prior: outside.state });
  assert.ok(crossing.notify, "crossing into the 500 km ring fires exactly one alert");
  assert.equal(crossing.state.inside, true);
});
