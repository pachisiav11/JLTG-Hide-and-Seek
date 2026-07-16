// A4 — legacy (no-radius) tentacles steps must keep the hider's cell, not eliminate it.
//
// `radius == null` fell through to voronoiTool, which is Matching-shaped and destructures
// { featureIndex, keep }. A tentacles answer only ever carries { featureIndex } or
// { none: true }, so `keep` was undefined, the ternary took the falsy branch, and the tool
// eliminated `selected` — precisely the cell the hider said they were CLOSEST to. The
// inverse of the truth, with nothing thrown and no banner.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf, squareArea } from "./helpers/turf-env.mjs";
import { computeElimination } from "../src/tools.js";

const AREA = squareArea([72.8777, 19.076], 0.2);
const board = turf.area(turf.feature(AREA));

const WEST = { name: "West Museum", lat: 19.076, lng: 72.82 };
const EAST = { name: "East Museum", lat: 19.076, lng: 72.94 };

// A legacy step: inputs carry no `radius` and no `center`.
const legacyStep = (answer) => ({
  id: "t-legacy", tool: "tentacles", enabled: true,
  inputs: { features: [WEST, EAST] },
  answer,
});

const areaOf = (g) => (g ? turf.area(turf.feature(g)) : 0);
const contains = (g, pt) => (g ? turf.booleanPointInPolygon(turf.point(pt), turf.feature(g)) : false);

const WEST_PT = [72.80, 19.076]; // deep in the West Museum's cell
const EAST_PT = [72.96, 19.076]; // deep in the East Museum's cell

test("'closest to West' must NOT eliminate the West cell (the inversion)", () => {
  const { eliminated } = computeElimination(legacyStep({ featureIndex: 0 }), AREA);
  assert.ok(eliminated, "a legacy answer must still eliminate something");

  // The regression, stated directly: the hider said they are closest to West, so a point
  // in West's cell is where they might be and must survive.
  assert.ok(!contains(eliminated, WEST_PT), "the hider's own cell must not be eliminated");
  assert.ok(contains(eliminated, EAST_PT), "the other cell is what gets ruled out");
});

test("'closest to East' keeps the East cell and rules out the West", () => {
  const { eliminated } = computeElimination(legacyStep({ featureIndex: 1 }), AREA);
  assert.ok(!contains(eliminated, EAST_PT), "the hider's own cell must not be eliminated");
  assert.ok(contains(eliminated, WEST_PT));
});

test("the kept cell is a real share of the board, not everything or nothing", () => {
  const eliminated = computeElimination(legacyStep({ featureIndex: 0 }), AREA).eliminated;
  const keptPct = ((board - areaOf(eliminated)) / board) * 100;
  // Two seeds split this board roughly in half; the point is that a real region survives.
  assert.ok(keptPct > 20 && keptPct < 80, `expected a substantial kept cell, got ${keptPct.toFixed(1)}%`);
});

test("the two answers are complementary — each keeps what the other eliminates", () => {
  const elimW = computeElimination(legacyStep({ featureIndex: 0 }), AREA).eliminated;
  const elimE = computeElimination(legacyStep({ featureIndex: 1 }), AREA).eliminated;
  assert.ok(Math.abs(areaOf(elimW) + areaOf(elimE) - board) / board < 0.02,
    "the two eliminations should tile the board");
});

test("a legacy { none: true } answer eliminates nothing rather than inverting", () => {
  // With no radius there are no circles and every point is nearest to something, so
  // "none" has no geometry to eliminate. It must be a no-op, not a wrong elimination.
  const { eliminated } = computeElimination(legacyStep({ none: true }), AREA);
  assert.equal(eliminated, null);
});

test("a legacy step with no answer eliminates nothing", () => {
  assert.equal(computeElimination(legacyStep({}), AREA).eliminated, null);
});

test("modern seeker-radius steps are unaffected by the legacy branch", () => {
  // A step WITH a radius + center must still take the seeker-centric path: a miss
  // eliminates inside the seeker's circle.
  const modern = {
    id: "t-modern", tool: "tentacles", enabled: true,
    inputs: { features: [WEST, EAST], radius: 2000, center: { lat: 19.076, lng: 72.8777 } },
    answer: { none: true },
  };
  const { eliminated } = computeElimination(modern, AREA);
  assert.ok(eliminated, "a miss must eliminate the seeker's circle");
  assert.ok(contains(eliminated, [72.8777, 19.076]), "the circle's interior is ruled out");
  assert.ok(areaOf(eliminated) < board * 0.5, "a 2 km circle is a small share of a 21 km board");
});
