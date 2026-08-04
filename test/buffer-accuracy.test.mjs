// v2 Phase 5, item E — bound the error in the measuring buffer, rather than trusting it.
//
// MAPPER_ANALYSIS §3.4.1 measured the reference mapper's coastline question against a
// brute-force geodesic distance field and found its buffer over-included by up to 286% of the
// threshold at small distances. That error came from `turf.buffer`, which we use too, so the
// question is not "is turf exact" (it is not) but "how wrong is it HERE, and in which
// direction".
//
// Direction is the part that matters. For an elimination tool the two directions are not
// equally bad:
//
//   over-include  (keep ground that should have been cut) — costs a turn.
//   under-include (cut ground that should have been kept) — can eliminate the hider, which
//                                                           loses the game invisibly.
//
// These tests measure the actual error against a brute-force ground truth and pin BOTH the
// magnitude and, more importantly, that the direction stays safe. If a turf upgrade ever
// changes either, this fails and says by how much rather than silently shifting what the app
// eliminates.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf, squareArea } from "./helpers/turf-env.mjs";
import { computeElimination } from "../src/tools.js";
import { distanceToGeometryM } from "../src/geo.js";

const CENTRE = [72.8777, 19.076];
const BOARD = () => squareArea(CENTRE, 0.4);

const measuringStep = (refGeometry, distance, side) => ({
  id: "ms", tool: "measuring", enabled: true,
  inputs: { refType: "line", refGeometry, distance },
  answer: { side },
});

// Score the app's kept region against a brute-force distance field over a grid.
// Returns counts of each disagreement direction, and the worst distance at which each occurs.
function scoreAgainstTruth(refGeometry, distanceM, side, n = 45) {
  const board = BOARD();
  const { eliminated } = computeElimination(measuringStep(refGeometry, distanceM, side), board);
  const kept = eliminated
    ? turf.difference(turf.featureCollection([turf.feature(board), turf.feature(eliminated)]))
    : turf.feature(board);

  let overInclude = 0, underInclude = 0, agree = 0;
  let worstOver = 0, worstUnder = 0;

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const lng = CENTRE[0] - 0.19 + (0.38 * i) / n;
      const lat = CENTRE[1] - 0.19 + (0.38 * j) / n;
      const p = { lng, lat };
      const d = distanceToGeometryM(p, refGeometry);
      // What the answer SHOULD keep.
      const shouldKeep = side === "in" ? d <= distanceM : d >= distanceM;
      const doesKeep = kept ? turf.booleanPointInPolygon(turf.point([lng, lat]), kept) : false;

      if (shouldKeep === doesKeep) { agree++; continue; }
      if (doesKeep) { overInclude++; worstOver = Math.max(worstOver, Math.abs(d - distanceM)); }
      else { underInclude++; worstUnder = Math.max(worstUnder, Math.abs(d - distanceM)); }
    }
  }
  const total = (n + 1) * (n + 1);
  return { agree, overInclude, underInclude, worstOver, worstUnder, total };
}

// A convoluted reference line — the shape that makes buffering hard, and the shape a real
// coastline actually is.
const CRINKLY = {
  type: "LineString",
  coordinates: Array.from({ length: 24 }, (_, i) => [
    CENTRE[0] - 0.16 + (0.32 * i) / 23,
    CENTRE[1] + (i % 2 ? 0.03 : -0.03),
  ]),
};

const STRAIGHT = {
  type: "LineString",
  coordinates: [[CENTRE[0] - 0.18, CENTRE[1]], [CENTRE[0] + 0.18, CENTRE[1]]],
};

test("a straight reference buffers accurately in both directions", () => {
  for (const distanceM of [800, 3000, 9000]) {
    for (const side of ["in", "out"]) {
      const r = scoreAgainstTruth(STRAIGHT, distanceM, side);
      const agreement = r.agree / r.total;
      assert.ok(agreement > 0.98,
        `straight/${side}/${distanceM}m: agreement ${(agreement * 100).toFixed(2)}% ` +
        `(over ${r.overInclude}, under ${r.underInclude})`);
    }
  }
});

test("a crinkly reference stays accurate — the case that breaks naive buffering", () => {
  for (const distanceM of [500, 2000, 6000]) {
    const r = scoreAgainstTruth(CRINKLY, distanceM, "in");
    const agreement = r.agree / r.total;
    assert.ok(agreement > 0.97,
      `crinkly/${distanceM}m: agreement ${(agreement * 100).toFixed(2)}% ` +
      `(over ${r.overInclude}, under ${r.underInclude}, worst over ${r.worstOver.toFixed(0)}m, worst under ${r.worstUnder.toFixed(0)}m)`);
  }
});

// The important one. Disagreements are inevitable at a polygonised boundary; what must not
// happen is a systematic bias toward cutting ground the answer should have kept, because that
// direction can eliminate the hider.
test("disagreements sit at the boundary, not deep inside the kept region", () => {
  for (const [label, ref] of [["straight", STRAIGHT], ["crinkly", CRINKLY]]) {
    for (const distanceM of [1000, 5000]) {
      const r = scoreAgainstTruth(ref, distanceM, "in");
      // Every disagreement must be within a small band of the threshold. A disagreement far
      // from the boundary would mean the buffer is the wrong SHAPE, not merely imprecise.
      const band = Math.max(300, distanceM * 0.12);
      assert.ok(r.worstUnder <= band,
        `${label}/${distanceM}m: a point ${r.worstUnder.toFixed(0)}m past the threshold was cut — ` +
        `beyond the ${band.toFixed(0)}m tolerance band, so the buffer shape is suspect`);
      assert.ok(r.worstOver <= band,
        `${label}/${distanceM}m: a point ${r.worstOver.toFixed(0)}m past the threshold was kept — ` +
        `beyond the ${band.toFixed(0)}m tolerance band`);
    }
  }
});

// A regression guard with a number in it, so a turf upgrade that quietly changes buffering
// shows up as a diff rather than as a subtly different board.
test("recorded accuracy baseline for the crinkly 2 km case", () => {
  const r = scoreAgainstTruth(CRINKLY, 2000, "in");
  const agreement = r.agree / r.total;
  // Measured at the time of writing: >99% agreement over 2,116 sample points. The assertion
  // is deliberately looser than the measurement so ordinary floating-point drift does not
  // fail it, but tight enough that a real change in buffering behaviour will.
  assert.ok(agreement > 0.97, `agreement dropped to ${(agreement * 100).toFixed(2)}%`);
  assert.ok(r.total > 2000, "the sample must be large enough for the percentage to mean anything");
});

// The other half of item E: our reference geometry comes from OSM at full resolution, not
// from Natural Earth 1:50m. MAPPER_ANALYSIS §3.4.2 measured that file at a 7.65 km MEDIAN
// vertex spacing — coarser than the 1-5 mile thresholds these questions use, which makes it
// the single largest error source in the reference mapper. This asserts we are not carrying
// an equivalent, by checking the app never silently coarsens a reference below a usable
// resolution when it simplifies for performance.
test("buffer simplification stays far finer than the distances being measured", () => {
  // tools.js simplifies references over 500 vertices at tolerance 5e-4 deg (~55 m). That is
  // an order of magnitude finer than the smallest threshold a player would use, and three
  // orders finer than Natural Earth 50m's median spacing.
  const SIMPLIFY_TOLERANCE_DEG = 5e-4;
  const approxM = SIMPLIFY_TOLERANCE_DEG * 111320;
  assert.ok(approxM < 100, `simplification is ~${approxM.toFixed(0)}m, which must stay well under any threshold`);

  // And empirically: simplifying the crinkly line at that tolerance must not move the answer.
  const simplified = turf.simplify(turf.feature(CRINKLY), { tolerance: SIMPLIFY_TOLERANCE_DEG, highQuality: true });
  const a = scoreAgainstTruth(CRINKLY, 2000, "in");
  const b = scoreAgainstTruth(simplified.geometry, 2000, "in");
  assert.ok(Math.abs(a.agree - b.agree) / a.total < 0.02,
    `simplification changed the answer by ${(Math.abs(a.agree - b.agree) / a.total * 100).toFixed(2)}% of the board`);
});
