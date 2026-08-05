// Station's Line after the station list was discarded.
//
// The card used to require a locked, board-wide station set built before the game started.
// It now sources stations per question — pick a line, look up the stations on it, confirm
// them — so the step it commits carries ONLY the stations on that line, where it used to
// carry the whole board plus a `memberIds` subset.
//
// That is a change to what gets written into every saved game and share link, and the thing
// that must not change with it is the geometry. Two properties matter:
//
//   1. a step built the new way eliminates EXACTLY the same ground as the old way
//   2. a step saved the old way still recomputes correctly — games saved before this,
//      and share links already sent, must keep working
//
// Both hold for the same reason: matchingStationLine filters `stations` by `memberIds` and
// never looks at the rest, so the non-member stations the old shape carried were always
// dead weight. These tests pin that rather than trusting the reading.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf, squareArea } from "./helpers/turf-env.mjs";
import { computeElimination } from "../src/tools.js";
import { truthfulAnswer, verifyHiderRetained } from "./oracle.js";

const CENTRE = [72.8777, 19.076];
const BOARD = () => squareArea(CENTRE, 0.4);
const km2 = (g) => (g ? turf.area(turf.feature(g)) / 1e6 : 0);

// Line A in the west, line B in the east, plus two stations on neither.
const ON_LINE_A = [
  { id: "a1", name: "A1", lng: CENTRE[0] - 0.10, lat: CENTRE[1] - 0.10 },
  { id: "a2", name: "A2", lng: CENTRE[0] - 0.10, lat: CENTRE[1] },
  { id: "a3", name: "A3", lng: CENTRE[0] - 0.10, lat: CENTRE[1] + 0.10 },
];
const ELSEWHERE = [
  { id: "b1", name: "B1", lng: CENTRE[0] + 0.10, lat: CENTRE[1] - 0.10 },
  { id: "b2", name: "B2", lng: CENTRE[0] + 0.10, lat: CENTRE[1] },
  { id: "c1", name: "C1", lng: CENTRE[0] + 0.15, lat: CENTRE[1] + 0.15 },
];

const RADIUS_M = 2000;

// What the card writes NOW: only the confirmed stations, every one of them a member.
const newShape = (match) => ({
  id: "sl", tool: "matching", enabled: true,
  inputs: {
    mode: "stationLine", stations: ON_LINE_A, memberIds: ON_LINE_A.map((s) => s.id),
    radiusM: RADIUS_M, lineLabel: "Line A",
  },
  answer: { match },
});

// What it wrote BEFORE: the whole locked set, with the members named separately.
const oldShape = (match) => ({
  id: "sl", tool: "matching", enabled: true,
  inputs: {
    mode: "stationLine", stations: [...ON_LINE_A, ...ELSEWHERE], memberIds: ON_LINE_A.map((s) => s.id),
    radiusM: RADIUS_M, lineLabel: "Line A",
  },
  answer: { match },
});

for (const match of [true, false]) {
  const answer = match ? "same line" : "different line";

  test(`"${answer}": the self-sourced step eliminates exactly what the old whole-board step did`, () => {
    const board = BOARD();
    const fresh = computeElimination(newShape(match), board).eliminated;
    const saved = computeElimination(oldShape(match), board).eliminated;

    assert.ok(fresh, "the new shape must produce an elimination");
    assert.ok(saved, "the old shape must still produce one");

    // Compare by symmetric difference rather than area alone: two different regions can
    // share an area, and "same size" is not the claim being made here.
    const diff = turf.difference(turf.featureCollection([turf.feature(fresh), turf.feature(saved)]));
    const rdiff = turf.difference(turf.featureCollection([turf.feature(saved), turf.feature(fresh)]));
    const strayKm2 = km2(diff?.geometry) + km2(rdiff?.geometry);
    assert.ok(strayKm2 < 1e-6, `the two shapes must eliminate the same ground (differed by ${strayKm2} km²)`);
  });
}

test("carrying only the members is not what makes it work — the filter is", () => {
  // Guards the equivalence above from passing for the wrong reason. If matchingStationLine
  // ever started using the non-member stations, the two shapes would diverge and the tests
  // above would catch it — but only if the fixtures actually differ. Assert that they do.
  assert.notEqual(
    newShape(true).inputs.stations.length,
    oldShape(true).inputs.stations.length,
    "the fixtures must differ in what they carry, or the equivalence test proves nothing",
  );
  assert.equal(newShape(true).inputs.stations.length, 3);
  assert.equal(oldShape(true).inputs.stations.length, 6);
});

test("a truthfully-answered self-sourced question never eliminates a hider near a line station", () => {
  // The card's premise: sound only while the hider is genuinely within radiusM of one of the
  // stations the question is about. Sweep positions that satisfy it — near a MEMBER station,
  // where "same line" is the truthful answer — and check the property the app rests on.
  const board = BOARD();
  let checked = 0;
  for (const st of ON_LINE_A) {
    for (const [dLng, dLat] of [[0, 0], [0.005, 0], [0, 0.005], [-0.005, -0.005], [0.01, 0.01]]) {
      const hider = { lng: st.lng + dLng, lat: st.lat + dLat };
      const base = newShape(true);
      const answer = truthfulAnswer(base, hider, board);
      if (!answer) continue;
      const r = verifyHiderRetained(board, [{ ...base, answer }], hider);
      assert.ok(r.retained, `hider at ${hider.lng},${hider.lat} was eliminated by a truthful answer`);
      checked++;
    }
  }
  assert.ok(checked > 10, `expected a real sweep, checked only ${checked} positions`);
});

test("the oracle cannot answer a self-sourced step for a hider whose nearest station is off the line", () => {
  // A real consequence of carrying only the members, found by this suite failing, and worth
  // pinning rather than quietly sweeping around.
  //
  // The oracle derives "same line?" by finding the hider's nearest station among
  // `inputs.stations` and testing its membership. When the step carried the WHOLE board that
  // worked for any hider. Carrying only the members leaves the oracle with a partial world:
  // for a hider standing at B1 it sees only line A's stations, picks the nearest of those,
  // and reports "same line" — which is false, and the app then correctly eliminates them.
  //
  // This costs the APP nothing: a human answers this question, and a human knows their own
  // nearest station whether or not it is in the step. What it costs is TEST reach — the
  // "different line" case is no longer oracle-derivable from a self-sourced step, and is
  // covered instead by test/station-line.test.mjs, whose fixtures carry the full board.
  const board = BOARD();
  const hiderAtB1 = { lng: ELSEWHERE[0].lng, lat: ELSEWHERE[0].lat };
  const base = newShape(true);

  const answer = truthfulAnswer(base, hiderAtB1, board);
  assert.deepEqual(answer, { match: true },
    "the oracle sees only line A's stations, so it reports 'same line' for a hider on line B");

  const r = verifyHiderRetained(board, [{ ...base, answer }], hiderAtB1);
  assert.equal(r.retained, false,
    "and the app is right to eliminate them — the answer it was given was false. This asserts " +
    "the LIMIT of the harness, not a defect in the card: a real hider would have said " +
    "'different line'.");
});

test("a hand-added station with a manual id is treated like any other member", () => {
  // The confirm step lets a seeker tap in a station the lookup missed; it gets a synthetic
  // `manual:` id rather than an OSM one. Nothing may key off the id's shape.
  const manual = { id: "manual:abc123_3", name: "Station 4", lng: CENTRE[0] - 0.10, lat: CENTRE[1] + 0.05 };
  const withManual = {
    id: "sl", tool: "matching", enabled: true,
    inputs: {
      mode: "stationLine", stations: [...ON_LINE_A, manual],
      memberIds: [...ON_LINE_A.map((s) => s.id), manual.id],
      radiusM: RADIUS_M, lineLabel: "Line A",
    },
    answer: { match: true },
  };
  const without = computeElimination(newShape(true), BOARD()).eliminated;
  const withIt = computeElimination(withManual, BOARD()).eliminated;
  assert.ok(withIt, "a manual station must not break the elimination");
  // One more kept zone => strictly LESS ground eliminated on a "same line" answer.
  assert.ok(km2(withIt) < km2(without),
    "adding a station to the line must keep more ground, not less");
});

test("an empty confirmation cannot be committed as a question", () => {
  // The UI refuses this, but the engine is what saved games run through. With no members the
  // card must not silently eliminate nothing (a question that looks answered and does
  // nothing) — matchingStationLine treats it as "a claim about nowhere".
  const empty = {
    id: "sl", tool: "matching", enabled: true,
    inputs: { mode: "stationLine", stations: [], memberIds: [], radiusM: RADIUS_M, lineLabel: "Line A" },
    answer: { match: true },
  };
  const out = computeElimination(empty, BOARD());
  assert.equal(out.eliminated, null, "no stations means no elimination, not a silent no-op elsewhere");
});
