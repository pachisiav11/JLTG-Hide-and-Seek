// P4: the Matching line card fetches, groups and partitions, and only THEN checks
// MATCH_LINE_LIMIT. Measured on the default Mumbai boards, that refusal is not an edge case —
// it is what every new board does, because the rail filter starts empty:
//
//     live MMR board   44 grouped (35 route=train + 9 route=subway), 44 visible
//     this fixture     13 grouped ( 9 route=train + 4 route=subway), 13 visible
//     MATCH_LINE_LIMIT  8
//
// Both are over the limit, which is the point. They differ in size because the fixture is an
// older, smaller capture of the same city — and that difference is load-bearing below.
//
// P2 removed the expensive half (606.5 ms of distance work -> 29.7 ms). What is left is the
// interaction: the player is told to go and find 🚄 on their own, and pays the sourcing again
// to learn whether they picked few enough. The card now offers to open that panel directly.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeLines } from "../overpass-lines.js";
import { squareArea } from "./helpers/turf-env.mjs";
import { groupIntoLines, railFilter, isLineVisible } from "../src/lines.js";

const RAIL = normalizeLines(
  "rail",
  JSON.parse(readFileSync(new URL("./fixtures/overpass-rail-mumbai.json", import.meta.url), "utf8")),
);
const MATCH_LINE_LIMIT = 8; // TENTACLE_LINE_COLOURS.length, mirrored — see layers.js
const GROUPS = groupIntoLines(RAIL);

test("a default Mumbai board is over the limit, so the refusal is the common path", () => {
  const visible = GROUPS.filter((l) => isLineVisible(l, railFilter({ railFilter: { hiddenRoutes: [], hiddenLines: [] } })));
  assert.equal(visible.length, GROUPS.length, "an empty filter must hide nothing");
  assert.ok(visible.length > MATCH_LINE_LIMIT,
    `expected the default board to exceed ${MATCH_LINE_LIMIT}, got ${visible.length}`);
});

test("hiding route=train is not a dependable default — the result depends on the capture", () => {
  // The review suggested defaulting `hiddenRoutes` to exclude `train`. Measured on two
  // captures of the SAME city it lands on opposite sides of the limit:
  //
  //     this fixture (13 grouped:  9 train +  4 subway)  ->  4 visible, under the limit
  //     live MMR board (44 grouped: 35 train + 9 subway) ->  9 visible, over  the limit
  //
  // A default whose correctness depends on which day the board was captured is not a fix, and
  // it would also silently redefine which lines are in play. Hence the panel, not a default.
  const filter = railFilter({ railFilter: { hiddenRoutes: ["train"], hiddenLines: [] } });
  const visible = GROUPS.filter((l) => isLineVisible(l, filter));
  assert.ok(visible.length > 0, "hiding train must not empty the board — that would be a worse card");
  assert.equal(visible.length, 4, "this fixture's subway count — the live board's was 9");
  const trains = GROUPS.filter((l) => l.route === "train");
  assert.ok(trains.length > 0, "the fixture must actually contain the mode being hidden");
});

test("the filter can bring the board under the limit, which is what the panel is for", () => {
  // Hiding both modes present leaves nothing; hiding train and all but a few subway lines is
  // the real path. This asserts the mechanism the refusal now hands the player.
  const subway = GROUPS.filter((l) => l.route === "subway");
  const keep = new Set(subway.slice(0, 4).map((l) => l.key));
  const filter = railFilter({
    railFilter: {
      hiddenRoutes: ["train"],
      hiddenLines: GROUPS.filter((l) => !keep.has(l.key)).map((l) => l.key),
    },
  });
  const visible = GROUPS.filter((l) => isLineVisible(l, filter));
  assert.ok(visible.length >= 2 && visible.length <= MATCH_LINE_LIMIT,
    `expected an answerable set, got ${visible.length}`);
});

test("the refusal offers the panel rather than naming it and stopping", () => {
  const src = readFileSync(new URL("../src/layers.js", import.meta.url), "utf8");
  const i = src.indexOf("if (sourced.length > MATCH_LINE_LIMIT)");
  assert.ok(i > 0, "the limit guard moved — this test is pinned to the wrong symbol");
  const block = src.slice(i, i + 900);
  assert.match(block, /this\.lines\.openPanel/, "the player should be handed the filter, not sent to find it");
  assert.match(block, /_confirm/, "opening a panel unasked would be a surprise — it must be offered");
  assert.match(block, /else toast\(/, "declining still has to say what to do");
});

test("Layers still works without a rail panel wired in", () => {
  // The guard is `this.lines && await this._confirm(...)`, so a Layers built without one (as
  // every test and any future embedder does) must fall through to the toast, not throw.
  const src = readFileSync(new URL("../src/layers.js", import.meta.url), "utf8");
  assert.match(src, /this\.lines\s*=\s*lines\s*\|\|\s*null/, "the reference must be optional");
  const i = src.indexOf("if (sourced.length > MATCH_LINE_LIMIT)");
  assert.match(src.slice(i, i + 400), /this\.lines\s*&&/, "must short-circuit when absent");
});
