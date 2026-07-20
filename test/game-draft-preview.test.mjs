// Phase 2 game test: the B1 draft-mode preview counts stations correctly for a
// radar or thermometer that has not yet been committed.
//
// The playtest question this exists to answer: "if we put a 5 km radar here and the
// hider is IN it, how many of our surviving stations does that leave?" — before
// commit, so a "too tight" or "too loose" pick can be corrected instead of costing
// a whole question.
//
// The preview is a UI overlay in layers.js, but the number it shows comes from
// `countStationsInEliminated` — a pure function. This test drives it end to end on
// a real Mumbai-scale board with a real fold step (via computeElimination), so if
// the number in the sheet lies about the impact, one of these assertions fails.
import test from "node:test";
import assert from "node:assert/strict";
import { squareArea } from "./helpers/turf-env.mjs";
import { computeElimination } from "../src/tools.js";
import { countStationsInEliminated } from "../src/stations.js";

// 0.4° square around Mumbai — wide enough to include the northern stations
// (Dahisar and Devipada sit at ~19.24-25 N, north of a 0.2° box centred on 19.076).
const AREA = squareArea([72.8777, 19.176], 0.4);

// The eight-station Mumbai locked set from Phase 1's game test.
const STATIONS = [
  { id: "osm:node/100", name: "Devipada",  lat: 19.2400, lng: 72.8700, kind: "halt" },
  { id: "osm:node/101", name: "Dahisar",   lat: 19.2500, lng: 72.8600, kind: "station" },
  { id: "osm:node/102", name: "Kandivali", lat: 19.2050, lng: 72.8500, kind: "station" },
  { id: "osm:node/103", name: "Borivali",  lat: 19.2280, lng: 72.8570, kind: "station" },
  { id: "osm:node/104", name: "Malad",     lat: 19.1870, lng: 72.8480, kind: "station" },
  { id: "osm:node/105", name: "Goregaon",  lat: 19.1650, lng: 72.8500, kind: "station" },
  { id: "osm:node/106", name: "Jogeshwari",lat: 19.1370, lng: 72.8480, kind: "station" },
  { id: "osm:node/107", name: "Andheri",   lat: 19.1200, lng: 72.8460, kind: "station" },
];

// A draft radar step, as the sheet would construct one before commit.
const draftRadar = (center, radiusM, side = "in") => ({
  id: "draft", tool: "radar", enabled: true,
  inputs: { center, radius: radiusM }, answer: { side },
});

test("game 1: a 3 km radar around Andheri would eliminate ~1-2 stations (Jogeshwari + Andheri)", () => {
  // The playtest ended with "5 km radar → hit" locking to Devipada. This test does
  // the same shape of reasoning: a small radar centred near the hider narrows the
  // active set to a handful.
  const step = draftRadar({ lat: 19.1200, lng: 72.8460 }, 3000, "in"); // Andheri, "hider is inside"
  const { eliminated } = computeElimination(step, AREA);
  // "in" answer eliminates the ground OUTSIDE the circle, which contains 6 of the 8
  // stations — Andheri and Jogeshwari are the only ones within 3 km.
  const out = countStationsInEliminated(eliminated, STATIONS);
  assert.ok(out, "the preview must return a count for a real gameArea + station set");
  assert.equal(out.total, 8, "8 stations, none pre-eliminated → denominator = 8");
  assert.equal(out.inside, 6, "6 stations OUTSIDE the 3 km circle would be eliminated by an 'inside' answer");
});

test("game 2: same radar with side=out eliminates the interior — the other 2 stations", () => {
  // Same size, opposite answer: shows the seeker both branches so they can pick.
  const step = draftRadar({ lat: 19.1200, lng: 72.8460 }, 3000, "out");
  const { eliminated } = computeElimination(step, AREA);
  const out = countStationsInEliminated(eliminated, STATIONS);
  assert.equal(out.total, 8);
  assert.equal(out.inside, 2, "2 stations INSIDE the 3 km circle (Andheri + Jogeshwari) would be eliminated by an 'outside' answer");
});

test("game 3: growing the radius eliminates strictly more on the same side — proves the preview reacts to size", () => {
  // The playtest scenario: seeker unsure if 5 or 10 km is right. Watching the count
  // change as they type is exactly what would have let them pick the useful size.
  const center = { lat: 19.1200, lng: 72.8460 };
  const smaller = countStationsInEliminated(computeElimination(draftRadar(center, 1000, "out"), AREA).eliminated, STATIONS);
  const larger  = countStationsInEliminated(computeElimination(draftRadar(center, 8000, "out"), AREA).eliminated, STATIONS);
  assert.ok(larger.inside >= smaller.inside, `growing the radius (1 km → 8 km) must not shrink the 'inside' count (${smaller.inside} vs ${larger.inside})`);
  assert.ok(larger.inside > smaller.inside, `8 km around Andheri sweeps in more stations than 1 km (was ${smaller.inside}, ${larger.inside})`);
});

test("game 4: a pre-eliminated station is dropped from the denominator", () => {
  // Q0 in the playtest: "not past Dahisar" — the seeker marked Dahisar out. From then
  // on the "of Y" denominator should be 7, not 8.
  const stationsAfterQ0 = STATIONS.map((s) => (s.name === "Dahisar" ? { ...s, eliminated: true } : s));
  const step = draftRadar({ lat: 19.1200, lng: 72.8460 }, 3000, "in");
  const { eliminated } = computeElimination(step, AREA);
  const out = countStationsInEliminated(eliminated, stationsAfterQ0);
  assert.equal(out.total, 7, "already-eliminated Dahisar must not count in the denominator");
});

test("game 5: no station set returns null — the preview must not lie with a fake number", () => {
  // A game where the user hasn't materialised a station set yet: the preview should
  // fall back to a "no station set — see Stations" message, not print "0 of 0".
  const step = draftRadar({ lat: 19.1200, lng: 72.8460 }, 3000, "in");
  const { eliminated } = computeElimination(step, AREA);
  assert.equal(countStationsInEliminated(eliminated, []), null);
  assert.equal(countStationsInEliminated(eliminated, null), null);
});

test("game 6: a thermometer draft splits the board — station counts add up to the total", () => {
  // Draft thermometer between two Mumbai locations. The "hotter" and "colder" answers
  // partition the board, so the two counts must sum to (roughly) the total — with the
  // 'edge' stations counted in one side or the other but not both. This is the sanity
  // check that thermometer previews are computing the right partition, not a random
  // shape.
  const a = { lat: 19.10, lng: 72.85 };
  const b = { lat: 19.20, lng: 72.85 };
  const draftTh = (side) => ({ id: "draft", tool: "thermometer", enabled: true, inputs: { a, b }, answer: { side } });
  const hotter = countStationsInEliminated(computeElimination(draftTh("hotter"), AREA).eliminated, STATIONS);
  const colder = countStationsInEliminated(computeElimination(draftTh("colder"), AREA).eliminated, STATIONS);
  assert.ok(hotter && colder);
  // Both sides denominate against the same 8 active stations.
  assert.equal(hotter.total, 8);
  assert.equal(colder.total, 8);
  // Every station falls on one side of the bisector, so the two eliminated-inside
  // counts partition the set: their sum equals the total.
  assert.equal(hotter.inside + colder.inside, STATIONS.length,
    `${hotter.inside} + ${colder.inside} should partition ${STATIONS.length} stations across the bisector`);
});
