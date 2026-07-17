// Auto-sourced reference lines for the Measuring cards (coastline / borders).
//
// The cards that ask "how far are you from the coastline?" were hand-drawn: the player traced
// the coast with a fingertip and the app buffered the trace. That trace then eliminated real
// area, at whatever accuracy the tracing managed — so a player who knows the coast well got a
// better board than one who doesn't. The brief was explicit that no city should have that
// advantage, so the geometry now comes from OSM.
//
// Sourcing it changes the geometry's SHAPE: a hand-drawn line is one LineString, but a real
// coastline is dozens of disjoint OSM ways — a MultiLineString. These tests cover what that
// shape change can silently break.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf, squareArea } from "./helpers/turf-env.mjs";
import { computeElimination } from "../src/tools.js";
import { MEASURING, findMeasuring } from "../src/data/questions.js";

const BOARD = squareArea([72.8777, 19.076], 0.2);

// Two disjoint ways — the shape every real coastline/border payload has, and the shape a
// hand-drawn line never has.
const TWO_WAYS = {
  type: "MultiLineString",
  coordinates: [
    [[72.80, 19.00], [72.80, 19.05]],
    [[72.82, 19.06], [72.82, 19.10]],
  ],
};
const ONE_WAY = { type: "LineString", coordinates: TWO_WAYS.coordinates[0] };

const step = (refGeometry, side = "in", distance = 1000) => ({
  id: "m1", tool: "measuring", enabled: true,
  inputs: { refType: "line", refLabel: "Coastline", refGeometry, distance },
  answer: { side },
});

test("a MultiLineString reference draws a guide for EVERY way", () => {
  // The bug this pins: the guide branch tested only for "LineString", so a MultiLineString
  // drew NOTHING. turf.buffer handles both, so the elimination would have been correct while
  // the line it was measured from was invisible — the seeker sees a buffer ring floating on
  // the map with no way to check what it was drawn around. Nothing throws; it just silently
  // stops explaining itself.
  const { guides } = computeElimination(step(TWO_WAYS), BOARD);
  const polylines = guides.filter((g) => g.type === "polyline");
  assert.equal(polylines.length, 2, "one polyline per way — the reference must be visible");
  for (const p of polylines) {
    assert.ok(p.coords.length >= 2, "a guide polyline needs at least two points");
    assert.ok(
      p.coords.every((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng)),
      "guides are {lat,lng} — a swapped pair would draw the coast in the wrong hemisphere",
    );
  }
});

test("the single-LineString case still draws its guide — hand-drawing is not regressed", () => {
  // Cards with no worldwide-valid query (2nd admin division, high-speed rail) still hand-draw.
  const { guides } = computeElimination(step(ONE_WAY), BOARD);
  assert.equal(guides.filter((g) => g.type === "polyline").length, 1);
});

test("a MultiLineString eliminates the same way a LineString does", () => {
  // turf.buffer accepts both; this asserts the engine needed no special case, rather than
  // assuming it.
  const { eliminated } = computeElimination(step(TWO_WAYS, "in"), BOARD);
  assert.ok(eliminated, "a buffered multi-way reference must still eliminate");
  const inside = (pt) => turf.booleanPointInPolygon(turf.point(pt), turf.feature(eliminated));
  // "in" = the hider is CLOSER than 1 km, so everything farther than 1 km is eliminated.
  assert.ok(inside([72.95, 19.02]), "a point ~15 km from the coast is ruled out");
  assert.ok(!inside([72.8047, 19.02]), "a point ~500 m from the coast survives");
});

test("BOTH ways constrain the answer — not just the first", () => {
  // The real failure if only ways[0] were buffered: the second way's neighbourhood would be
  // eliminated despite being right next to the coast. Silent, and wrong in the hider's favour.
  const { eliminated } = computeElimination(step(TWO_WAYS, "in"), BOARD);
  const nearSecondWay = turf.point([72.8247, 19.08]); // ~500 m from way 2, ~2.6 km from way 1
  assert.ok(
    !turf.booleanPointInPolygon(nearSecondWay, turf.feature(eliminated)),
    "a point 500 m from the SECOND way must survive a 'closer than 1 km' answer",
  );
});

test("only the cards with a worldwide-valid query are auto-sourced", () => {
  // The admin_level lesson, as a test. admin_level=2 IS the international border by
  // definition and 4 measured as the 1st division in 14/14 countries sampled — but the 2nd
  // division has no fixed level (5, 6 or 8 depending on the country). Wiring a guess there
  // would be silently wrong in every country it didn't match, which is worse than drawing it.
  assert.equal(findMeasuring("coastline").lineKind, "coastline");
  assert.equal(findMeasuring("intl_border").lineKind, "border");
  assert.equal(findMeasuring("intl_border").level, 2);
  assert.equal(findMeasuring("admin1_border").lineKind, "border");
  assert.equal(findMeasuring("admin1_border").level, 4);

  assert.equal(findMeasuring("admin2_border").lineKind, undefined, "no fixed admin_level worldwide");
  assert.equal(findMeasuring("hs_train").lineKind, undefined, "OSM tags high-speed inconsistently");
});

test("every auto-sourced card is still a line card the proxy can serve", () => {
  // A lineKind that the endpoint rejects would 400 at the point of use — in a live game.
  const served = ["rail", "metro", "coastline", "border"];
  for (const c of MEASURING.filter((c) => c.lineKind)) {
    assert.equal(c.ref, "line", `${c.id} sources geometry, so it must buffer as a line`);
    assert.ok(served.includes(c.lineKind), `${c.id} names kind "${c.lineKind}", which /overpass/lines does not serve`);
    if (c.lineKind === "border") {
      assert.ok(Number.isInteger(c.level), `${c.id} is a border card and must name an admin_level`);
    }
  }
});
