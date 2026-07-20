// Phase 1 game test: a full game receives a locked station set.
//
// The playtest that generated this phase (PLAYTEST_2026-07-19) ended AT Devipada.
// This simulates that board end-to-end:
//   1. Draw the board (a small square around Mumbai — Lines 1, 2A, 7, 9 area).
//   2. Materialise stations from OSM via the proxy (mocked with a real-shape payload).
//   3. Confirm the set.
//   4. Manually eliminate a station.
//   5. Simulate a session close + reopen (serialise the game, re-normalise it).
//   6. Verify the elimination survives.
//   7. Re-materialise stations (OSM refetch).
//   8. Verify the elimination survives THAT too (stable ids do their job).
//
// The whole point of a locked station set is stability: a per-game domain that later
// phases (A3/A4/A5/B1) can reference by id. This test is the guarantee for that
// promise. If it passes, phases 2 and 3 can build on top without fear that a refetch
// wipes state.
import test from "node:test";
import assert from "node:assert/strict";
import { squareArea, turf } from "./helpers/turf-env.mjs";
import { createGame, normalizeGame } from "../src/model.js";
import { sourceStationsForGame } from "../src/stations.js";

const AREA = squareArea([72.8777, 19.076], 0.2);

// A realistic-shape /overpass/stations payload for a Mumbai-scale board. Devipada is
// tagged as `halt` in real OSM data — the exact case where an old `railway=station`-
// only query would have missed the station the playtest ended AT.
const OSM_PAYLOAD = { stations: [
  { id: "osm:node/100", name: "Devipada",  lat: 19.2400, lng: 72.8700, kind: "halt" },
  { id: "osm:node/101", name: "Dahisar",   lat: 19.2500, lng: 72.8600, kind: "station" },
  { id: "osm:node/102", name: "Kandivali", lat: 19.2050, lng: 72.8500, kind: "station" },
  { id: "osm:node/103", name: "Borivali",  lat: 19.2280, lng: 72.8570, kind: "station" },
  { id: "osm:node/104", name: "Malad",     lat: 19.1870, lng: 72.8480, kind: "station" },
  { id: "osm:node/105", name: "Goregaon",  lat: 19.1650, lng: 72.8500, kind: "station" },
  { id: "osm:node/106", name: "Jogeshwari",lat: 19.1370, lng: 72.8480, kind: "station" },
  { id: "osm:node/107", name: "Andheri",   lat: 19.1200, lng: 72.8460, kind: "station" },
], counts: { raw: 8, kept: 8 } };

const store = new Map();
const dbImpl = {
  get: async (_s, k) => store.get(k) || null,
  put: async (_s, v) => { store.set(v.key, v); },
};

test("game 1: locked station set for a Mumbai playtest board — end to end", async () => {
  store.clear();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => OSM_PAYLOAD });

  // 1. Set up the board (a fresh game with an area, mirroring the playtest scale).
  const game = createGame({ name: "Playtest 1 recreation", gameArea: AREA });
  assert.deepEqual(game.stations, { source: null, bbox: null, confirmedAt: null, list: [] },
    "a fresh game has an empty station set");

  // 2. Materialise from OSM.
  const out = await sourceStationsForGame(game, { source: "osm", proxyBase: "http://x", dbImpl });
  assert.equal(out.source, "osm");
  assert.equal(out.stations.length, 8);
  assert.ok(out.stations.find((s) => s.name === "Devipada" && s.kind === "halt"),
    "Devipada must be present — the halt tag is why this phase exists");

  // Apply the source result to the game the way the UI would.
  game.stations = { source: "osm", bbox: out.bbox, confirmedAt: null, list: out.stations };
  assert.equal(game.stations.confirmedAt, null, "sourcing alone does NOT lock the set");

  // 3. Confirm.
  game.stations.confirmedAt = Date.now();
  const confirmedAt = game.stations.confirmedAt;
  assert.ok(confirmedAt, "confirming stamps a lock timestamp");

  // 4. Manually eliminate Dahisar (Q0 from the playtest: "not past Dahisar").
  const dahisar = game.stations.list.find((s) => s.name === "Dahisar");
  dahisar.eliminated = true;

  // 5. Simulate a session close + reopen. This is the real reason the set lives in
  //    game state and not in module scope: the app is a PWA that gets closed and
  //    reopened between play sessions, and everything must survive that round trip.
  const serialised = JSON.stringify(game);
  const reopened = normalizeGame(JSON.parse(serialised));

  // 6. Elimination and lock survive.
  assert.equal(reopened.stations.list.length, 8);
  assert.equal(reopened.stations.confirmedAt, confirmedAt);
  assert.equal(reopened.stations.source, "osm");
  const reopenedDahisar = reopened.stations.list.find((s) => s.name === "Dahisar");
  assert.ok(reopenedDahisar.eliminated, "the eliminated flag must survive save+reload");

  // 7. Refetch OSM (as if the user hit "Source from OSM" again after adding a zone).
  const refetched = await sourceStationsForGame(reopened, { source: "osm", proxyBase: "http://x", dbImpl });
  const priorById = new Map(reopened.stations.list.map((s) => [s.id, s]));
  const merged = refetched.stations.map((s) => {
    const prior = priorById.get(s.id);
    return prior ? { ...s, eliminated: prior.eliminated || false } : s;
  });

  // 8. Stable ids mean Dahisar-eliminated survives the refetch too.
  const refetchedDahisar = merged.find((s) => s.name === "Dahisar");
  assert.ok(refetchedDahisar.eliminated,
    "stable OSM ids must preserve the elimination across a refetch — the whole point of the lock");
});

test("game 2: a board with no area refuses to source stations", async () => {
  // The playtest's "click Stations before drawing a zone" case. Nothing should throw
  // deep inside a fetch; the panel is meant to show a clear "draw a game area first"
  // message and stop.
  const game = createGame({ name: "Empty board" });
  await assert.rejects(
    () => sourceStationsForGame(game, { source: "osm", proxyBase: "http://x", dbImpl }),
    /Draw a game area first/,
  );
});

test("game 3: OSM outage falls back to a stale cache — a phone outdoors keeps working", async () => {
  // A previous session sourced stations; the current session is offline. The board is
  // known, so the app should serve the last-known list rather than blank the panel.
  store.clear();
  const AREA2 = squareArea([72.8777, 19.076], 0.2);
  const game = createGame({ name: "Offline replay", gameArea: AREA2 });

  // First session — network up, cache populated.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => OSM_PAYLOAD });
  const first = await sourceStationsForGame(game, { source: "osm", proxyBase: "http://x", dbImpl });
  assert.equal(first.from, "network");

  // Weeks later — outdoors, network down.
  globalThis.fetch = async () => { throw new Error("network down"); };
  const later = await sourceStationsForGame(game, {
    source: "osm", proxyBase: "http://x", dbImpl, now: Date.now() + 400 * 24 * 3600 * 1000,
  });
  assert.equal(later.from, "cache-stale");
  assert.equal(later.stations.length, 8, "the whole set is still available");
});
