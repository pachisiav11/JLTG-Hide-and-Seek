// A3 — candidate POIs outside the play area are legitimate partition seeds.
//
// The old filter kept only candidates INSIDE the play area, reasoning that the hider is in
// the zone so outside places "could never be nearest". That is backwards. Dropping an
// outside seed makes the surviving seeds' Voronoi cells LARGER than the true cells, so a
// "No — different" answer eliminates an oversized region — including where the hider
// actually is. Nothing throws; the board quietly removes the right answer.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf, squareArea } from "./helpers/turf-env.mjs";
import { featuresNearArea } from "../src/geo.js";
import { computeElimination } from "../src/tools.js";

const AREA = squareArea([72.8777, 19.076], 0.2); // ~21 km board; lng spans 72.7777..72.9777

// The review's exact scenario: play area = a city, and the nearest Commercial Airport is
// outside it. Placed so the bisector (lng 72.925) falls ON the board — i.e. the outside
// airport genuinely owns part of it.
const INSIDE = { name: "Inside Airport", lat: 19.076, lng: 72.80 };
const OUTSIDE = { name: "Outside Airport", lat: 19.076, lng: 73.05 }; // ~7.6 km beyond the edge

const board = turf.area(turf.feature(AREA));
const areaOf = (g) => (g ? turf.area(turf.feature(g)) : 0);
const matchStep = (features, featureIndex, keep) => ({
  id: "m1", tool: "matching", enabled: true,
  inputs: { mode: "nearest", features, categoryLabel: "Commercial Airport" },
  answer: { featureIndex, keep },
});

// ---- the fix itself: the candidate filter must keep the outside seed ----------------

test("featuresNearArea keeps a POI just outside the play area", () => {
  const kept = featuresNearArea([INSIDE, OUTSIDE], AREA);
  assert.equal(kept.length, 2, "an airport 7.6 km outside the board is a legitimate seed");
  assert.ok(kept.some((f) => f.name === "Outside Airport"));
});

test("featuresNearArea still bounds a far-flung result", () => {
  // Sanity bound only: a POI on another continent is not a plausible partition seed.
  const faraway = { name: "Heathrow", lat: 51.47, lng: -0.45 };
  const kept = featuresNearArea([INSIDE, OUTSIDE, faraway], AREA);
  assert.ok(!kept.some((f) => f.name === "Heathrow"), "a POI 7000 km away should be dropped");
  assert.equal(kept.length, 2);
});

test("featuresNearArea is inert without an area or on bad geometry", () => {
  const feats = [INSIDE, OUTSIDE];
  assert.equal(featuresNearArea(feats, null), feats, "no area -> unchanged");
  assert.equal(featuresNearArea(feats, { type: "Nonsense" }), feats, "bad geometry must not block");
});

// ---- the consequence: what dropping the seed would have done ------------------------

test("the outside airport owns a real share of the board (26%), not zero", () => {
  // "different" on seed 1 eliminates seed 1's own cell.
  const outsideCell = areaOf(computeElimination(matchStep([INSIDE, OUTSIDE], 1, false), AREA).eliminated);
  const pct = (outsideCell / board) * 100;
  assert.ok(pct > 20 && pct < 33, `outside airport should own ~26% of the board, got ${pct.toFixed(1)}%`);
});

test("dropping the outside seed inflates a neighbouring cell — the false elimination", () => {
  // The realistic shape: two airports on the board, one just beyond its eastern edge.
  const west = { name: "West Airport", lat: 19.076, lng: 72.80 };
  const east = { name: "East Airport", lat: 19.076, lng: 72.90 };
  const beyond = { name: "Beyond Airport", lat: 19.076, lng: 73.02 }; // ~4.5 km outside

  // Answering "different" about the East Airport eliminates the East Airport's cell.
  const truthful = areaOf(computeElimination(matchStep([west, east, beyond], 1, false), AREA).eliminated);
  // What the old containment filter produced: `beyond` never reaches the engine.
  const filtered = areaOf(computeElimination(matchStep([west, east], 1, false), AREA).eliminated);

  assert.ok(filtered > truthful, "dropping the outside seed must inflate the eliminated cell");

  // Quantified: the inflation is the strip that genuinely belongs to the outside airport.
  // A hider standing there is nearest to `beyond`, so a truthful "not the East Airport"
  // answer must NOT eliminate them — but with the filter applied, it did.
  const inflationPct = ((filtered - truthful) / board) * 100;
  assert.ok(inflationPct > 3,
    `the wrongly-eliminated strip should be material, got ${inflationPct.toFixed(1)}%`);
});

test("the two cells tile the board without overlapping", () => {
  const cell0 = areaOf(computeElimination(matchStep([INSIDE, OUTSIDE], 0, false), AREA).eliminated);
  const cell1 = areaOf(computeElimination(matchStep([INSIDE, OUTSIDE], 1, false), AREA).eliminated);
  assert.ok(Math.abs(cell0 + cell1 - board) / board < 0.02, "the cells should tile the board");
});
