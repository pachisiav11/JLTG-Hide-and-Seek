// A6 — Voronoi degeneration must surface as a real failure, not a silent no-op.
//
// voronoiCells caught turf's exception and returned { cells: [null, null, ...] }. The
// caller then handed back `eliminated: null`, which nothing treats as an error: _render's
// per-step try/catch never incremented `failed`, so the "N questions failed" banner never
// fired, and computeActiveArea's catch saw no exception. The question stayed checked and
// enabled, contributing zero shading, traced only by a console.warn.
//
// The trigger is realistic: near-collinear seeds — stations along one straight rail line,
// i.e. exactly the Metro Lines and Station's Name Length candidate sets.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { squareArea } from "./helpers/turf-env.mjs";
import { computeElimination, computeActiveArea } from "../src/tools.js";

const AREA = squareArea([72.8777, 19.076], 0.2);

const matchStep = (features, featureIndex = 0, keep = false, id = "m1") => ({
  id, tool: "matching", enabled: true,
  inputs: { mode: "nearest", features, categoryLabel: "Station" },
  answer: { featureIndex, keep },
});

// Perfectly collinear stations along one straight line — the rail-line case.
const collinear = (n = 6) =>
  Array.from({ length: n }, (_, i) => ({
    name: `Station ${i + 1}`, lat: 19.076, lng: 72.80 + i * 0.02,
  }));

test("a healthy partition still works (guard against over-throwing)", () => {
  const feats = [
    { name: "A", lat: 19.05, lng: 72.82 },
    { name: "B", lat: 19.10, lng: 72.94 },
  ];
  const { eliminated } = computeElimination(matchStep(feats), AREA);
  assert.ok(eliminated, "a normal two-seed partition must still produce geometry");
});

test("collinear seeds are handled by this turf build (the reported trigger does not reproduce)", () => {
  // Recorded honestly: A6 was filed as [R] — reported by a playthrough and confirmed by
  // reading the code, never executed. Measured here, this turf build partitions collinear
  // seeds fine (as it does coincident ones, which `dejitter` exists to nudge apart). So the
  // swallow was real but its stated trigger does not reproduce. The next test exercises the
  // propagation directly rather than relying on a trigger we cannot produce.
  const { eliminated } = computeElimination(matchStep(collinear()), AREA);
  assert.ok(eliminated, "6 collinear stations still partition on this turf build");
});

test("a throwing turf.voronoi propagates instead of being swallowed", () => {
  // The actual regression. tools.js reads window.turf lazily through T(), so stubbing
  // voronoi reproduces the failure the old catch hid.
  const real = window.turf.voronoi;
  window.turf.voronoi = () => { throw new Error("simulated degeneration"); };
  try {
    assert.throws(
      () => computeElimination(matchStep(collinear()), AREA),
      /partition failed/i,
      "must throw so _render's per-step catch increments `failed` and the banner fires",
    );
  } finally {
    window.turf.voronoi = real;
  }
});

test("a swallowed failure would have produced a silent null — the exact old behaviour", () => {
  // Demonstrates what the old code did, so the regression is legible rather than asserted.
  const real = window.turf.voronoi;
  // Stand in for the old catch: return a featureCollection of nulls, never throwing.
  window.turf.voronoi = () => ({ type: "FeatureCollection", features: [null, null, null, null, null, null] });
  try {
    // All-null cells are now themselves treated as degeneration rather than a no-op.
    assert.throws(
      () => computeElimination(matchStep(collinear()), AREA),
      /no usable cells|partition/i,
      "all-null cells must fail loudly, not hand back eliminated: null",
    );
  } finally {
    window.turf.voronoi = real;
  }
});

test("a degenerate step is contained by computeActiveArea rather than blanking the board", () => {
  // computeActiveArea catches per-step failures and skips that step's contribution. A
  // throwing step must not take the whole active area down with it.
  const healthy = [
    { name: "A", lat: 19.05, lng: 72.82 },
    { name: "B", lat: 19.10, lng: 72.94 },
  ];
  const steps = [matchStep(healthy, 0, false, "ok"), matchStep(collinear(), 0, false, "bad")];
  const active = computeActiveArea(AREA, steps);
  // The healthy step's elimination still applies; the board is neither null nor untouched.
  assert.ok(active, "one bad step must not blank the active area");
});

test("voronoiCells failure names the cause, so the log is not misleading", () => {
  // Two identical points: dejitter exists to prevent coincident-point null cells, so this
  // must NOT throw — it is the case the app already handles deliberately.
  const dupes = [
    { name: "A", lat: 19.076, lng: 72.8777 },
    { name: "B", lat: 19.076, lng: 72.8777 },
  ];
  const { eliminated } = computeElimination(matchStep(dupes), AREA);
  assert.ok(eliminated !== undefined, "coincident points are dejittered, not a failure");
});

test("an unanswered step is not a failure", () => {
  // featureIndex == null means "no answer yet" — legitimately no elimination, must not throw.
  const feats = [
    { name: "A", lat: 19.05, lng: 72.82 },
    { name: "B", lat: 19.10, lng: 72.94 },
  ];
  const step = { id: "u", tool: "matching", enabled: true, inputs: { mode: "nearest", features: feats }, answer: {} };
  assert.doesNotThrow(() => computeElimination(step, AREA));
  assert.equal(computeElimination(step, AREA).eliminated, null);
});
