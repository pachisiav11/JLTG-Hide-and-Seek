// F1: the "Metro Lines" tentacle was sourced as subway_station and partitioned by a Voronoi
// over STATIONS. Stations sit on lines, so it looks like a fair proxy — but wherever station
// spacing exceeds line spacing, the nearest STATION sits on a line the hider is not beside.
//
// The headline test builds exactly the doc's scenario and asserts the two partitions disagree
// about the hider — i.e. that the station proxy eliminates the hider's true position while the
// line partition keeps it. Both run against the SAME geometry, so the difference is the fix and
// not the fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { turf } from "./helpers/turf-env.mjs";
import { computeElimination, lineCells, linePaths } from "../src/tools.js";

const ORIGIN = [72.8777, 19.076];
const off = ([lng, lat], northM, eastM) => {
  let p = [lng, lat];
  if (northM) p = turf.destination(p, northM / 1000, 0, { units: "kilometers" }).geometry.coordinates;
  if (eastM) p = turf.destination(p, eastM / 1000, 90, { units: "kilometers" }).geometry.coordinates;
  return p;
};
const ll = (c) => ({ lat: c[1], lng: c[0] });

function board(sM, wM, nM, eM) {
  const sw = off(ORIGIN, sM, wM), ne = off(ORIGIN, nM, eM);
  return { type: "Polygon", coordinates: [[[sw[0], sw[1]], [ne[0], sw[1]], [ne[0], ne[1]], [sw[0], ne[1]], [sw[0], sw[1]]]] };
}
const AREA = board(-2000, -2000, 8000, 4000);
const SEEKER = ll(off(ORIGIN, 3000, 1500)); // reaches both lines

// ---- The doc's scenario, built to scale -------------------------------------------------
// Two metro lines running north, 400 m apart. Line A's stations are 3 km apart; line B's are
// offset so that beside A, mid-way between A's stations, the nearest STATION belongs to B.
const A_X = 0, B_X = 400;
const LINE_A = { id: "a", label: "Line A", coords: [ll(off(ORIGIN, 0, A_X)), ll(off(ORIGIN, 6000, A_X))] };
const LINE_B = { id: "b", label: "Line B", coords: [ll(off(ORIGIN, 0, B_X)), ll(off(ORIGIN, 6000, B_X))] };

// Stations: A at 0m and 3000m north; B at 1500m north — level with the gap in A's.
const STATIONS = [
  { name: "A1", ...ll(off(ORIGIN, 0, A_X)) },
  { name: "A2", ...ll(off(ORIGIN, 3000, A_X)) },
  { name: "B1", ...ll(off(ORIGIN, 1500, B_X)) },
];
const STATION_OWNER = ["a", "a", "b"];

// The hider: beside line A (100 m east of it, so 300 m from B), level with B's station.
const HIDER = off(ORIGIN, 1500, 100);

const lineStep = (lineIndex) => ({
  id: "s1", tool: "tentacles", enabled: true,
  inputs: { lines: [LINE_A, LINE_B], radius: 25000, center: SEEKER },
  answer: { featureIndex: lineIndex },
});
const stationStep = (stationIndex) => ({
  id: "s1", tool: "tentacles", enabled: true,
  inputs: { features: STATIONS, radius: 25000, center: SEEKER },
  answer: { featureIndex: stationIndex },
});
const eliminates = (step, pt) => {
  const { eliminated } = computeElimination(step, AREA);
  assert.ok(eliminated, "expected real geometry, not null");
  return turf.booleanPointInPolygon(turf.point(pt), eliminated);
};

test("ground truth: the hider is beside line A and nearest to a station on line B", () => {
  const dist = (ln) => turf.pointToLineDistance(turf.point(HIDER), turf.lineString(ln.coords.map((c) => [c.lng, c.lat])), { units: "meters" });
  assert.ok(dist(LINE_A) < dist(LINE_B), `hider must be nearer line A (A=${dist(LINE_A).toFixed(0)}m B=${dist(LINE_B).toFixed(0)}m)`);
  assert.ok(Math.abs(dist(LINE_A) - 100) < 10, `expected ~100m to A, got ${dist(LINE_A).toFixed(0)}`);

  // ...but the nearest STATION is B's.
  const d = (s) => turf.distance(turf.point(HIDER), turf.point([s.lng, s.lat]), { units: "meters" });
  const nearest = STATIONS.slice().sort((x, y) => d(x) - d(y))[0];
  assert.equal(STATION_OWNER[STATIONS.indexOf(nearest)], "b",
    `the fixture only proves anything if the nearest station is on line B; got ${nearest.name}`);
});

test("the station proxy eliminates the hider's true position — the F1 bug", () => {
  // The hider truthfully answers "nearest to Line A". Under the station model the seeker can
  // only record a STATION, and the honest recording of "I'm near line A" is A's nearest
  // station (A2). That keeps A2's cell — which does not contain the hider.
  const a2 = STATIONS.findIndex((s) => s.name === "A2");
  assert.equal(eliminates(stationStep(a2), HIDER), true,
    "expected the station partition to wrongly eliminate the hider; if this fails the fixture no longer reproduces F1");
});

test("the line partition keeps the hider's true position — the fix", () => {
  assert.equal(eliminates(lineStep(0), HIDER), false,
    "answering 'nearest line A' must not eliminate someone standing beside line A");
});

test("the two partitions genuinely disagree about the hider", () => {
  // Same board, same geometry, same answer-in-spirit. Only the partition differs.
  const a2 = STATIONS.findIndex((s) => s.name === "A2");
  assert.notEqual(eliminates(stationStep(a2), HIDER), eliminates(lineStep(0), HIDER));
});

// ---- lineCells contract -----------------------------------------------------------------

test("lineCells returns one cell per line and they tile the board", () => {
  const { cells } = lineCells([LINE_A, LINE_B], AREA);
  assert.equal(cells.length, 2);
  for (const c of cells) assert.ok(c, "both lines run the length of the board — neither cell can be empty");
  const areaOf = (g) => turf.area(turf.feature(g));
  const sum = areaOf(cells[0]) + areaOf(cells[1]);
  // Cells partition the board: they should sum to it and not overlap.
  assert.ok(Math.abs(sum - areaOf(AREA)) / areaOf(AREA) < 0.02, `cells should tile the board (sum ${sum} vs ${areaOf(AREA)})`);
  const overlap = turf.intersect(turf.featureCollection([turf.feature(cells[0]), turf.feature(cells[1])]));
  assert.ok(!overlap || turf.area(overlap) / areaOf(AREA) < 0.01, "cells must not overlap");
});

test("linePaths accepts both a drawn path and multi-way sourced geometry", () => {
  // Hand-drawn: one path of {lat,lng}. Auto-sourced: many [lat,lng] ways that needn't join.
  assert.deepEqual(linePaths({ coords: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }] }), [[{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }]]);
  assert.deepEqual(linePaths({ paths: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]] }),
    [[{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }], [{ lat: 5, lng: 6 }, { lat: 7, lng: 8 }]]);
  // Degenerate shapes are dropped, not passed on to make a 1-point "line".
  assert.deepEqual(linePaths({ paths: [[[1, 2]]] }), []);
  assert.deepEqual(linePaths({}), []);
  assert.deepEqual(linePaths(null), []);
});

test("a multi-way line is one choice, not one per way", () => {
  // An auto-sourced metro line arrives as many OSM ways. Splitting line A into two disjoint
  // ways must not change the partition — otherwise every way would compete as its own line.
  const split = {
    id: "a", label: "Line A",
    paths: [
      [[off(ORIGIN, 0, A_X)[1], off(ORIGIN, 0, A_X)[0]], [off(ORIGIN, 2500, A_X)[1], off(ORIGIN, 2500, A_X)[0]]],
      [[off(ORIGIN, 2500, A_X)[1], off(ORIGIN, 2500, A_X)[0]], [off(ORIGIN, 6000, A_X)[1], off(ORIGIN, 6000, A_X)[0]]],
    ],
  };
  const step = { id: "s1", tool: "tentacles", enabled: true, inputs: { lines: [split, LINE_B], radius: 25000, center: SEEKER }, answer: { featureIndex: 0 } };
  assert.equal(eliminates(step, HIDER), false, "the split line must behave exactly like the whole one");
});

test("a lines tentacle still handles the miss case as a radar miss", () => {
  const step = { id: "s1", tool: "tentacles", enabled: true, inputs: { lines: [LINE_A, LINE_B], radius: 1200, center: SEEKER }, answer: { none: true } };
  const { eliminated } = computeElimination(step, AREA);
  assert.ok(eliminated, "a miss eliminates the seeker's reach circle");
  assert.equal(turf.booleanPointInPolygon(turf.point([SEEKER.lng, SEEKER.lat]), eliminated), true,
    "the seeker's own position is inside the eliminated circle");
});

test("one line means the card only tells you 'within reach' — §F3's mega-relation symptom", () => {
  // Reachable whenever a board has a single line on it, which is what a system tagged as one
  // mega-relation would collapse to. With one candidate every point in reach is nearest to
  // it, so the ONLY information left is "within R of the seeker" — the card stops
  // discriminating between lines entirely. It must still be correct, just uninformative.
  //
  // Radius deliberately smaller than the board: at the card's real 25 km the reach circle
  // swallows this 10x6 km board whole and there is nothing to eliminate at all.
  const R = 3000;
  const step = { id: "s1", tool: "tentacles", enabled: true, inputs: { lines: [LINE_A], radius: R, center: SEEKER }, answer: { featureIndex: 0 } };
  const { eliminated } = computeElimination(step, AREA);
  assert.ok(eliminated, "should eliminate everything outside the reach");

  const distToSeeker = (p) => turf.distance(turf.point([SEEKER.lng, SEEKER.lat]), turf.point(p), { units: "meters" });
  assert.ok(distToSeeker(HIDER) < R, `fixture: the hider must be inside the reach (${distToSeeker(HIDER).toFixed(0)}m)`);
  assert.equal(turf.booleanPointInPolygon(turf.point(HIDER), eliminated), false, "in reach and nearest the only line — kept");

  const far = off(ORIGIN, 7000, 3500);
  assert.ok(distToSeeker(far) > R, `fixture: the far probe must be outside the reach (${distToSeeker(far).toFixed(0)}m)`);
  assert.equal(turf.booleanPointInPolygon(turf.point(far), eliminated), true, "out of reach — eliminated");
});
