// Phase 14 game test: bulk line/range elimination must not clobber a manual
// station tag when the station lies ON the line.
//
// Regression pin for review finding #2 (2026-07-21). The Phase 4 test
// game-line-elimination.test.mjs game 4 read like it covered this — it
// manually eliminates a station, then runs eliminateStationsOnLine, then
// restores. But its manually-flagged station sits 420 m off the line at the
// default 100 m tolerance, so the collision path (station ON the line) was
// never actually exercised. The mutator overwrote 'manual' with 'line:<key>'
// for on-line stations, and the later restore silently un-eliminated them.
//
// This test drops the manually-flagged station DIRECTLY on a way path so the
// hit set includes it, then asserts the manual tag survives both the bulk
// eliminate AND the bulk restore.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/turf-env.mjs";
import {
  eliminateStationsOnLine,
  restoreStationsOnLine,
  eliminateStationsInRange,
  restoreStationsInRange,
  orderStationsAlongLine,
  toggleStationElimination,
} from "../src/stations.js";

// A single north-south way. Any station within 100 m of it counts as on-line.
const LINE = {
  key: "subway:1",
  paths: [[
    [19.10, 72.87], [19.15, 72.87], [19.20, 72.87], [19.25, 72.87],
  ]],
};

// Three stations ALL on the line. Middle one will be the manually-eliminated
// deduction that the bulk actions must not touch.
function stations() {
  return [
    { id: "osm:node/a", name: "South",  lat: 19.11, lng: 72.8701 },
    { id: "osm:node/b", name: "Middle", lat: 19.15, lng: 72.8701 }, // manually eliminated
    { id: "osm:node/c", name: "North",  lat: 19.22, lng: 72.8701 },
  ];
}

test("game 1: whole-line elim skips a station already flagged 'manual' (on the line)", () => {
  const list = stations();
  // Manual deduction from a photo clue — the seeker taps the map to eliminate.
  toggleStationElimination(list, "osm:node/b");
  assert.equal(list[1].eliminatedBy, "manual");

  // Hider then answers "not the blue line" → bulk eliminate.
  const { changed, hitIds } = eliminateStationsOnLine(list, LINE.key, LINE.paths);
  // All three are on the line, but the middle one must NOT be re-tagged.
  assert.deepEqual([...hitIds].sort(), ["osm:node/a", "osm:node/b", "osm:node/c"]);
  assert.equal(changed.length, 2, "changed excludes the manually-flagged station");
  assert.equal(list[1].eliminatedBy, "manual", "manual tag survives — bulk elim must not overwrite it");
  assert.equal(list[0].eliminatedBy, "line:subway:1");
  assert.equal(list[2].eliminatedBy, "line:subway:1");
});

test("game 2: restoring the line un-eliminates ONLY the line-tagged stations — manual stays", () => {
  const list = stations();
  toggleStationElimination(list, "osm:node/b");
  eliminateStationsOnLine(list, LINE.key, LINE.paths);
  // Later playtest twist: "actually maybe it IS the blue line" — undo it.
  restoreStationsOnLine(list, LINE.key);
  // The manual deduction from the photo clue must survive.
  assert.equal(list[1].eliminated, true, "manual elimination survives the line restore");
  assert.equal(list[1].eliminatedBy, "manual");
  assert.equal(list[0].eliminated, false);
  assert.equal(list[2].eliminated, false);
});

test("game 3: range elim on a line skips a station already flagged 'manual'", () => {
  const list = stations();
  // Manual on the middle station.
  toggleStationElimination(list, "osm:node/b");
  // Range across the whole spine (from south to north, inclusive).
  const ordered = orderStationsAlongLine(list, LINE.paths);
  eliminateStationsInRange(ordered, ordered[0].id, ordered[ordered.length - 1].id, LINE.key, { mode: "range" });
  assert.equal(list[1].eliminatedBy, "manual", "manual survives range elim too");
  // Restoring the range must not resurrect the manual one either.
  restoreStationsInRange(list, LINE.key);
  assert.equal(list[1].eliminated, true, "manual survives the range restore");
});

test("game 4: range elim in 'outside' mode also respects the manual tag", () => {
  // "outside" mode is the natural shape of playtest Q0 ("hider is south of
  // Dahisar" → eliminate everything NORTH). If the outside includes a
  // manually-flagged station, the mutator must still skip it.
  const list = stations();
  toggleStationElimination(list, "osm:node/c"); // manually rule out the northern station
  const ordered = orderStationsAlongLine(list, LINE.paths);
  // Range is just the middle: [middle, middle], mode=outside → eliminate
  // everything else. That includes the manually-flagged northern station.
  const mid = ordered[Math.floor(ordered.length / 2)];
  eliminateStationsInRange(ordered, mid.id, mid.id, LINE.key, { mode: "outside" });
  const c = list.find((s) => s.id === "osm:node/c");
  assert.equal(c.eliminatedBy, "manual", "manual tag survives even when it's IN the eliminated set");
  restoreStationsInRange(list, LINE.key);
  assert.equal(c.eliminated, true, "restore does not touch the manual one");
});

test("game 5: repeating a bulk eliminate is still idempotent — the skip doesn't cause drift", () => {
  // Guard against a subtle regression: if `changed` no longer includes the
  // manual station, a second call must not somehow "notice" the skip and
  // flip state. Everything must stay stable.
  const list = stations();
  toggleStationElimination(list, "osm:node/b");
  eliminateStationsOnLine(list, LINE.key, LINE.paths);
  const first = list.map((s) => ({ id: s.id, elim: s.eliminated, by: s.eliminatedBy }));
  eliminateStationsOnLine(list, LINE.key, LINE.paths);
  const second = list.map((s) => ({ id: s.id, elim: s.eliminated, by: s.eliminatedBy }));
  assert.deepEqual(second, first, "state is stable under repeated bulk elim");
});
