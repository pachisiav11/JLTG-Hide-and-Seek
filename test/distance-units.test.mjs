// A5 — distance inputs must honour settings.units.
//
// Radar radius, Measuring distance and the Hider-zone radius were hard-coded to "metres"
// while the rest of the app converted (the Measure readout and the area summary both
// honour settings.units). An imperial player saw ft/mi everywhere else, typed the mile
// figure the hider gave them into a field labelled "metres", and the buffer came out
// ~1609x too small. Storage stays metric; only the UI boundary converts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitDistance, distanceFieldHTML, readDistanceMeters, formatDistance } from "../src/ui.js";

// Minimal stand-in for the sheet handle: openSheet() returns an object with .q().
const fakeSheet = (values) => ({
  q: (sel) => (sel.replace("#", "") in values ? { value: values[sel.replace("#", "")] } : null),
});

test("readDistanceMeters converts miles to metres (the ~1609x bug)", () => {
  const s = fakeSheet({ "m-dist": "2", "m-dist-unit": "mi" });
  const meters = readDistanceMeters(s, "m-dist", "imperial");
  assert.ok(Math.abs(meters - 3218.688) < 0.01, `2 mi should be ~3218.7 m, got ${meters}`);
  // The precise regression: typing "2" for 2 miles must not be stored as 2 metres.
  assert.ok(meters > 3000, "a mile value must never be taken as metres");
});

test("readDistanceMeters converts feet to metres", () => {
  const s = fakeSheet({ "r-radius": "500", "r-radius-unit": "ft" });
  assert.ok(Math.abs(readDistanceMeters(s, "r-radius", "imperial") - 152.4) < 0.01);
});

test("readDistanceMeters passes metric through, and scales km", () => {
  assert.equal(readDistanceMeters(fakeSheet({ x: "500", "x-unit": "m" }), "x", "metric"), 500);
  assert.equal(readDistanceMeters(fakeSheet({ x: "1.5", "x-unit": "km" }), "x", "metric"), 1500);
});

test("readDistanceMeters returns NaN for non-numeric input, not a silent default", () => {
  // A9 builds on this: callers must be able to reject rather than substitute.
  assert.ok(Number.isNaN(readDistanceMeters(fakeSheet({ x: "abc", "x-unit": "m" }), "x", "metric")));
  assert.ok(Number.isNaN(readDistanceMeters(fakeSheet({ x: "", "x-unit": "m" }), "x", "metric")));
});

test("an unknown or missing unit falls back to the system's small unit", () => {
  // Never silently reinterpret: imperial with no unit picked means feet, not metres.
  const s = fakeSheet({ x: "100" }); // no x-unit element at all
  assert.ok(Math.abs(readDistanceMeters(s, "x", "imperial") - 30.48) < 0.01);
  assert.equal(readDistanceMeters(fakeSheet({ x: "100" }), "x", "metric"), 100);
});

test("splitDistance switches units at the same points as formatDistance", () => {
  // Below a mile -> ft; at/above -> mi. Mirrors formatDistance's 5280 ft switch.
  assert.equal(splitDistance(100, "imperial").unit, "ft");
  assert.equal(splitDistance(3218.688, "imperial").unit, "mi");
  assert.equal(splitDistance(3218.688, "imperial").value, 2);
  // Below a km -> m; at/above -> km.
  assert.equal(splitDistance(500, "metric").unit, "m");
  assert.equal(splitDistance(1500, "metric").unit, "km");
  assert.equal(splitDistance(1500, "metric").value, 1.5);
});

test("splitDistance round-trips through readDistanceMeters", () => {
  for (const units of ["metric", "imperial"]) {
    for (const meters of [10, 500, 1000, 3218.688, 25000]) {
      const { unit, value } = splitDistance(meters, units);
      const back = readDistanceMeters(fakeSheet({ x: String(value), "x-unit": unit }), "x", units);
      // Display rounds (0 dp small / 2 dp large), so allow a small tolerance.
      assert.ok(Math.abs(back - meters) / meters < 0.01,
        `${units} ${meters}m -> ${value}${unit} -> ${back}m`);
    }
  }
});

test("splitDistance handles an unset value without printing NaN", () => {
  // The Hider zone opens with no radius set; the field must be blank, not "NaN".
  const { value } = splitDistance(NaN, "metric");
  assert.equal(value, "");
});

test("distanceFieldHTML renders both units and preselects the right one", () => {
  const html = distanceFieldHTML("r-radius", 1000, "imperial");
  assert.ok(html.includes('id="r-radius"'));
  assert.ok(html.includes('id="r-radius-unit"'));
  assert.ok(html.includes(">ft<") && html.includes(">mi<"), "imperial offers ft and mi");
  assert.ok(!html.includes(">m<"), "imperial must not offer metres");

  const metric = distanceFieldHTML("r-radius", 1000, "metric");
  assert.ok(metric.includes(">m<") && metric.includes(">km<"));
  assert.ok(!metric.includes(">ft<"), "metric must not offer feet");
  // 1000 m is exactly the km switch point.
  assert.ok(/value="1"/.test(metric), "1000 m should present as 1 km");
});

test("formatDistance is unchanged (the readouts these fields must agree with)", () => {
  assert.equal(formatDistance(500, "metric"), "500 m");
  assert.equal(formatDistance(1500, "metric"), "1.50 km");
  assert.equal(formatDistance(152.4, "imperial"), "500 ft");
  assert.equal(formatDistance(3218.688, "imperial"), "2.00 mi");
});
