// Hiding zones — the circles drawn around stations, and the four ways to draw them.
//
// A station is a point; a hider near it is not standing on the point. The radius is that
// difference made visible, so these tests are about geometry a seeker LOOKS at: is the circle
// the size it claims, does each style draw what it says, and does bad input get dropped
// rather than rendered at (0, 0).
//
// This file used to also cover a survival rule ("a station survives iff any part of its zone
// survives") and a per-station diagnosis. Both were removed with their two consumers — the
// draft-preview station counter and the "what survives here?" drill-down — in the station-list
// review. The rule never drove a real elimination (stations are only ever eliminated by hand),
// so once the readouts went it had no caller, and the tests went with the code.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf, squareArea } from "./helpers/turf-env.mjs";
import { zoneFor, zoneRenderGeometry } from "../src/hiding-zones.js";

const CENTRE = [72.8777, 19.076];
const BOARD = () => squareArea(CENTRE, 0.4);

test("zoneFor produces a circle of the requested ground radius", () => {
  const z = zoneFor({ lat: CENTRE[1], lng: CENTRE[0] }, 1000);
  const areaKm2 = turf.area(z) / 1e6;
  // pi r^2 = 3.1416 km2 at r = 1 km; a 32-gon inscribes slightly under.
  assert.ok(areaKm2 > 3.0 && areaKm2 < 3.15, `got ${areaKm2.toFixed(3)} km²`);
  assert.equal(zoneFor({ lat: 19, lng: 72 }, 0), null, "radius 0 has no zone polygon");
});

// ---- Item M: render styles ----------------------------------------------

const someStations = () => [
  { id: "a", name: "A", lat: CENTRE[1], lng: CENTRE[0] },
  { id: "b", name: "B", lat: CENTRE[1] + 0.004, lng: CENTRE[0] + 0.004 }, // overlaps A at 1 km
  { id: "c", name: "C", lat: CENTRE[1] + 0.1, lng: CENTRE[0] + 0.1 },     // separate
];

test("style 'zones' yields one circle per station", () => {
  const g = zoneRenderGeometry(someStations(), 1000, "zones");
  assert.equal(g.circles.length, 3);
  assert.equal(g.union, null, "no union is computed for a style that does not draw one");
});

test("style 'stations' yields points and no circles", () => {
  const g = zoneRenderGeometry(someStations(), 1000, "stations");
  assert.equal(g.circles.length, 0);
  assert.equal(g.points.length, 3);
});

test("style 'no-overlap' merges overlapping zones into one silhouette", () => {
  const g = zoneRenderGeometry(someStations(), 1000, "no-overlap");
  assert.ok(g.union, "a union must be produced");
  const unionKm2 = turf.area(g.union) / 1e6;
  const sumKm2 = g.circles.reduce((s, c) => s + turf.area(c.zone) / 1e6, 0);
  assert.ok(unionKm2 < sumKm2, "overlapping circles must merge, so the union is smaller than the sum");
  assert.ok(unionKm2 > sumKm2 * 0.5, "but not collapse — one of the three is separate");
});

test("style 'no-display' draws nothing at all", () => {
  const g = zoneRenderGeometry(someStations(), 1000, "no-display");
  assert.deepEqual(g.circles, []);
  assert.deepEqual(g.points, []);
  assert.equal(g.union, null);
});

test("with no radius, every style falls back to points", () => {
  for (const style of ["zones", "no-overlap"]) {
    const g = zoneRenderGeometry(someStations(), 0, style);
    assert.equal(g.style, "stations", `${style} must degrade to points when there is no zone`);
    assert.equal(g.points.length, 3);
  }
});

test("stations with unusable coordinates are dropped from the render, not drawn at 0,0", () => {
  const g = zoneRenderGeometry([{ id: "x", lat: NaN, lng: 72 }, ...someStations()], 1000, "zones");
  assert.equal(g.points.length, 3, "the malformed station must not become a circle in the Atlantic");
});

// ---- Item N: per-zone drill-down ----------------------------------------

// The question a seeker actually asks late in a game, once the shading has stopped being the
// useful representation: "if they're at THIS station, what does the board say?" The valuable
// half is the list of questions that rule the zone out — a zone can be eliminated by the
// COMBINATION of two questions while neither does it alone, and the map cannot show that.
