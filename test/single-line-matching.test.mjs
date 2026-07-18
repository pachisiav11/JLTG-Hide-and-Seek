// B2: a Matching "nearest line" question built on ONE line is meaningless, and the old guard
// (`lines.length < 1`) let it through. This test pins the geometry that makes it meaningless,
// so the UI guard has something to point at.
//
// With a single line, lineCells hands that line every Voronoi cell — it is the nearest line
// everywhere by construction. So:
//   "same"      -> gameArea \ gameArea -> null      -> the question eliminates NOTHING
//   "different" -> gameArea            -> the WHOLE board goes, on a correct answer
// Neither path throws, which is why neither was ever marked failed or surfaced in the banner.
// The fix is in layers.js (_matchNearestLine now requires two lines); what is asserted here is
// the reason it has to be, so nobody relaxes the guard back to one.
import test from "node:test";
import assert from "node:assert/strict";
import { turf } from "./helpers/turf-env.mjs";
import { computeElimination, computeActiveArea, EMPTY_AREA } from "../src/tools.js";

// A ~196 km2 board over central Mumbai.
const BOARD = {
  type: "Polygon",
  coordinates: [[[72.79, 18.89], [72.92, 18.89], [72.92, 19.02], [72.79, 19.02], [72.79, 18.89]]],
};
const km2 = (g) => (g && g.type ? turf.area(turf.feature(g)) / 1e6 : 0);

const step = (lines, lineId, match) => ({
  id: "s1", enabled: true, tool: "matching",
  inputs: { mode: "nearestLine", category: "transit_line", categoryLabel: "Transit Line", lines },
  answer: { lineId, match },
});

const ONE = [{ id: "ln_0", label: "Only line", coords: [{ lat: 18.93, lng: 72.82 }, { lat: 18.98, lng: 72.89 }] }];
const TWO = [
  ONE[0],
  { id: "ln_1", label: "Second line", coords: [{ lat: 18.91, lng: 72.90 }, { lat: 19.00, lng: 72.81 }] },
];

test("one line, answered 'same': eliminates nothing at all", () => {
  const { eliminated } = computeElimination(step(ONE, "ln_0", true), BOARD);
  // Not "a small amount" — literally nothing. The question is inert.
  assert.equal(eliminated, null);
});

test("one line, answered 'different': eliminates the entire board", () => {
  const { eliminated } = computeElimination(step(ONE, "ln_0", false), BOARD);
  assert.ok(eliminated, "expected a geometry, not null");
  assert.ok(Math.abs(km2(eliminated) - km2(BOARD)) < 0.5,
    `expected the whole board (${km2(BOARD).toFixed(1)} km2), got ${km2(eliminated).toFixed(1)} km2`);
});

test("neither one-line answer throws, which is why neither was ever marked failed", () => {
  const failed = [];
  for (const match of [true, false]) {
    computeActiveArea(BOARD, [step(ONE, "ln_0", match)], (id, why) => failed.push(`${id}:${why}`));
  }
  assert.deepEqual(failed, []);
});

test("the 'different' answer blanks the board via the sentinel, not via a failure", () => {
  const failed = [];
  const area = computeActiveArea(BOARD, [step(ONE, "ln_0", false)], (id, why) => failed.push(`${id}:${why}`));
  assert.equal(area, EMPTY_AREA);
  assert.deepEqual(failed, [], "a correct answer produced 'check your most recent answer' with nothing flagged");
});

test("two lines make the same question mean something in both directions", () => {
  const same = computeElimination(step(TWO, "ln_0", true), BOARD).eliminated;
  const diff = computeElimination(step(TWO, "ln_0", false), BOARD).eliminated;
  for (const [name, g] of [["same", same], ["different", diff]]) {
    const a = km2(g);
    assert.ok(a > 1 && a < km2(BOARD) - 1,
      `${name}: expected a proper subset of the board, got ${a.toFixed(1)} of ${km2(BOARD).toFixed(1)} km2`);
  }
  // And they are complementary: between them they account for the board exactly once.
  assert.ok(Math.abs(km2(same) + km2(diff) - km2(BOARD)) < 0.5);
});
