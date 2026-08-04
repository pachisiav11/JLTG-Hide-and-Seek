// v2 Phase 5, item K — the name-length answer is ternary, not boolean.
//
// "Is your station's name the same length as mine?" throws away most of what the hider just
// told you. They know whether theirs is shorter, the same, or longer, and saying which costs
// them nothing. A yes/no answer carries 1 bit; a three-way answer carries up to 1.58 — and in
// practice the gap is much larger than that ratio suggests, because "same length" is rare, so
// the boolean question is usually answered "no" and eliminates almost nothing.
//
// The compatibility half matters as much as the feature: a board saved under the old boolean
// form must keep meaning exactly what it meant. A saved game that changes its answer when the
// app updates mid-game is worse than a missing feature.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf, squareArea } from "./helpers/turf-env.mjs";
import { computeElimination, describeStep } from "../src/tools.js";

const CENTRE = [72.8777, 19.076];
const BOARD = () => squareArea(CENTRE, 0.4);
const km2 = (g) => (g ? turf.area(turf.feature(g)) / 1e6 : 0);

// Four stations spread across the board with name lengths 4, 6, 6, 9. The seeker's own
// length is 6, so "shorter" selects one station, "same" two, "longer" one.
const FEATS = [
  { name: "AAAA", len: 4, lng: CENTRE[0] - 0.12, lat: CENTRE[1] - 0.12 },
  { name: "BBBBBB", len: 6, lng: CENTRE[0] + 0.12, lat: CENTRE[1] - 0.12 },
  { name: "CCCCCC", len: 6, lng: CENTRE[0] + 0.12, lat: CENTRE[1] + 0.12 },
  { name: "DDDDDDDDD", len: 9, lng: CENTRE[0] - 0.12, lat: CENTRE[1] + 0.12 },
];

const step = (answer) => ({
  id: "nl", tool: "matching", enabled: true,
  inputs: { mode: "nameLength", features: FEATS },
  answer,
});

const keptKm2 = (answer) => {
  const board = BOARD();
  const { eliminated } = computeElimination(step(answer), board);
  if (!eliminated) return km2(board);
  const d = turf.difference(turf.featureCollection([turf.feature(board), turf.feature(eliminated)]));
  return d ? km2(d.geometry) : 0;
};

test("the three comparisons partition the board exactly", () => {
  const board = km2(BOARD());
  const shorter = keptKm2({ length: 6, comparison: "shorter" });
  const same = keptKm2({ length: 6, comparison: "same" });
  const longer = keptKm2({ length: 6, comparison: "longer" });

  assert.ok(Math.abs(shorter + same + longer - board) < board * 0.001,
    `the three answers must cover the board: ${shorter.toFixed(1)}+${same.toFixed(1)}+${longer.toFixed(1)} vs ${board.toFixed(1)}`);
  for (const [label, v] of [["shorter", shorter], ["same", same], ["longer", longer]]) {
    assert.ok(v > 0 && v < board, `${label} must keep a real share of the board, got ${v.toFixed(1)}`);
  }
});

// The whole point of the change, stated as a measurement rather than an argument.
//
// With this fixture (lengths 4, 6, 6, 9 and a seeker on 6) the arithmetic is exact and worth
// spelling out, because it is the argument for the feature:
//   "different" keeps the 4 and the 9        -> 2 of 4 cells survive, 2 eliminated
//   "shorter"   keeps only the 4             -> 1 of 4 cells survive, 3 eliminated
// So the directional answer eliminates 3/2 = 1.5x as much ground, from the same question,
// for no extra effort by the hider. On a real board the gap is larger still: exact
// name-length ties are rare, so "different" is the usual answer and usually cuts very little.
test("a directional answer eliminates half again as much as 'different'", () => {
  const board = km2(BOARD());
  const different = keptKm2({ length: 6, match: false });   // legacy: everything not length 6
  const shorter = keptKm2({ length: 6, comparison: "shorter" });

  assert.ok(different > shorter,
    "'different' keeps both the shorter and the longer stations, so it must keep more");

  const elimDifferent = board - different;
  const elimShorter = board - shorter;
  const ratio = elimShorter / elimDifferent;
  assert.ok(ratio > 1.4 && ratio < 1.6,
    `expected the predicted 3:2 advantage, got ${ratio.toFixed(3)} (${elimShorter.toFixed(1)} vs ${elimDifferent.toFixed(1)} km²)`);
});

// ---- Backwards compatibility --------------------------------------------

test("a legacy { match: true } step means exactly what it always meant", () => {
  assert.equal(
    keptKm2({ length: 6, match: true }).toFixed(3),
    keptKm2({ length: 6, comparison: "same" }).toFixed(3),
    "the old 'same' answer must be identical to the new one",
  );
});

test("a legacy { match: false } step keeps everything that is NOT the seeker's length", () => {
  const board = km2(BOARD());
  const different = keptKm2({ length: 6, match: false });
  const same = keptKm2({ length: 6, match: true });
  assert.ok(Math.abs(different + same - board) < board * 0.001,
    "the legacy pair must still partition the board");
});

test("a legacy step with no answer fields at all still defaults to 'same'", () => {
  // `match !== false` was the old default-true reading, and a board written before the field
  // existed must not flip meaning now.
  assert.equal(
    keptKm2({ length: 6 }).toFixed(3),
    keptKm2({ length: 6, comparison: "same" }).toFixed(3),
  );
});

// ---- The extreme case ---------------------------------------------------

// Reachable only in the ternary form: the seeker holds the shortest name, so nothing is
// shorter. That is a real and very strong answer — it rules out the whole board — and the
// dangerous thing to do is return `eliminated: null`, which reads as "this question ruled
// nothing out". That is the exact silent no-op this build has been removing everywhere else.
test("an answer nothing satisfies eliminates the whole board rather than nothing", () => {
  const kept = keptKm2({ length: 4, comparison: "shorter" }); // 4 is the minimum length present
  assert.equal(kept, 0, "nothing is shorter than the shortest station, so nothing survives");
});

test("the same extreme in the other direction", () => {
  const kept = keptKm2({ length: 9, comparison: "longer" });
  assert.equal(kept, 0);
});

// ---- The question list has to read as ternary ----------------------------

test("describeStep names the direction, so two cuts are not confusable", () => {
  assert.match(describeStep(step({ length: 6, comparison: "shorter" })), /shorter/);
  assert.match(describeStep(step({ length: 6, comparison: "longer" })), /longer/);
  assert.match(describeStep(step({ length: 6, comparison: "same" })), /same/);
  // Legacy rows must still describe themselves.
  assert.ok(describeStep(step({ length: 6, match: false })).length > 0);
});
