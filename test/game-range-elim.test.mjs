// Phase 7 game test: A5 range elimination on a line — the playtest Q0
// ("not past Dahisar / 2nd-last stop on the yellow line") reproduced end to end.
//
// The playtest had no way to say "hider is south of Dahisar." A5 turns that into
// two dropdowns and a button. This test walks the exact Q0 shape on a Mumbai-
// scale line fixture:
//   - eight stations along a north-south line
//   - "hider is between Andheri and Malad" (mid-line block)  → outside-eliminate
//   - restore leaves manual eliminations untouched
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/turf-env.mjs";
import { orderStationsAlongLine, eliminateStationsInRange, restoreStationsInRange } from "../src/stations.js";

// A north-south line from Andheri (south) to Dahisar (north). The "spine" —
// longest way — is a single polyline running through all 8 station latitudes.
const LINE = {
  key: "subway:1",
  label: "Line 1",
  paths: [
    [[19.12, 72.85], [19.16, 72.85], [19.20, 72.85], [19.24, 72.85], [19.28, 72.85]],
    // A shorter branch, so the "longest way is spine" logic has a real choice to
    // make. The branch's stations still project onto the trunk cleanly.
    [[19.19, 72.85], [19.19, 72.86]],
  ],
};

const STATIONS = () => [
  { id: "osm:node/1", name: "Dahisar",     lat: 19.28, lng: 72.85 },
  { id: "osm:node/2", name: "Borivali",    lat: 19.24, lng: 72.85 },
  { id: "osm:node/3", name: "Kandivali",   lat: 19.20, lng: 72.85 },
  { id: "osm:node/4", name: "Malad",       lat: 19.18, lng: 72.85 },
  { id: "osm:node/5", name: "Goregaon",    lat: 19.16, lng: 72.85 },
  { id: "osm:node/6", name: "Jogeshwari",  lat: 19.14, lng: 72.85 },
  { id: "osm:node/7", name: "Andheri",     lat: 19.12, lng: 72.85 },
  { id: "osm:node/8", name: "Off the line",lat: 19.10, lng: 72.90 }, // ~5 km east
];

test("game 1: ordering along the line puts the south stations first, north last", () => {
  const ordered = orderStationsAlongLine(STATIONS(), LINE.paths);
  // Off-line station is dropped; the on-line ones are ordered south → north.
  const names = ordered.map((s) => s.name);
  assert.deepEqual(names, ["Andheri", "Jogeshwari", "Goregaon", "Malad", "Kandivali", "Borivali", "Dahisar"]);
});

test("game 2: playtest Q0 — 'not past Dahisar' shape (eliminate OUTSIDE a range)", () => {
  // Actually the playtest was "not past Dahisar" = hider is SOUTH of Dahisar.
  // Written as a range: everything from Dahisar northward is out. Except Dahisar
  // IS the northernmost so there's nothing to eliminate for THIS specific Q0.
  // The more interesting shape is "hider is between Goregaon and Borivali" —
  // eliminate OUTSIDE that range. That's the pattern this test proves.
  const list = STATIONS();
  const ordered = orderStationsAlongLine(list, LINE.paths);
  const { changed } = eliminateStationsInRange(ordered, "osm:node/5", "osm:node/2", "subway:1", { mode: "outside" });
  // "Keep only Goregaon, Malad, Kandivali, Borivali" → the 2 south of the range
  // (Andheri, Jogeshwari) + Dahisar to the north = 3 on-line eliminations.
  // The off-line station is NOT touched (it isn't in the ordered list).
  assert.equal(changed.length, 3);
  const active = list.filter((s) => !s.eliminated).map((s) => s.name).sort();
  assert.deepEqual(active, ["Borivali", "Goregaon", "Kandivali", "Malad", "Off the line"]);
});

test("game 3: inside-range mode marks the block itself", () => {
  // A different question shape: "hider is NOT between Malad and Borivali" — the
  // seeker rules out the middle. Inside-range mode does exactly that.
  const list = STATIONS();
  const ordered = orderStationsAlongLine(list, LINE.paths);
  const { changed } = eliminateStationsInRange(ordered, "osm:node/4", "osm:node/2", "subway:1");
  assert.equal(changed.length, 3, "Malad, Kandivali, Borivali all eliminated");
  const elimNames = list.filter((s) => s.eliminated).map((s) => s.name).sort();
  assert.deepEqual(elimNames, ["Borivali", "Kandivali", "Malad"]);
});

test("game 4: from/to order doesn't matter — 'top to bottom' == 'bottom to top'", () => {
  const list1 = STATIONS(); const list2 = STATIONS();
  const o1 = orderStationsAlongLine(list1, LINE.paths);
  const o2 = orderStationsAlongLine(list2, LINE.paths);
  eliminateStationsInRange(o1, "osm:node/4", "osm:node/2", "subway:1");
  eliminateStationsInRange(o2, "osm:node/2", "osm:node/4", "subway:1");
  assert.deepEqual(list1.map((s) => !!s.eliminated), list2.map((s) => !!s.eliminated));
});

test("game 5: restoreStationsInRange undoes only its own tag — a MANUAL elimination stays", () => {
  const list = STATIONS();
  // Manually strike Malad (a Q4 photo case).
  list[3].eliminated = true;
  list[3].eliminatedBy = "manual";
  // Then range-eliminate everything outside Goregaon..Borivali.
  const ordered = orderStationsAlongLine(list, LINE.paths);
  const outAction = eliminateStationsInRange(ordered, "osm:node/5", "osm:node/2", "subway:1", { mode: "outside" });
  // 7 stations on-line, range is Goregaon..Borivali (indices 2..5), so the
  // OUTSIDE-eliminated ones are indices 0, 1, 6 = Andheri, Jogeshwari, Dahisar
  // — three range-tagged flips. Malad is between the endpoints so it wasn't
  // touched; its manual tag survives.
  assert.equal(outAction.changed.length, 3);
  assert.equal(list[3].eliminatedBy, "manual");
  // Restore the range → the 3 outside ones come back, Malad stays out.
  const { changed } = restoreStationsInRange(list, "subway:1");
  assert.equal(changed.length, 3);
  assert.equal(list[3].eliminated, true, "Malad's manual elimination must survive restore");
  assert.equal(list[3].eliminatedBy, "manual");
});

test("game 6: a range action doesn't touch stations OFF the line — the off-line one stays untouched", () => {
  const list = STATIONS();
  const ordered = orderStationsAlongLine(list, LINE.paths);
  eliminateStationsInRange(ordered, "osm:node/1", "osm:node/7", "subway:1"); // eliminate ALL on-line
  const off = list.find((s) => s.name === "Off the line");
  assert.equal(!!off.eliminated, false, "the off-line station was never in the ordered list");
});

test("game 7: an unknown id in from/to is a no-op — no crash, no partial elimination", () => {
  const list = STATIONS();
  const ordered = orderStationsAlongLine(list, LINE.paths);
  const { changed } = eliminateStationsInRange(ordered, "osm:node/999", "osm:node/2", "subway:1");
  assert.equal(changed.length, 0);
  assert.equal(list.every((s) => !s.eliminated), true);
});
