// A9 — bad distance input must be rejected, not silently clamped.
//
// `Math.max(10, parseFloat(...) || 0)` turned "0", "-500" and "abc" all into 10, with no
// feedback, while the "question added" toast fired as though the typed value had been
// honoured. The question then ran with a radius the seeker never chose.
//
// These tests pin the RULES the sheets apply (the sheets themselves live in layers.js,
// which can't be imported under node — see the browser check in the A9 commit).
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf } from "./helpers/turf-env.mjs";
import { readDistanceMeters } from "../src/ui.js";

const fakeSheet = (values) => ({
  q: (sel) => (sel.replace("#", "") in values ? { value: values[sel.replace("#", "")] } : null),
});

// The rules the sheets apply, mirrored here so they are executable.
const radarOk = (m) => Number.isFinite(m) && m > 0;
const measureOk = (m) => Number.isFinite(m) && m > 0;

test("non-numeric input is rejected rather than becoming 10", () => {
  const m = readDistanceMeters(fakeSheet({ x: "abc", "x-unit": "m" }), "x", "metric");
  assert.ok(Number.isNaN(m), "must not resolve to a number");
  assert.ok(!radarOk(m), '"abc" must be rejected, not silently clamped to 10');
});

test("negative input is rejected rather than becoming 10", () => {
  const m = readDistanceMeters(fakeSheet({ x: "-500", "x-unit": "m" }), "x", "metric");
  assert.equal(m, -500, "the typed value is read faithfully...");
  assert.ok(!radarOk(m), "...and then rejected, rather than clamped to 10");
});

test("empty input is rejected rather than becoming 10", () => {
  const m = readDistanceMeters(fakeSheet({ x: "", "x-unit": "m" }), "x", "metric");
  assert.ok(!radarOk(m));
});

test("zero is rejected — and here is why it is not merely clamped", () => {
  const m = readDistanceMeters(fakeSheet({ x: "0", "x-unit": "m" }), "x", "metric");
  assert.equal(m, 0, "0 is read faithfully rather than rewritten to 10");
  assert.ok(!measureOk(m), "but it cannot be used");

  // The review suggested allowing a genuine 0. Measured: turf returns NULL for a zero
  // buffer, so accepting 0 would produce a question that silently eliminates nothing —
  // exactly the class of failure section A exists to remove. Rejecting it with a stated
  // reason is the honest option.
  // (turf returns `undefined` here rather than null; bufferGeometry does `b ? b.geometry :
  // null`, so either way the tool receives null and eliminates nothing.)
  const zeroBuffer = turf.buffer(turf.point([72.8777, 19.076]), 0, { units: "meters" });
  assert.ok(!zeroBuffer, "turf.buffer(point, 0) is falsy — a 0-distance question is a no-op");
  const tenBuffer = turf.buffer(turf.point([72.8777, 19.076]), 10, { units: "meters" });
  assert.ok(tenBuffer && turf.area(tenBuffer) > 0, "...whereas a real distance buffers fine");
});

test("a valid value passes through untouched, in either unit system", () => {
  assert.equal(readDistanceMeters(fakeSheet({ x: "1000", "x-unit": "m" }), "x", "metric"), 1000);
  const mi = readDistanceMeters(fakeSheet({ x: "1", "x-unit": "mi" }), "x", "imperial");
  assert.ok(Math.abs(mi - 1609.344) < 0.01);
  assert.ok(radarOk(mi));
});

test("small positive values are honoured, not raised to the old floor of 10", () => {
  // A 5 m radar radius is unusual but it is what the seeker asked for. The old clamp
  // silently rewrote anything below 10.
  const m = readDistanceMeters(fakeSheet({ x: "5", "x-unit": "m" }), "x", "metric");
  assert.equal(m, 5);
  assert.ok(radarOk(m), "5 m is valid and must not be clamped to 10");
});

test("1 foot is valid and must not be clamped away", () => {
  // Under the old code an imperial "1 ft" (0.3048 m) was clamped to 10 METRES — a 32x
  // rewrite of a legitimate entry, on top of the unit bug.
  const m = readDistanceMeters(fakeSheet({ x: "1", "x-unit": "ft" }), "x", "imperial");
  assert.ok(Math.abs(m - 0.3048) < 1e-6);
  assert.ok(radarOk(m), "0.3048 m is a valid positive radius");
});
