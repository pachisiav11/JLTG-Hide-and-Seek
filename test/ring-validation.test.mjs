// D1 — a hand-drawn ring that crosses itself must be refused, not committed.
//
// The finding predicted: "a self-crossing Body of Water flows into bufferGeometry, which
// catches the throw and returns null -> zero elimination". MEASURED 2026-07-17, that premise
// is wrong in both directions, and the truth is worse:
//
//   - turf.buffer does NOT throw on a bowtie. It returns a Polygon, and the step eliminates
//     409 km2 where the intended square eliminates 304 km2. Not "the question did nothing"
//     (which a seeker might notice) — a confident, plausible, WRONG elimination.
//   - As a ZONE it is worse still: unionRings returns a perfectly valid Polygon whose AREA
//     is 0, because the two lobes wind opposite ways and cancel. The board silently has no
//     area: every question eliminates nothing and no POI is ever "in the area".
//
// Nothing throws on either path, which is why this is a §A-class bug and why the guard has to
// live at the point of drawing.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf } from "./helpers/turf-env.mjs";
import { ringSelfIntersections, unionRings } from "../src/geo.js";
import { computeElimination } from "../src/tools.js";

// Rings are stored [lat,lng] (guide §4). All of these sit on a Mumbai board.
const BOWTIE = [[19.03, 72.83], [19.13, 72.93], [19.13, 72.83], [19.03, 72.93]];
const SQUARE = [[19.03, 72.83], [19.03, 72.93], [19.13, 72.93], [19.13, 72.83]];
const CONCAVE = [[19.03, 72.83], [19.03, 72.93], [19.13, 72.93], [19.08, 72.88], [19.13, 72.83]];
// Clean as an open path, self-crossing only once CLOSED — see the closing-edge test below.
const SPIRAL = [[19.03, 72.83], [19.03, 72.93], [19.13, 72.93], [19.13, 72.84],
                [19.04, 72.84], [19.04, 72.91], [19.11, 72.91]];

test("a bowtie is caught", () => {
  assert.ok(ringSelfIntersections(BOWTIE) > 0);
});

test("valid rings are not — including a concave one", () => {
  // Concave is the false positive that would matter: real play areas are rarely convex, and a
  // guard that rejected them would be worse than no guard.
  assert.equal(ringSelfIntersections(SQUARE), 0);
  assert.equal(ringSelfIntersections(CONCAVE), 0);
});

test("the CLOSING edge is checked — the one you never see while tapping", () => {
  // The whole reason to check the closed ring. This spiral is clean as an open path: the
  // preview polyline looks fine the entire time you are tapping it, and the crossing only
  // exists on the implicit last->first edge that appears when you press Finish.
  assert.equal(
    turf.kinks(turf.lineString(SPIRAL.map(([lat, lng]) => [lng, lat]))).features.length,
    0,
    "precondition: this ring is clean as an OPEN path",
  );
  assert.ok(ringSelfIntersections(SPIRAL) > 0, "but it self-crosses once closed — that must be caught");
});

test("too few points is not a self-intersection", () => {
  // The caller's own minPts check owns this; reporting a kink here would show the wrong message.
  assert.equal(ringSelfIntersections([]), 0);
  assert.equal(ringSelfIntersections([[19, 72], [19.1, 72.1]]), 0);
  assert.equal(ringSelfIntersections(null), 0);
});

test("WHY the guard exists: a bowtie ZONE silently zeroes the board's area", () => {
  // This is the state the guard prevents. Note unionRings does NOT fail — it returns a valid
  // Polygon. Only the area is 0, and nothing in the app reads that as an error.
  const area = unionRings([BOWTIE]);
  assert.ok(area, "unionRings does not fail on a bowtie — that is the problem");
  assert.equal(Math.round(turf.area(turf.feature(area))), 0, "the board silently has no area");

  const good = unionRings([SQUARE]);
  assert.ok(turf.area(turf.feature(good)) > 1e8, "the intended square is a real ~117 km2 board");
});

test("WHY the guard exists: a bowtie reference eliminates the WRONG area, and never throws", () => {
  // The finding expected null (zero elimination). Reality: a plausible, confident, wrong one.
  const board = { type: "Polygon", coordinates: [[[72.78, 18.98], [72.98, 18.98], [72.98, 19.18], [72.78, 19.18], [72.78, 18.98]]] };
  const step = (ring) => ({
    id: "s", tool: "measuring", enabled: true,
    inputs: {
      refType: "area", refLabel: "Body of Water",
      refGeometry: { type: "Polygon", coordinates: [[...ring.map(([lat, lng]) => [lng, lat]), [ring[0][1], ring[0][0]]]] },
      distance: 1000,
    },
    answer: { side: "in" },
  });
  const km2 = (g) => Math.round(turf.area(turf.feature(g)) / 1e6);

  const bad = computeElimination(step(BOWTIE), board);
  const good = computeElimination(step(SQUARE), board);
  assert.ok(bad.eliminated, "a bowtie does NOT produce a null elimination — it produces a wrong one");
  assert.ok(good.eliminated);
  assert.notEqual(km2(bad.eliminated), km2(good.eliminated),
    "the bowtie eliminates a different area than the shape the player meant to draw");
});
