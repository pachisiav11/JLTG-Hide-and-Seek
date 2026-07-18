// B4: a failed zone union silently deleted the play area.
//
// `g.gameArea = unionRings(g.zones.map(z => z.polygon))` treats unionRings' null as "the
// answer", but null means two different things: "there are no zones" and "turf could not
// union these". On the second one the board vanished — and because every downstream reader is
// guarded on `g.gameArea` being truthy (layers.js skips every guide, computeActiveArea returns
// null), the app rendered a blank, healthy-looking map with no message. addZone even toasted
// `Added "X"`, because areaSummary(null) is null and the message falls back to the no-size
// wording.
//
// Zones._fold is the seam that separates the two meanings. These tests pin that separation;
// the callers (addZone / removeZone) act on `ok` and say so out loud.
import test from "node:test";
import assert from "node:assert/strict";
import { turf } from "./helpers/turf-env.mjs";
import { Zones } from "../src/zones.js";

const sq = (w, s, e, n) => [[s, w], [s, e], [n, e], [n, w], [s, w]]; // zones store [lat,lng]
const zone = (name, ring) => ({ id: name, name, polygon: ring });
const km2 = (g) => (g ? turf.area(turf.feature(g)) / 1e6 : 0);

test("no zones at all is the one case where a null area is the truth", () => {
  const { ok, area } = Zones._fold([]);
  assert.equal(ok, true, "an empty board is not a failure");
  assert.equal(area, null);
});

test("one zone folds to that zone", () => {
  const { ok, area } = Zones._fold([zone("A", sq(72.79, 18.89, 72.92, 19.02))]);
  assert.equal(ok, true);
  assert.ok(km2(area) > 100, `expected a real Mumbai-sized board, got ${km2(area).toFixed(1)} km2`);
});

test("two overlapping zones fold to their union, not their sum", () => {
  const a = zone("A", sq(72.79, 18.89, 72.92, 19.02));
  const b = zone("B", sq(72.85, 18.95, 72.98, 19.08));
  const { ok, area } = Zones._fold([a, b]);
  assert.equal(ok, true);
  const sum = km2(Zones._fold([a]).area) + km2(Zones._fold([b]).area);
  assert.ok(km2(area) < sum, "overlap should be counted once");
  assert.ok(km2(area) > km2(Zones._fold([a]).area), "the union should be larger than either part");
});

test("a union that FAILS is reported as not-ok, and is distinguishable from an empty board", () => {
  // Rings turf cannot fold: degenerate (fewer than 3 points) ones are dropped by unionRings,
  // so a list of only-degenerate zones yields null from a NON-empty zone list. That is exactly
  // the shape the old code could not tell from "no zones".
  const bad = [zone("bad", [[19.0, 72.8], [19.0, 72.9]])];
  const { ok, area } = Zones._fold(bad);
  assert.equal(area, null);
  assert.equal(ok, false, "a non-empty zone list that folds to nothing is a FAILURE, not an empty board");

  // The distinction the bug turned on: same null area, different verdict.
  assert.equal(Zones._fold([]).area, area);
  assert.notEqual(Zones._fold([]).ok, ok);
});

test("a good zone list still folds even when a failure preceded it", () => {
  // The guard must not be sticky: refusing one zone leaves the next one addable.
  assert.equal(Zones._fold([zone("bad", [[19.0, 72.8]])]).ok, false);
  assert.equal(Zones._fold([zone("A", sq(72.79, 18.89, 72.92, 19.02))]).ok, true);
});
