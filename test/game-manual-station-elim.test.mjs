// Phase 6 game test: A3 manual station elimination via the map marker.
//
// The playtest scenario: seekers see a photo of a building (Q4). It's not near
// two of their candidate stations. Before Phase 6, they'd list candidates by
// hand — no map interaction, no persisted state. After Phase 6, one tap on
// each ruled-out marker records the decision on the map, on the same
// eliminated/eliminatedBy fields the Stations panel and A4 line-elim use.
//
// The exercised helper is `toggleStationElimination` — the pure mutator the
// on-map marker's click handler calls. Tests here cover:
//   - baseline toggle behaviour
//   - the "manual wins over line-tag" convention
//   - idempotence + round-trip through save/reload
//   - the "N of Y" preview counter (Phase 2) adjusts as expected
import test from "node:test";
import assert from "node:assert/strict";
import { squareArea } from "./helpers/turf-env.mjs";
import { createGame, normalizeGame } from "../src/model.js";
import { toggleStationElimination, countStationsInEliminated } from "../src/stations.js";
import { computeElimination } from "../src/tools.js";

const AREA = squareArea([72.8777, 19.176], 0.4);

const STATIONS = () => [
  { id: "osm:node/1", name: "Devipada",  lat: 19.24, lng: 72.87 },
  { id: "osm:node/2", name: "Dahisar",   lat: 19.25, lng: 72.86 },
  { id: "osm:node/3", name: "Andheri",   lat: 19.12, lng: 72.85 },
  { id: "osm:node/4", name: "Jogeshwari",lat: 19.14, lng: 72.85 },
];

test("game 1: a tap eliminates; a second tap restores", () => {
  const list = STATIONS();
  const first = toggleStationElimination(list, "osm:node/3");
  assert.equal(first.eliminated, true);
  assert.equal(list[2].eliminated, true);
  assert.equal(list[2].eliminatedBy, "manual");
  const second = toggleStationElimination(list, "osm:node/3");
  assert.equal(second.eliminated, false);
  assert.equal(list[2].eliminatedBy, null, "restore clears the manual tag");
});

test("game 2: a manual tap on a line-tagged station overrides the tag — playtest deduction wins over bulk rule", () => {
  // Seeker has already ruled out "not the blue line" (A4), which tagged Andheri
  // as `line:subway:1`. A minute later a photo appears that also happens to
  // rule Andheri out for a different reason. Tapping the marker should not
  // silently keep it under the line's rule — the manual tap is a fresh
  // decision by the seeker and must own the flag from here on.
  const list = STATIONS();
  list[2].eliminated = true;
  list[2].eliminatedBy = "line:subway:1";
  toggleStationElimination(list, "osm:node/3"); // taps the marker → restores
  assert.equal(list[2].eliminated, false);
  assert.equal(list[2].eliminatedBy, null);
  // Now tap again to re-eliminate manually.
  toggleStationElimination(list, "osm:node/3");
  assert.equal(list[2].eliminatedBy, "manual", "the manual tap owns it, not the (stale) line tag");
});

test("game 3: an id that isn't in the list returns null and doesn't crash", () => {
  const list = STATIONS();
  assert.equal(toggleStationElimination(list, "osm:node/999"), null);
  assert.equal(toggleStationElimination(null, "osm:node/1"), null);
});

test("game 4: manual eliminations survive save/reload (game.stations persists)", () => {
  const g = createGame({ name: "Playtest replay", gameArea: AREA, stations: { source: "osm", bbox: null, confirmedAt: 1000, list: STATIONS() } });
  toggleStationElimination(g.stations.list, "osm:node/1");
  toggleStationElimination(g.stations.list, "osm:node/2");
  const reopened = normalizeGame(JSON.parse(JSON.stringify(g)));
  const kept = reopened.stations.list.filter((s) => s.eliminated).map((s) => s.name).sort();
  assert.deepEqual(kept, ["Dahisar", "Devipada"]);
});

test("game 5: manual eliminations narrow the Phase-2 draft-preview denominator", () => {
  // The 'N of Y' counter uses countStationsInEliminated, which drops already-
  // eliminated stations from Y. Two taps → Y drops by 2. Proves the map
  // interaction and the panel preview see the same eliminated set.
  const list = STATIONS();
  const step = { id: "draft", tool: "radar", enabled: true, inputs: { center: { lat: 19.12, lng: 72.85 }, radius: 3000 }, answer: { side: "in" } };
  const before = countStationsInEliminated(computeElimination(step, AREA).eliminated, list);
  assert.equal(before.total, 4);
  toggleStationElimination(list, "osm:node/1");
  toggleStationElimination(list, "osm:node/2");
  const after = countStationsInEliminated(computeElimination(step, AREA).eliminated, list);
  assert.equal(after.total, 2, "the two eliminated stations must drop out of the Y denominator");
});
