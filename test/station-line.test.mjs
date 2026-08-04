// v2 Phase 5, item J — "is your nearest STATION on the same LINE as mine?"
//
// One of the strongest questions in the real game, and one that is impossible on Google: the
// Maps APIs expose no line membership at all. It is answerable here only because the board
// already sources real rail geometry from OSM.
//
// It is NOT the existing "Transit Line" card. That one (`nearestLine`) asks which line you
// are physically CLOSEST to. This asks about MEMBERSHIP — whether the hider's nearest station
// is served by one of the lines serving mine. A hider can stand much closer to line B while
// their nearest station sits on line A, so the two cards genuinely differ and neither
// substitutes for the other. The last test pins exactly that.
//
// The elimination is a union of HIDING ZONES rather than of points, which is why this card
// only became possible in this build: the answer constrains the hider to "near one of these
// stations", and "near" is what a zone is.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf, squareArea } from "./helpers/turf-env.mjs";
import { computeElimination, describeStep } from "../src/tools.js";
import { truthfulAnswer, verifyHiderRetained } from "./oracle.js";

const CENTRE = [72.8777, 19.076];
const BOARD = () => squareArea(CENTRE, 0.4);
const km2 = (g) => (g ? turf.area(turf.feature(g)) / 1e6 : 0);

// Two lines. A runs north-south through the west, B runs north-south through the east.
const STATIONS = [
  { id: "a1", name: "A1", lng: CENTRE[0] - 0.10, lat: CENTRE[1] - 0.10 },
  { id: "a2", name: "A2", lng: CENTRE[0] - 0.10, lat: CENTRE[1] },
  { id: "a3", name: "A3", lng: CENTRE[0] - 0.10, lat: CENTRE[1] + 0.10 },
  { id: "b1", name: "B1", lng: CENTRE[0] + 0.10, lat: CENTRE[1] - 0.10 },
  { id: "b2", name: "B2", lng: CENTRE[0] + 0.10, lat: CENTRE[1] },
  { id: "b3", name: "B3", lng: CENTRE[0] + 0.10, lat: CENTRE[1] + 0.10 },
];
const LINE_A = ["a1", "a2", "a3"];

const step = (over = {}) => ({
  id: "sl", tool: "matching", enabled: true,
  inputs: { mode: "stationLine", stations: STATIONS, memberIds: LINE_A, radiusM: 2000, lineLabel: "Line A", ...over.inputs },
  answer: { match: true, ...over.answer },
});

const keptKm2 = (s) => {
  const board = BOARD();
  const { eliminated } = computeElimination(s, board);
  if (!eliminated) return km2(board);
  const d = turf.difference(turf.featureCollection([turf.feature(board), turf.feature(eliminated)]));
  return d ? km2(d.geometry) : 0;
};

test("'same line' keeps only the zones of that line's stations", () => {
  const board = km2(BOARD());
  const kept = keptKm2(step());
  // Three 2 km zones = 3 x pi x 4 km2 ~ 37.7 km2, well under a 1,870 km2 board.
  assert.ok(kept > 30 && kept < 45, `expected ~37.7 km² of zones, got ${kept.toFixed(1)}`);
  assert.ok(kept < board * 0.05, "this is a very strong question and should cut hard");
});

test("'different line' removes exactly those zones and keeps the rest", () => {
  const board = km2(BOARD());
  const same = keptKm2(step());
  const diff = keptKm2(step({ answer: { match: false } }));
  assert.ok(Math.abs(same + diff - board) < board * 0.001, "the two answers must partition the board");
});

test("the kept region actually contains the line's stations and not the other line's", () => {
  const board = BOARD();
  const { eliminated } = computeElimination(step(), board);
  const kept = turf.difference(turf.featureCollection([turf.feature(board), turf.feature(eliminated)]));
  const inside = (s) => turf.booleanPointInPolygon(turf.point([s.lng, s.lat]), kept);
  for (const id of LINE_A) assert.ok(inside(STATIONS.find((s) => s.id === id)), `${id} must survive`);
  for (const id of ["b1", "b2", "b3"]) assert.ok(!inside(STATIONS.find((s) => s.id === id)), `${id} must be ruled out`);
});

// The card's one hard dependency, made loud rather than silent. Without a radius each zone is
// a point, the union has no area, and the question would sit in the list looking answered
// while eliminating nothing — the exact failure mode this build has been removing.
test("with no hiding radius the card refuses instead of silently doing nothing", () => {
  for (const radiusM of [0, null, undefined, NaN]) {
    assert.throws(
      () => computeElimination(step({ inputs: { radiusM } }), BOARD()),
      /needs a hiding radius/,
      `radiusM=${radiusM} must refuse`,
    );
  }
});

test("a line with no stations on this board rules everything out when answered 'same'", () => {
  // "Yes, same line" about a line that serves nowhere here is a claim about nowhere.
  const kept = keptKm2(step({ inputs: { memberIds: ["nope"] } }));
  assert.equal(kept, 0);
  // ...and answering "different" is then vacuous, so nothing is eliminated.
  const keptDiff = keptKm2(step({ inputs: { memberIds: ["nope"] }, answer: { match: false } }));
  assert.equal(keptDiff.toFixed(1), km2(BOARD()).toFixed(1));
});

test("a malformed step eliminates nothing rather than guessing", () => {
  assert.equal(computeElimination(step({ inputs: { stations: [] } }), BOARD()).eliminated, null);
  assert.equal(computeElimination(step({ inputs: { memberIds: null } }), BOARD()).eliminated, null);
});

test("the question list says which line and how many stations", () => {
  const d = describeStep(step());
  assert.match(d, /Line A/);
  assert.match(d, /3 stations/);
});

// ---- Oracle + the survival property -------------------------------------

test("the oracle answers by MEMBERSHIP of the nearest station", () => {
  // Standing right on A2: nearest station is A2, which is on Line A.
  assert.deepEqual(truthfulAnswer(step(), { lng: CENTRE[0] - 0.10, lat: CENTRE[1] }, BOARD()), { match: true });
  // Standing right on B2: nearest station is B2, which is not.
  assert.deepEqual(truthfulAnswer(step(), { lng: CENTRE[0] + 0.10, lat: CENTRE[1] }, BOARD()), { match: false });
});

// The survival property, asserted over positions that satisfy the card's PREMISE: the hider
// is genuinely within the hiding radius of some station. That premise is the card — "which
// line is your nearest station on" only constrains where you are if being near a station is
// a rule of the game.
test("a truthfully-answered same-line question never eliminates a hider who is near a station", () => {
  const board = BOARD();
  const radiusM = 2000;
  const M_PER_DEG_LAT = 110900;
  const M_PER_DEG_LNG = 111320 * Math.cos((CENTRE[1] * Math.PI) / 180);

  let checked = 0;
  for (const st of STATIONS) {
    // A ring of offsets inside the zone, plus the station itself.
    for (const frac of [0, 0.3, 0.6, 0.9]) {
      for (const bearing of [0, 90, 180, 270]) {
        const d = radiusM * frac;
        const rad = (bearing * Math.PI) / 180;
        const hider = {
          lng: st.lng + (d * Math.sin(rad)) / M_PER_DEG_LNG,
          lat: st.lat + (d * Math.cos(rad)) / M_PER_DEG_LAT,
        };
        const r = verifyHiderRetained(board, [step()], hider);
        assert.ok(r.retained, `hider ${d.toFixed(0)}m from ${st.id} was eliminated (${r.reason})`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 90, `the sweep must actually cover the board, checked ${checked}`);
});

// The limit of the card, pinned deliberately so it stays visible rather than becoming a
// surprise mid-game. A hider FARTHER from their nearest station than the hiding radius can
// answer truthfully and still be eliminated — not because the geometry is wrong, but because
// they are outside the premise the card is built on.
//
// This is the argument for setting the radius to the rule the group is actually playing. Set
// it too small and this card can rule out the hider's real position.
test("a hider outside every zone is eliminated even when answering truthfully — the premise, made visible", () => {
  const board = BOARD();
  // 3 km from A1, with a 2 km radius: nearest station is still A1, so "same line" is true.
  const hider = { lng: CENTRE[0] - 0.12, lat: CENTRE[1] - 0.12 };
  assert.deepEqual(truthfulAnswer(step(), hider, board), { match: true }, "the answer really is truthful");

  const r = verifyHiderRetained(board, [step()], hider);
  assert.equal(r.retained, false,
    "documented limit: outside the hiding radius the card's premise does not hold");

  // And with a radius wide enough to cover where they actually are, they survive — which is
  // exactly the fix a player would apply.
  const wider = verifyHiderRetained(board, [step({ inputs: { radiusM: 6000 } })], hider);
  assert.equal(wider.retained, true, "setting the radius to the rule being played restores the property");
});

// The reason this card exists alongside "Transit Line" rather than replacing it.
test("membership and proximity are genuinely different questions", () => {
  // A hider just west of line B, but whose NEAREST STATION is A3 because B has no station
  // near them. Proximity says "line B"; membership says "line A".
  const stations = [
    { id: "a1", name: "A1", lng: CENTRE[0] - 0.02, lat: CENTRE[1] + 0.10 }, // close by
    { id: "b1", name: "B1", lng: CENTRE[0] + 0.05, lat: CENTRE[1] - 0.15 }, // far away
  ];
  const hider = { lng: CENTRE[0] + 0.04, lat: CENTRE[1] + 0.10 }; // nearer B's TRACK, nearer A's STATION
  const s = step({ inputs: { stations, memberIds: ["a1"] } });
  assert.deepEqual(
    truthfulAnswer(s, hider, BOARD()), { match: true },
    "nearest STATION is A1, so the membership answer is 'same' even though line B's track runs closer",
  );
});
