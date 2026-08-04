// v2 Phase 3, item L — a station survives if ANY part of its hiding zone survives.
//
// The bug this fixes is a false elimination, which is the only kind that loses a game rather
// than costing a turn. `countStationsInEliminated` decided a station was ruled out when its
// exact coordinate fell inside the eliminated region. That is right only if the hider is
// standing precisely on the station. They are hiding WITHIN a radius of it, so a station
// whose point is eliminated but whose surrounding ground is partly untouched was being ruled
// out with the hider standing in the part that survived.
//
// These tests are built around that specific geometry: a station near the edge of an
// elimination, where the point rule and the zone rule disagree. If they ever stop
// disagreeing, the first test fails and says so — the whole module would then be pointless.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf, squareArea } from "./helpers/turf-env.mjs";
import {
  zoneFor, zoneSurvives, splitByZoneSurvival,
  countStationsEliminatedByZone, zoneRenderGeometry,
} from "../src/hiding-zones.js";
import { countStationsInEliminated } from "../src/stations.js";

const CENTRE = [72.8777, 19.076];
const BOARD = () => squareArea(CENTRE, 0.4);

// "hider is INSIDE this circle" — eliminates everything outside it.
const radarStepIn = (id, center, radiusM) => ({
  id, tool: "radar", enabled: true,
  inputs: { center: { lng: center[0], lat: center[1] }, radius: radiusM },
  answer: { side: "in" },
});

// A half-board active area: everything EAST of the centre meridian survives.
const eastHalf = () => turf.polygon([[
  [CENTRE[0], CENTRE[1] - 0.2], [CENTRE[0] + 0.2, CENTRE[1] - 0.2],
  [CENTRE[0] + 0.2, CENTRE[1] + 0.2], [CENTRE[0], CENTRE[1] + 0.2], [CENTRE[0], CENTRE[1] - 0.2],
]]).geometry;

// Metres of longitude at this latitude, so a station can be placed a known distance west of
// the surviving edge — the whole point is to straddle it by less than the zone radius.
const M_PER_DEG_LNG = 111320 * Math.cos((CENTRE[1] * Math.PI) / 180);

test("the headline case: a station just outside the surviving area keeps its zone alive", () => {
  const active = eastHalf();
  // 300 m WEST of the boundary: its point is eliminated, but a 1 km zone reaches across.
  const station = { id: "s1", name: "Edge", lat: CENTRE[1], lng: CENTRE[0] - 300 / M_PER_DEG_LNG };

  // The old rule rules it out...
  assert.equal(
    turf.booleanPointInPolygon(turf.point([station.lng, station.lat]), turf.feature(active)), false,
    "sanity: the station's own point does not survive",
  );
  // ...the zone rule does not, because the hider could be standing 400 m east of it.
  assert.equal(zoneSurvives(active, station, 1000), true, "a 1 km zone reaches into the surviving area");

  // And with a zone too small to reach, both rules agree again.
  assert.equal(zoneSurvives(active, station, 100), false, "a 100 m zone does not reach");
});

test("radius 0 degenerates to exactly the old point rule", () => {
  const active = eastHalf();
  const west = { id: "w", lat: CENTRE[1], lng: CENTRE[0] - 0.05 };
  const east = { id: "e", lat: CENTRE[1], lng: CENTRE[0] + 0.05 };
  for (const r of [0, null, undefined, NaN]) {
    assert.equal(zoneSurvives(active, west, r), false, `r=${r}: west of the line is eliminated`);
    assert.equal(zoneSurvives(active, east, r), true, `r=${r}: east of the line survives`);
  }
});

test("a station well inside the surviving area survives at any radius", () => {
  const active = eastHalf();
  const deep = { id: "d", lat: CENTRE[1], lng: CENTRE[0] + 0.15 };
  for (const r of [0, 200, 1000, 5000]) {
    assert.equal(zoneSurvives(active, deep, r), true, `r=${r}`);
  }
});

test("no active area at all means nothing survives", () => {
  assert.equal(zoneSurvives(null, { lat: 19, lng: 72 }, 1000), false);
});

// The safe direction, asserted explicitly. An undecidable station must be KEPT: under-
// eliminating costs a turn, over-eliminating is the bug this module exists to remove.
test("a station with unusable coordinates is kept, not ruled out", () => {
  const active = eastHalf();
  for (const bad of [{ lat: NaN, lng: 72.9 }, { lat: 19, lng: undefined }, {}]) {
    assert.equal(zoneSurvives(active, bad, 1000), true, `${JSON.stringify(bad)} must survive`);
  }
});

test("splitByZoneSurvival keeps hand-eliminated stations eliminated", () => {
  const active = eastHalf();
  const stations = [
    { id: "live", lat: CENTRE[1], lng: CENTRE[0] + 0.1 },
    { id: "gone", lat: CENTRE[1], lng: CENTRE[0] - 0.1 },
    // Sits in the surviving half, but the seeker searched there and ruled it out by hand.
    // A manual call is an observation, not a deduction, and geometry must not resurrect it.
    { id: "searched", lat: CENTRE[1], lng: CENTRE[0] + 0.12, eliminated: true },
  ];
  const { surviving, eliminated, manual } = splitByZoneSurvival(active, stations, 500);
  assert.deepEqual(surviving.map((s) => s.id), ["live"]);
  assert.deepEqual(eliminated.map((s) => s.id), ["gone"]);
  assert.deepEqual(manual.map((s) => s.id), ["searched"]);
});

test("countStationsEliminatedByZone requires the WHOLE zone inside the proposal", () => {
  // Proposed elimination: the western half of the board.
  const proposed = turf.polygon([[
    [CENTRE[0] - 0.2, CENTRE[1] - 0.2], [CENTRE[0], CENTRE[1] - 0.2],
    [CENTRE[0], CENTRE[1] + 0.2], [CENTRE[0] - 0.2, CENTRE[1] + 0.2], [CENTRE[0] - 0.2, CENTRE[1] - 0.2],
  ]]).geometry;

  const deepWest = { id: "deep", lat: CENTRE[1], lng: CENTRE[0] - 0.1 };          // zone fully inside
  const onEdge = { id: "edge", lat: CENTRE[1], lng: CENTRE[0] - 300 / M_PER_DEG_LNG }; // zone straddles

  const r = countStationsEliminatedByZone(proposed, [deepWest, onEdge], 1000);
  assert.equal(r.total, 2);
  assert.equal(r.inside, 1, "only the station whose whole zone is inside counts as eliminated");

  // The old point-based counter claims both, which is the over-count being fixed.
  const old = countStationsInEliminated(proposed, [deepWest, onEdge]);
  assert.equal(old.inside, 2, "sanity: the point rule over-counts exactly here");
});

test("a station already ruled out by the board is not re-counted for this question", () => {
  // active = east half; the proposal is the west half, which is already all eliminated.
  const active = eastHalf();
  const proposed = turf.polygon([[
    [CENTRE[0] - 0.2, CENTRE[1] - 0.2], [CENTRE[0], CENTRE[1] - 0.2],
    [CENTRE[0], CENTRE[1] + 0.2], [CENTRE[0] - 0.2, CENTRE[1] + 0.2], [CENTRE[0] - 0.2, CENTRE[1] - 0.2],
  ]]).geometry;
  const stations = [{ id: "already", lat: CENTRE[1], lng: CENTRE[0] - 0.1 }];

  const naive = countStationsEliminatedByZone(proposed, stations, 500);
  assert.equal(naive.inside, 1, "without the active area it looks like new work");

  const honest = countStationsEliminatedByZone(proposed, stations, 500, active);
  assert.equal(honest, null, "with the active area there is nothing left for this question to do");
});

test("countStationsEliminatedByZone returns null when there is nothing to count", () => {
  const proposed = turf.polygon([[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]).geometry;
  assert.equal(countStationsEliminatedByZone(null, [{ lat: 1, lng: 1 }], 100), null);
  assert.equal(countStationsEliminatedByZone(proposed, [], 100), null);
  assert.equal(countStationsEliminatedByZone(proposed, [{ lat: 19, lng: 72, eliminated: true }], 100), null);
});

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

import { zoneDiagnosis } from "../src/hiding-zones.js";
import { computeElimination } from "../src/tools.js";

const elimFor = (board) => (step) => computeElimination(step, board).eliminated;

test("a station in the clear survives with its whole zone and blames nobody", () => {
  const board = BOARD();
  const station = { id: "clear", name: "Clear", lat: CENTRE[1] + 0.15, lng: CENTRE[0] + 0.15 };
  // The station is ~23 km from the centre, so the radar has to be wide enough to contain it —
  // a tighter one would legitimately rule it out, which is a different test.
  const steps = [radarStepIn("r", CENTRE, 40000)];
  const d = zoneDiagnosis(board, steps, station, 500, elimFor(board));
  assert.equal(d.survives, true);
  assert.ok(d.fraction > 0.99, `expected a whole zone, got ${d.fraction}`);
  assert.deepEqual(d.culprits, [], "no question touched this zone");
});

test("the question that removes the zone is named, and marked fatal", () => {
  const board = BOARD();
  // Station at the centre; a 'must be outside 5 km of centre' radar wipes its 500 m zone.
  const station = { id: "hit", name: "Hit", lat: CENTRE[1], lng: CENTRE[0] };
  const steps = [{
    id: "r1", tool: "radar", enabled: true,
    inputs: { center: { lng: CENTRE[0], lat: CENTRE[1] }, radius: 5000 },
    answer: { side: "out" }, // hider is OUTSIDE => the circle is eliminated
  }];
  const d = zoneDiagnosis(board, steps, station, 500, elimFor(board));
  assert.equal(d.survives, false);
  assert.equal(d.fraction, 0);
  assert.equal(d.culprits.length, 1);
  assert.equal(d.culprits[0].id, "r1");
  assert.equal(d.culprits[0].fatal, true, "the question that finished the zone off is flagged");
});

test("a question that eliminates elsewhere is not blamed for this zone", () => {
  const board = BOARD();
  const station = { id: "far", name: "Far", lat: CENTRE[1] + 0.15, lng: CENTRE[0] + 0.15 };
  // Wipes the middle of the board, nowhere near the station.
  const steps = [{
    id: "elsewhere", tool: "radar", enabled: true,
    inputs: { center: { lng: CENTRE[0], lat: CENTRE[1] }, radius: 4000 },
    answer: { side: "out" },
  }];
  const d = zoneDiagnosis(board, steps, station, 500, elimFor(board));
  assert.equal(d.survives, true);
  assert.deepEqual(d.culprits, [], "a question that took no ground off THIS zone is not a culprit");
});

// The case that justifies the whole function: neither question alone kills the zone.
test("two questions that only jointly eliminate a zone are both named", () => {
  const board = BOARD();
  const station = { id: "pincer", name: "Pincer", lat: CENTRE[1], lng: CENTRE[0] };
  const steps = [
    // North half eliminated.
    { id: "north", tool: "thermometer", enabled: true,
      inputs: { a: { lng: CENTRE[0], lat: CENTRE[1] - 0.1 }, b: { lng: CENTRE[0], lat: CENTRE[1] + 0.1 } },
      answer: { side: "colder" } },
    // South half eliminated.
    { id: "south", tool: "thermometer", enabled: true,
      inputs: { a: { lng: CENTRE[0], lat: CENTRE[1] - 0.1 }, b: { lng: CENTRE[0], lat: CENTRE[1] + 0.1 } },
      answer: { side: "hotter" } },
  ];
  const d = zoneDiagnosis(board, steps, station, 500, elimFor(board));
  assert.equal(d.survives, false, "together they leave nothing");
  assert.equal(d.culprits.length, 2, "both must be named — neither alone is the reason");
  assert.equal(d.culprits[0].fatal, false, "the first only took part of the zone");
  assert.equal(d.culprits[1].fatal, true, "the second finished it");
});

test("draft and disabled questions are excluded from the diagnosis", () => {
  const board = BOARD();
  const station = { id: "s", name: "S", lat: CENTRE[1], lng: CENTRE[0] };
  const kill = (id, extra) => ({
    id, tool: "radar", enabled: true,
    inputs: { center: { lng: CENTRE[0], lat: CENTRE[1] }, radius: 5000 },
    answer: { side: "out" }, ...extra,
  });
  assert.equal(zoneDiagnosis(board, [kill("d", { draft: true })], station, 500, elimFor(board)).survives, true,
    "a draft is a preview and must not rule a zone out");
  assert.equal(zoneDiagnosis(board, [kill("o", { enabled: false })], station, 500, elimFor(board)).survives, true,
    "a disabled question is not on the board");
});

test("a zone entirely off the board reports null fraction, not 0%", () => {
  const board = BOARD();
  const offBoard = { id: "off", name: "Off", lat: CENTRE[1] + 5, lng: CENTRE[0] + 5 };
  const d = zoneDiagnosis(board, [], offBoard, 500, elimFor(board));
  assert.equal(d.fraction, null, "never on the board is a different state from eliminated");
  assert.equal(d.survives, false);
});
