// v2 Phase 6, item W — a board can have holes in it.
//
// Zones were union-only, which cannot express a board with a hole — and holes are ordinary,
// not exotic: the bay in the middle of a harbour city, the airfield nobody may enter, the
// neighbouring municipality the group agreed is out of play. Without subtraction a seeker
// either draws an awkward ring of add-zones around the hole, or leaves it in and reasons
// about a board they know is wrong.
//
// The two properties that matter beyond "it subtracts": ORDER INDEPENDENCE (the board must
// not depend on the sequence zones happened to be drawn in, which is invisible in the UI) and
// REFUSING rather than silently ignoring a subtraction that cannot be applied.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf } from "./helpers/turf-env.mjs";
import { assembleBoard } from "../src/geo.js";

// Rings are [[lat, lng], ...] — the axis order zones are stored in.
const square = (lat, lng, half) => [
  [lat - half, lng - half], [lat - half, lng + half],
  [lat + half, lng + half], [lat + half, lng - half],
];

const km2 = (g) => (g ? turf.area(turf.feature(g)) / 1e6 : 0);
const zone = (polygon, mode) => (mode ? { polygon, mode } : { polygon });

const BIG = square(19.076, 72.8777, 0.1);      // the board
const HOLE = square(19.076, 72.8777, 0.03);    // a bay in the middle of it

test("with no subtractions the board is exactly the union, as before", () => {
  const a = assembleBoard([zone(BIG)]);
  assert.ok(Math.abs(km2(a) - km2(turf.polygon([BIG.map(([lat, lng]) => [lng, lat]).concat([[BIG[0][1], BIG[0][0]]])]).geometry)) < 1);
});

test("a subtracted zone removes its area from the board", () => {
  const whole = km2(assembleBoard([zone(BIG)]));
  const holed = km2(assembleBoard([zone(BIG), zone(HOLE, "subtract")]));
  assert.ok(holed < whole, "the hole must actually come out");
  // The hole is 0.06deg on a side against 0.2deg: 9% of the area.
  const ratio = holed / whole;
  assert.ok(ratio > 0.88 && ratio < 0.94, `expected ~91% of the board to remain, got ${(ratio * 100).toFixed(1)}%`);
});

test("the hole is genuinely a hole — points inside it are off the board", () => {
  const board = assembleBoard([zone(BIG), zone(HOLE, "subtract")]);
  const inHole = turf.point([72.8777, 19.076]);
  const outsideHole = turf.point([72.8777 + 0.07, 19.076]);
  assert.equal(turf.booleanPointInPolygon(inHole, turf.feature(board)), false, "the centre is cut out");
  assert.equal(turf.booleanPointInPolygon(outsideHole, turf.feature(board)), true, "the rest survives");
});

// The property that makes this safe to use. Zones are drawn in whatever order the seeker
// happens to draw them, and that order is not visible anywhere in the UI, so a board that
// depended on it would be impossible to reason about.
test("order does not matter: adds union first, then subtractions come out once", () => {
  const other = square(19.076, 72.8777 + 0.15, 0.06);
  const orders = [
    [zone(BIG), zone(other), zone(HOLE, "subtract")],
    [zone(HOLE, "subtract"), zone(BIG), zone(other)],
    [zone(other), zone(HOLE, "subtract"), zone(BIG)],
  ];
  const areas = orders.map((o) => km2(assembleBoard(o)));
  for (const a of areas) {
    assert.ok(Math.abs(a - areas[0]) < 0.5, `every ordering must give the same board: ${areas.map((x) => x.toFixed(1))}`);
  }
});

test("a subtraction that swallows the whole board reports no area, rather than pretending", () => {
  // Real outcome, not a crash: the seeker has excluded everything and needs to be told.
  const gone = assembleBoard([zone(HOLE), zone(BIG, "subtract")]);
  assert.equal(gone, null);
});

test("subtractions that miss the board leave it untouched", () => {
  const far = square(19.076 + 5, 72.8777 + 5, 0.05);
  const whole = km2(assembleBoard([zone(BIG)]));
  const withMiss = km2(assembleBoard([zone(BIG), zone(far, "subtract")]));
  assert.ok(Math.abs(whole - withMiss) < 0.5);
});

test("a board of only subtractions has nothing to subtract from", () => {
  assert.equal(assembleBoard([zone(HOLE, "subtract")]), null);
});

test("empty and malformed inputs are handled without throwing", () => {
  assert.equal(assembleBoard([]), null);
  assert.equal(assembleBoard(null), null);
  assert.equal(assembleBoard(undefined), null);
  // A degenerate ring (fewer than 3 points) is dropped by unionRings, not crashed on.
  assert.equal(assembleBoard([zone([[19, 72]])]), null);
});

test("several holes all come out", () => {
  const h1 = square(19.076 - 0.05, 72.8777 - 0.05, 0.02);
  const h2 = square(19.076 + 0.05, 72.8777 + 0.05, 0.02);
  const one = km2(assembleBoard([zone(BIG), zone(h1, "subtract")]));
  const two = km2(assembleBoard([zone(BIG), zone(h1, "subtract"), zone(h2, "subtract")]));
  assert.ok(two < one, "the second hole must come out too");
});

// Backwards compatibility: every zone ever saved lacks `mode`, and must keep adding.
test("zones with no mode add, so no saved board changes meaning", () => {
  const legacy = [{ polygon: BIG }, { polygon: square(19.076, 72.8777 + 0.15, 0.06) }];
  const tagged = legacy.map((z) => ({ ...z, mode: "add" }));
  assert.ok(Math.abs(km2(assembleBoard(legacy)) - km2(assembleBoard(tagged))) < 0.5);
});
