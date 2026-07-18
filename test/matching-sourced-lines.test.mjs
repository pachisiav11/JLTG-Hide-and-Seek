// R2: Matching ▸ Transit Line was still hand-traced although §F4 was marked "superseded by G1".
// Only the Tentacles half had been rebuilt. The claim that made the rebuild cheap is that
// `linePaths` already normalises both shapes — a drawn line's `coords` ([{lat,lng}]) and a
// sourced line's `paths` ([[[lat,lng]]]) — into one partition. This pins that claim, because
// it is the whole reason the sourced path could reuse the drawn path's geometry untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { turf } from "./helpers/turf-env.mjs";
import { computeElimination, linePaths } from "../src/tools.js";
import { MATCHING, findMatching } from "../src/data/questions.js";

const BOARD = {
  type: "Polygon",
  coordinates: [[[72.75, 18.85], [73.05, 18.85], [73.05, 19.35], [72.75, 19.35], [72.75, 18.85]]],
};
const km2 = (g) => (g && g.type ? turf.area(turf.feature(g)) / 1e6 : 0);

// The same two lines expressed both ways: as a seeker drew them, and as Overpass returns them.
const A = [[19.00, 72.84], [19.12, 72.85], [19.24, 72.86]];
const B = [[19.02, 72.95], [19.14, 72.97], [19.26, 72.99]];

const drawn = [
  { id: "ln_0", label: "Western Line", coords: A.map(([lat, lng]) => ({ lat, lng })) },
  { id: "ln_1", label: "Central Line", coords: B.map(([lat, lng]) => ({ lat, lng })) },
];
const sourced = [
  { id: "ln_0", label: "Western Line", paths: [A] },
  { id: "ln_1", label: "Central Line", paths: [B] },
];

const step = (lines, match) => ({
  id: "s1", enabled: true, tool: "matching",
  inputs: { mode: "nearestLine", category: "transit_line", categoryLabel: "Transit Line", lines },
  answer: { lineId: "ln_0", match },
});

test("linePaths reads a drawn line and a sourced line into the same geometry", () => {
  const d = linePaths(drawn[0]);
  const s = linePaths(sourced[0]);
  assert.deepEqual(d, s, "the two shapes must normalise identically or the partitions diverge");
});

test("a sourced-line question partitions exactly as the hand-drawn one did", () => {
  for (const match of [true, false]) {
    const a = km2(computeElimination(step(drawn, match), BOARD).eliminated);
    const b = km2(computeElimination(step(sourced, match), BOARD).eliminated);
    assert.ok(Math.abs(a - b) < 0.01,
      `match=${match}: drawn eliminated ${a.toFixed(2)} km2, sourced ${b.toFixed(2)} km2`);
    assert.ok(a > 1 && a < km2(BOARD) - 1, "expected a proper subset of the board");
  }
});

test("a sourced line with several OSM ways is still ONE line", () => {
  // An OSM line is many ways; the card must treat them as one thing or the Voronoi splits a
  // line against itself. Same geometry, delivered as two paths instead of one.
  const split = [
    { id: "ln_0", label: "Western Line", paths: [A.slice(0, 2), A.slice(1)] },
    sourced[1],
  ];
  const whole = km2(computeElimination(step(sourced, true), BOARD).eliminated);
  const parts = km2(computeElimination(step(split, true), BOARD).eliminated);
  assert.ok(Math.abs(whole - parts) < 0.01, `one path: ${whole.toFixed(2)}, two paths: ${parts.toFixed(2)}`);
});

test("Transit Line sources from rail, not metro — the suburban locals are the answer", () => {
  // Measured on the MMR board: metro returns 9 lines and none of them is Western/Central/
  // Harbour, which are route=train. A metro-only card cannot name the right line in Mumbai.
  assert.equal(findMatching("transit_line").lineKind, "rail");
});

test("Street or Path stays hand-drawn — no OSM query narrows a board's streets", () => {
  assert.equal(findMatching("street").lineKind, undefined);
});

test("every nearestLine card either names a lineKind or is deliberately drawn", () => {
  for (const c of MATCHING.filter((x) => x.mode === "nearestLine")) {
    assert.ok(c.lineKind === undefined || typeof c.lineKind === "string", c.id);
  }
});
