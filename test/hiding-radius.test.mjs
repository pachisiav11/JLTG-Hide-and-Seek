// The hiding radius as a free number in metres, typed where it is used.
//
// It used to be a four-way radio in Settings — Off / 400 / 800 / 1600 m — which was wrong
// twice over. It sat in Settings while having exactly ONE consumer (the Station's Line
// question), so a seeker met it long before it meant anything and never again once it did;
// and four fixed rungs are not the rule any given group is actually playing.
//
// It is now typed on that card's own answer sheet, and parseHidingRadiusM is the pure bridge
// between what the seeker types and what the step stores. These tests pin the two decisions
// that are easy to regress:
//
//   1. REJECT, never clamp. Same rule as parseApproachKm in live-share.js — silently
//      rewriting a distance a player typed is how a board ends up eliminating ground on a
//      number nobody chose. Out of range returns null and the caller toasts the range.
//   2. Round BEFORE the range test, so a value that lands in range once stored is accepted
//      rather than refused for a bound it actually meets.
import test from "node:test";
import assert from "node:assert/strict";

const { parseHidingRadiusM, MIN_HIDING_RADIUS_M, MAX_HIDING_RADIUS_M } = await import("../src/stations.js");

test("bounds: the range is 1 m to 100000 m (100 km)", () => {
  // 1 m is the smallest radius that is not simply "the station point"; 100 km is wider than
  // any board this app draws on. Pinned as constants because the sheet renders them into its
  // min/max attributes AND its rejection toast — they must not drift apart.
  assert.equal(MIN_HIDING_RADIUS_M, 1);
  assert.equal(MAX_HIDING_RADIUS_M, 100000);
});

test("parse 1: a plain metre value comes back as itself", () => {
  assert.equal(parseHidingRadiusM("800"), 800, "the old 800 m rung still types fine");
  assert.equal(parseHidingRadiusM("400"), 400);
  assert.equal(parseHidingRadiusM("1600"), 1600);
  assert.equal(parseHidingRadiusM("250"), 250, "and so does a value no rung ever offered");
});

test("parse 2: whitespace and numeric input are tolerated", () => {
  assert.equal(parseHidingRadiusM("  800  "), 800);
  assert.equal(parseHidingRadiusM(800), 800, "accepts a number, not just a string");
});

test("parse 3: both ends of the range are inclusive", () => {
  assert.equal(parseHidingRadiusM("1"), 1);
  assert.equal(parseHidingRadiusM("100000"), 100000, "100 km exactly is in, not out");
});

test("parse 4: fractions round to whole metres", () => {
  // Sub-metre precision is noise on a hiding radius, and the step stores an integer.
  assert.equal(parseHidingRadiusM("800.4"), 800);
  assert.equal(parseHidingRadiusM("800.6"), 801);
});

test("parse 5: rounding happens BEFORE the range test", () => {
  // The ordering that matters. 0.6 m is below the 1 m floor as typed but rounds to 1, which
  // is in range — refusing it would reject a number the app would have been happy to store.
  // Same at the ceiling: 100000.4 rounds to exactly 100000.
  assert.equal(parseHidingRadiusM("0.6"), 1, "rounds up into range rather than being refused");
  assert.equal(parseHidingRadiusM("100000.4"), 100000, "rounds down into range");
  assert.equal(parseHidingRadiusM("0.4"), null, "but 0.4 rounds to 0, which is not a radius");
});

test("parse 6: out of range is REJECTED, not clamped", () => {
  // null (not a clamped bound) so the caller can toast the range and leave the box alone.
  // A clamp here would quietly turn a mistyped 1000000 into a 100 km elimination the seeker
  // never agreed to.
  assert.equal(parseHidingRadiusM("100001"), null, "one metre over the ceiling is out, not 100000");
  assert.equal(parseHidingRadiusM("1000000"), null);
  assert.equal(parseHidingRadiusM("0"), null, "0 is 'no radius' — that is the absence of a value, not one");
  assert.equal(parseHidingRadiusM("-5"), null);
});

test("parse 7: junk, empty and non-finite are rejected as null", () => {
  assert.equal(parseHidingRadiusM("abc"), null);
  assert.equal(parseHidingRadiusM(""), null);
  assert.equal(parseHidingRadiusM("   "), null);
  assert.equal(parseHidingRadiusM(null), null);
  assert.equal(parseHidingRadiusM(undefined), null);
  assert.equal(parseHidingRadiusM(NaN), null);
  assert.equal(parseHidingRadiusM(Infinity), null);
  assert.equal(parseHidingRadiusM(-Infinity), null);
});

test("parse 8: leading-number junk parses its numeric prefix (parseFloat semantics)", () => {
  // Matches parseApproachKm: a trailing unit the seeker typed out of habit is not a reason to
  // refuse the number in front of it.
  assert.equal(parseHidingRadiusM("800m"), 800);
  assert.equal(parseHidingRadiusM("800 metres"), 800);
});
