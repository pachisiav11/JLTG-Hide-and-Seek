// C4-1: the fold memo was dead on every board containing a radar.
//
// C3-1 memoised the FOLD, but only `measuring` fed it stable geometry (via the buffer and clip
// caches). Radar, thermometer, matching and tentacles rebuilt their elimination on every call, so
// `computeActiveArea` received all-new objects and its identity comparison could never match —
// on any board with one radar on it, which is nearly all of them. Measured live on an 8-question
// radar board: dragging the focus zone, which changes neither the questions nor the game area,
// re-folded at 86.3 ms per frame.
//
// These tests pin BOTH halves: the elimination must be reused when nothing relevant changed, and
// it must not be when anything that alters the answer did. The second half is what matters — a
// stale elimination is a wrong shaded map, which is the answer the seeker reads.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { turf, squareArea, radarStep } from "./helpers/turf-env.mjs";
import { computeActiveArea, EMPTY_AREA } from "../src/tools.js";

const km2 = (g) => (g && g !== EMPTY_AREA ? turf.area(turf.feature(g)) / 1e6 : 0);
const board = () => squareArea([72.8777, 19.076], 0.4);

// Area alone cannot tell a stale cache from a correct equality — a 6 km circle removes the same
// number of km² wherever you put it on a big board, and a reference line shifted north buffers to
// the same size. That is the C3-2 trap, and it caught two of these tests on the first run. Where
// the thing that changed is a POSITION, compare the position.
const centroid = (g) => {
  const c = turf.centroid(turf.feature(g)).geometry.coordinates;
  return { lng: +c[0].toFixed(4), lat: +c[1].toFixed(4) };
};
const moved = (a, b) => Math.hypot(a.lng - b.lng, a.lat - b.lat);

// The observable proof of a hit: `computeActiveArea` returns the memoised RESULT object itself,
// which can only happen when every elimination matched by identity.
const hits = (AREA, steps) => computeActiveArea(AREA, steps) === computeActiveArea(AREA, steps);

test("a radar board reuses its eliminations, so the fold memo can hit", () => {
  const AREA = board();
  assert.ok(hits(AREA, [radarStep({ radiusM: 9000, side: "in" })]),
    "a repeated render with nothing changed must not refold");
});

test("a mixed board hits too — one uncached tool used to defeat the whole fold", () => {
  const AREA = board();
  const steps = [
    radarStep({ id: "r", radiusM: 12000, side: "in" }),
    { id: "t", tool: "thermometer", enabled: true, answer: { side: "hotter" },
      inputs: { a: { lat: 19.05, lng: 72.85 }, b: { lat: 19.10, lng: 72.90 } } },
  ];
  assert.ok(hits(AREA, steps), "every enabled step must present stable geometry");
});

// ---- and it must MISS whenever the answer would change ------------------------------

test("moving the radar centre misses — this is the drag path", () => {
  const AREA = board();
  // "in" clips the board TO the circle, so the surviving area moves with the centre. ("out"
  // would remove an equally-sized hole wherever it went — equal area for a real reason.)
  const step = radarStep({ center: [72.80, 19.00], radiusM: 6000, side: "in" });
  const before = centroid(computeActiveArea(AREA, [step]));
  // A drag rewrites inputs.center in place; the step object keeps its identity, which is
  // exactly why the signature compares scalars by VALUE rather than trusting the step.
  step.inputs.center = { lat: 19.20, lng: 72.99 };
  const after = centroid(computeActiveArea(AREA, [step]));
  assert.ok(moved(before, after) > 0.1,
    `moving the circle must move the surviving area (${JSON.stringify(before)} vs ${JSON.stringify(after)})`);
});

test("changing the radius misses", () => {
  const AREA = board();
  const step = radarStep({ radiusM: 3000, side: "in" });
  const small = km2(computeActiveArea(AREA, [step]));
  step.inputs.radius = 9000;
  const big = km2(computeActiveArea(AREA, [step]));
  assert.ok(big > small, `a wider radar must leave more board (${big} vs ${small})`);
});

test("changing the answer misses", () => {
  const AREA = board();
  const step = radarStep({ radiusM: 6000, side: "in" });
  const inn = km2(computeActiveArea(AREA, [step]));
  step.answer = { side: "out" };
  const out = km2(computeActiveArea(AREA, [step]));
  assert.ok(Math.abs(inn - out) > 1, `"in" and "out" must not share an entry (${inn} vs ${out})`);
});

test("the same step against a different board misses", () => {
  // An elimination is cut FROM the board, so it cannot be carried across one.
  const step = radarStep({ radiusM: 6000, side: "in" });
  const small = km2(computeActiveArea(squareArea([72.8777, 19.076], 0.1), [step]));
  const big = km2(computeActiveArea(squareArea([72.8777, 19.076], 0.4), [step]));
  // "in" clips the board to the circle, and a 0.1° board is narrower than a 6 km radius,
  // so the small board must yield strictly less.
  assert.ok(big > small, `a bigger board must leave more (${big} vs ${small})`);
});

test("key order does not decide a cache miss", () => {
  const AREA = board();
  const a = { id: "s", tool: "radar", enabled: true, answer: { side: "in" },
    inputs: { center: { lat: 19.076, lng: 72.8777 }, radius: 6000 } };
  const b = { id: "s", tool: "radar", enabled: true, answer: { side: "in" },
    inputs: { radius: 6000, center: { lng: 72.8777, lat: 19.076 } } };
  assert.equal(km2(computeActiveArea(AREA, [a])).toFixed(6),
    km2(computeActiveArea(AREA, [b])).toFixed(6),
    "the signature sorts keys, so the two orders are the same question");
});

test("replacing a sourced geometry misses, even at identical length", () => {
  // Bulk payloads are keyed by IDENTITY, not serialised. That is sound because sourced geometry
  // is stored and never mutated — but a REPLACED one is a different question and must miss.
  const AREA = board();
  const line = (dy) => ({ type: "MultiLineString",
    coordinates: [[[72.80, 19.00 + dy], [72.95, 19.02 + dy]]] });
  const step = { id: "m", tool: "measuring", enabled: true, answer: { side: "in" },
    inputs: { refType: "line", distance: 3000, refGeometry: line(0) } };
  // Again position, not size: a line shifted north buffers to the same area, so only the
  // location of the surviving strip distinguishes a recompute from a stale hit.
  const first = centroid(computeActiveArea(AREA, [step]));
  step.inputs.refGeometry = line(0.15);
  const second = centroid(computeActiveArea(AREA, [step]));
  assert.ok(moved(first, second) > 0.05,
    `a different reference line is a different answer (${JSON.stringify(first)} vs ${JSON.stringify(second)})`);
});

test("a deleted question's geometry is not pinned", () => {
  // WeakMap on the step, so the cache cannot outlive the question. Structural: a strong Map here
  // would hold every geometry a long game ever produced.
  const src = readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");
  assert.match(src, /const _elimCache = new WeakMap\(\)/,
    "the per-step elimination cache must be weak");
});
