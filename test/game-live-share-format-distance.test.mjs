// Phase 24 game test: distance formatter for the live-share pill.
//
// Regression pin for observation #12 (2026-07-21). The original inline
// formatter had two problems:
//   1. Under 1 km it wrote `"${m} m"` unrounded — a GPS-drifted 512.3782 m
//      threshold printed to five decimal places when the ternary hit the
//      metres branch by accident.
//   2. At and above 1 km it used .toFixed(1)/.toFixed(2), which forced
//      trailing zeros: the 2 km option in the UI printed "2.0 km" and the
//      1 km option printed "1.0 km". The finding named "2000 m" — the
//      inline ternary was originally simpler and shipped that specific
//      string; a later edit already moved to toFixed but the trailing-
//      zero problem stayed.
//
// formatDistance(m) fixes both by rounding metres to the nearest whole
// metre and, for km, keeping up to two decimals but stripping trailing
// zeros via parseFloat.
import test from "node:test";
import assert from "node:assert/strict";

const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };
Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });

const { formatDistance } = await import("../src/live-share.js");

test("game 1: every live-share threshold option in games.js renders cleanly", () => {
  // The five radio options offered by src/games.js:525-529 are 0, 500,
  // 1000, 2000, 5000. All non-zero options must render without trailing
  // zeros — a UI that offers "2 km" and prints "2.0 km" back looks buggy.
  assert.equal(formatDistance(500), "500 m");
  assert.equal(formatDistance(1000), "1 km", "the 1 km option must not read as 1.0 km");
  assert.equal(formatDistance(2000), "2 km", "this is the exact string the finding named");
  assert.equal(formatDistance(5000), "5 km");
});

test("game 2: the awkward boundary — 999 m stays in metres, 1000 m flips to km", () => {
  assert.equal(formatDistance(999), "999 m");
  assert.equal(formatDistance(999.9), "1000 m", "still under 1000 rounds to 1000 m — deliberate, not a km flip");
  assert.equal(formatDistance(1000), "1 km");
  assert.equal(formatDistance(1000.1), "1 km", "just past the boundary reads as 1 km, not 1.0001 km");
});

test("game 3: non-round distances keep meaningful precision", () => {
  // The seeker's live distance is not a round number; it needs a decimal
  // or two to be legible without over-precision.
  assert.equal(formatDistance(2500), "2.5 km");
  assert.equal(formatDistance(2560), "2.56 km");
  assert.equal(formatDistance(2568), "2.57 km", "rounds to 2 decimals");
  assert.equal(formatDistance(1234), "1.23 km");
});

test("game 4: metres are always integer-rounded — no five-decimal noise", () => {
  // Before the fix, a raw `${threshold} m` interpolation could print
  // "512.3782 m" if the threshold was ever derived rather than set from the
  // radio.
  assert.equal(formatDistance(512.3782), "512 m");
  assert.equal(formatDistance(0), "0 m");
  assert.equal(formatDistance(0.4), "0 m");
  assert.equal(formatDistance(0.5), "1 m");
});

test("game 5: non-finite inputs return the empty string, never NaN or Infinity", () => {
  // The pill interpolates this into a template; NaN or Infinity in the
  // output would look worse than silence.
  assert.equal(formatDistance(NaN), "");
  assert.equal(formatDistance(Infinity), "");
  assert.equal(formatDistance(-Infinity), "");
  assert.equal(formatDistance(undefined), "");
});

test("game 6: the pill and the notification body both use this formatter", async () => {
  // Prove the wiring by checking that evaluateApproach's notification
  // body carries the same clean string. Without the shared helper, a future
  // change would touch one call site and forget the other — exactly the
  // drift the finding names.
  const { evaluateApproach } = await import("../src/live-share.js");
  const HIDING = { lat: 19.24, lng: 72.87 };
  const SEEKER_2KM = { lat: 19.222, lng: 72.87 }; // ~2 km away
  const r = evaluateApproach({ seekerPoint: SEEKER_2KM, zoneCentre: HIDING, thresholdM: 3000, prior: null });
  assert.ok(r.notify, "close enough to trigger");
  // The body reads "~<clean-distance> from your hiding zone centre."
  assert.match(r.notify.body, /~\d+(\.\d{1,2})? (m|km) from your hiding zone centre\./,
    `notification body should use the clean formatter, got: ${r.notify.body}`);
  assert.doesNotMatch(r.notify.body, /\.0 km/, "must not carry a trailing-zero km");
});
