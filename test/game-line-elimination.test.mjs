// Phase 4 game test: A4 whole-line elimination on a Mumbai board.
//
// Playtest 1 Q1: "same line? (blue / Line 1) — No". The seekers needed to strike
// every Line 1 station off the candidate set in one action; the app had no button
// for that (the rail filter only hid the line from view). This exercises the two
// helpers that make it a real action:
//
//   - stationsWithinLine — the heuristic that picks the ids on one line
//   - eliminateStationsOnLine / restoreStationsOnLine — the mutators the UI calls
//
// End-to-end: a Line-1 line with fake paths, five stations of which three sit on
// the line, one 500 m away, one 5 km away. Eliminating the line must flip only
// those three. Restoring must un-flip only what THIS line flagged — never a
// manual elimination.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/turf-env.mjs"; // installs window.turf
import { stationsWithinLine, eliminateStationsOnLine, restoreStationsOnLine } from "../src/stations.js";

// Two ways make up "Line 1" in this fixture — a real line has many, and the
// helper's job is to accept any of them as a match.
const LINE1 = {
  key: "subway:1",
  label: "Line 1",
  paths: [
    // North-south segment along lng ≈ 72.87, lat 19.0-19.3
    [[19.00, 72.87], [19.10, 72.87], [19.20, 72.87], [19.30, 72.87]],
    // East-west spur along lat ≈ 19.15, lng 72.85-72.90
    [[19.15, 72.85], [19.15, 72.87], [19.15, 72.90]],
  ],
};

// Five stations. The first three sit within 100 m of one of the paths above; the
// fourth is a full 500 m off (still an OSM neighbourhood but not on the line);
// the fifth is 5 km away — a station on a different line entirely.
const STATIONS = () => [
  { id: "osm:node/1", name: "On Line 1 (north)", lat: 19.10, lng: 72.8701 },
  { id: "osm:node/2", name: "On Line 1 (mid)",   lat: 19.20, lng: 72.8699 },
  { id: "osm:node/3", name: "On Line 1 (spur)",  lat: 19.1502, lng: 72.86 },
  // 0.004° east of the lng=72.87 north-south segment at lat 19.155 (well OFF the
  // spur, which sits at lat 19.15). At Mumbai's latitude that's ~420 m — inside
  // 600 m tolerance, outside 100 m.
  { id: "osm:node/4", name: "~420 m off Line 1", lat: 19.155, lng: 72.874 },
  { id: "osm:node/5", name: "Far off Line 1",    lat: 19.05, lng: 72.82 },  // ~5 km southwest
];

test("game 1: stationsWithinLine picks up all three real Line-1 stations", () => {
  const hits = stationsWithinLine(STATIONS(), LINE1.paths, { toleranceM: 100 });
  assert.deepEqual([...hits].sort(), ["osm:node/1", "osm:node/2", "osm:node/3"]);
});

test("game 1a: tolerance is a real knob — 600 m sweeps in the 500 m outlier", () => {
  // The 500 m station shouldn't count at 100 m but SHOULD at 600 m. Proves the
  // caller can widen the tolerance if their OSM tagging is looser without editing
  // the helper.
  const tight = stationsWithinLine(STATIONS(), LINE1.paths, { toleranceM: 100 });
  const loose = stationsWithinLine(STATIONS(), LINE1.paths, { toleranceM: 600 });
  assert.ok(!tight.has("osm:node/4"));
  assert.ok(loose.has("osm:node/4"));
});

test("game 2: eliminateStationsOnLine flips exactly the line's stations", () => {
  const list = STATIONS();
  const { hitIds } = eliminateStationsOnLine(list, LINE1.key, LINE1.paths);
  assert.equal(hitIds.length, 3);
  for (const s of list) {
    const expected = ["osm:node/1", "osm:node/2", "osm:node/3"].includes(s.id);
    assert.equal(!!s.eliminated, expected, `${s.name} eliminated=${s.eliminated}, expected=${expected}`);
    if (expected) assert.equal(s.eliminatedBy, "line:subway:1");
  }
});

test("game 3: playtest Q1 replay — 'not the blue line' then a matching card carries on", () => {
  // Round-log flow: seekers hear "not blue", strike three stations, then still
  // have their other two candidates to reason about. The remaining active set
  // must be exactly {station 4, station 5}.
  const list = STATIONS();
  eliminateStationsOnLine(list, LINE1.key, LINE1.paths);
  const active = list.filter((s) => !s.eliminated).map((s) => s.id);
  assert.deepEqual(active.sort(), ["osm:node/4", "osm:node/5"]);
});

test("game 4: restoreStationsOnLine undoes only its own tag — a MANUAL elimination stays", () => {
  // Q4 in the playtest was "photo of a building". The seekers manually ruled out
  // one station based on it — and then also ruled out a whole line. Restoring
  // the line (later playtest maybe-undo) must NOT un-strike the manual one.
  const list = STATIONS();
  // Manually strike station 4 first — a photo eliminated it.
  list[3].eliminated = true;
  list[3].eliminatedBy = "manual";
  // Then rule out the whole line.
  eliminateStationsOnLine(list, LINE1.key, LINE1.paths);
  // Now restore the line.
  const { changed } = restoreStationsOnLine(list, LINE1.key);
  assert.equal(changed.length, 3, "restore touches the three line-tagged stations, nothing else");
  // Station 4 is still eliminated (manual).
  assert.equal(list[3].eliminated, true);
  assert.equal(list[3].eliminatedBy, "manual");
  // Stations 1-3 are back.
  for (const id of ["osm:node/1", "osm:node/2", "osm:node/3"]) {
    const s = list.find((x) => x.id === id);
    assert.equal(!!s.eliminated, false);
    assert.equal(s.eliminatedBy, null);
  }
});

test("game 5: eliminating a line then re-eliminating is idempotent — no double-tagging surprises", () => {
  const list = STATIONS();
  eliminateStationsOnLine(list, LINE1.key, LINE1.paths);
  const first = list.map((s) => ({ id: s.id, elim: s.eliminated, by: s.eliminatedBy }));
  eliminateStationsOnLine(list, LINE1.key, LINE1.paths);
  const second = list.map((s) => ({ id: s.id, elim: s.eliminated, by: s.eliminatedBy }));
  assert.deepEqual(second, first);
});

test("game 6: a station on two lines keeps the SECOND tag — restoring the first spares it", () => {
  // A real network has shared track (Berlin S-Bahn, Mumbai's Central+Harbour). A
  // station on both must not be silently un-eliminated when only one of its
  // lines is restored — the other line's rule still applies.
  const list = [{ id: "osm:node/x", name: "Junction", lat: 19.15, lng: 72.87 }];
  const line1 = LINE1.paths;
  const line2 = [[[19.14, 72.87], [19.16, 72.87]]]; // a second line running through the same point
  eliminateStationsOnLine(list, "subway:1", line1);
  eliminateStationsOnLine(list, "subway:2", line2);
  // Second call rewrites the tag — that IS the current design (the more recent
  // rule wins). Restoring subway:1 does nothing; restoring subway:2 restores it.
  assert.equal(list[0].eliminatedBy, "line:subway:2");
  restoreStationsOnLine(list, "subway:1");
  assert.equal(list[0].eliminated, true, "restoring the OTHER line must leave subway:2's rule in force");
  restoreStationsOnLine(list, "subway:2");
  assert.equal(list[0].eliminated, false);
});

test("game 7: an empty station set is a no-op — no crash, no side effects", () => {
  const list = [];
  const out = eliminateStationsOnLine(list, "subway:1", LINE1.paths);
  assert.deepEqual(out.hitIds, []);
});

test("game 8: bad geometry (malformed way) is skipped, not thrown — one bad way must not veto the rest", () => {
  const paths = [
    [[19.15, 72.87]], // 1-point way — turf.lineString throws
    [[19.10, 72.87], [19.20, 72.87]], // real way
  ];
  const hits = stationsWithinLine([{ id: "osm:node/1", name: "A", lat: 19.15, lng: 72.87 }], paths, { toleranceM: 100 });
  assert.equal(hits.size, 1, "the second, valid way must still match");
});
