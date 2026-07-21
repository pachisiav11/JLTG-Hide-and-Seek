// Phase 16 game test: countStationsInEliminated returns null instead of
// {inside:0, total:0} when every station in the set is already eliminated.
//
// Regression pin for review finding #4 (2026-07-21). The B1 draft preview
// (Phase 2) uses this counter to render "N of Y active stations would be
// eliminated by this pending step". When Y = 0 the sheet used to render
// "0 of 0 active stations", which carries no signal and would divide by
// zero the moment any caller ever percentages it.
//
// The scenario simulates the endgame of a real playtest: the seeker has
// eliminated every station in the locked set, then drafts a new radar to
// double-check. The counter must report "nothing to show" (null) rather
// than a meaningless zero pair.
import test from "node:test";
import assert from "node:assert/strict";
import { squareArea } from "./helpers/turf-env.mjs";
import { computeElimination } from "../src/tools.js";
import { countStationsInEliminated } from "../src/stations.js";

const AREA = squareArea([72.8777, 19.176], 0.4);

const draftRadar = (center, radiusM, side = "in") => ({
  id: "draft", tool: "radar", enabled: true,
  inputs: { center, radius: radiusM }, answer: { side },
});

test("game 1: all stations eliminated → counter returns null (not {0, 0})", () => {
  const stations = [
    { id: "a", name: "A", lat: 19.10, lng: 72.87, eliminated: true },
    { id: "b", name: "B", lat: 19.15, lng: 72.87, eliminated: true },
    { id: "c", name: "C", lat: 19.20, lng: 72.87, eliminated: true },
  ];
  const { eliminated: geom } = computeElimination(draftRadar({ lat: 19.15, lng: 72.87 }, 5000, "in"), AREA);
  const result = countStationsInEliminated(geom, stations);
  assert.equal(result, null, "an all-eliminated set has no active domain to count over");
});

test("game 2: one active station left → counter still returns a real pair", () => {
  const stations = [
    { id: "a", name: "A", lat: 19.10, lng: 72.87, eliminated: true },
    { id: "b", name: "B", lat: 19.15, lng: 72.87, eliminated: false },
    { id: "c", name: "C", lat: 19.20, lng: 72.87, eliminated: true },
  ];
  // side="out" eliminates the circle INTERIOR — station B at the radar centre
  // sits inside that eliminated region.
  const { eliminated: geom } = computeElimination(draftRadar({ lat: 19.15, lng: 72.87 }, 5000, "out"), AREA);
  const result = countStationsInEliminated(geom, stations);
  assert.deepEqual(result, { inside: 1, total: 1 }, "the sole active station is inside a 5km circle centred at its own location");
});

test("game 3: no shape → null (unchanged pre-existing behaviour)", () => {
  const stations = [{ id: "a", name: "A", lat: 19.10, lng: 72.87 }];
  assert.equal(countStationsInEliminated(null, stations), null);
});

test("game 4: empty station list → null (unchanged)", () => {
  const { eliminated: geom } = computeElimination(draftRadar({ lat: 19.15, lng: 72.87 }, 5000, "in"), AREA);
  assert.equal(countStationsInEliminated(geom, []), null);
});

test("game 5: no callers can accidentally divide by zero on the returned total", () => {
  // A hypothetical caller that does inside/total would blow up on the pre-fix
  // return shape. The post-fix null guard forces the caller to handle the
  // empty case explicitly — this test documents the contract.
  const allElim = [
    { id: "a", name: "A", lat: 19.10, lng: 72.87, eliminated: true },
  ];
  const { eliminated: geom } = computeElimination(draftRadar({ lat: 19.15, lng: 72.87 }, 5000, "in"), AREA);
  const result = countStationsInEliminated(geom, allElim);
  assert.equal(result, null);
  // If a future caller wants a percentage, they must check for null first.
  const pct = result ? result.inside / result.total : null;
  assert.equal(pct, null, "callers must short-circuit on null before percentaging");
});
