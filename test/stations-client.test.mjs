// Client-side sourcing: the cache ladder mirrors lines.js (fresh → stale → throw),
// and a station kept edits (eliminated, notes) survives a refetch by matching id.
import test from "node:test";
import assert from "node:assert/strict";
import { squareArea } from "./helpers/turf-env.mjs";
import { loadStationsFromOsm, loadStationsFromPlaces, sourceStationsForGame, stationsCacheKey } from "../src/stations.js";

const store = new Map();
let dbThrows = false;
const dbImpl = {
  get: async (_s, k) => { if (dbThrows) throw new Error("IndexedDB unavailable"); return store.get(k) || null; },
  put: async (_s, v) => { if (dbThrows) throw new Error("quota exceeded"); store.set(v.key, v); },
};

const AREA = squareArea([72.8777, 19.076], 0.2);
const BBOX = "18.976,72.7777,19.176,72.9777"; // what boardBbox returns for AREA
const payload = { stations: [
  { id: "osm:node/1", name: "Devipada", lat: 19.24, lng: 72.87, kind: "halt" },
  { id: "osm:node/2", name: "Andheri", lat: 19.11, lng: 72.85, kind: "station" },
], counts: { raw: 2, kept: 2 } };

test("fresh cache is served without a network call", async () => {
  store.clear();
  let called = 0;
  globalThis.fetch = async () => { called++; throw new Error("should not be called"); };
  const key = stationsCacheKey("osm", BBOX);
  store.set(key, { key, fetchedAt: 1000, data: payload });
  const out = await loadStationsFromOsm(BBOX, { proxyBase: "http://x", now: 1000 + 60_000, dbImpl });
  assert.equal(out.from, "cache");
  assert.equal(called, 0);
  assert.equal(out.stations.length, 2);
});

test("stale cache is served when the network fails — the offline case", async () => {
  store.clear();
  const key = stationsCacheKey("osm", BBOX);
  store.set(key, { key, fetchedAt: 0, data: payload });
  globalThis.fetch = async () => { throw new Error("network down"); };
  const out = await loadStationsFromOsm(BBOX, { proxyBase: "http://x", now: 400 * 24 * 3600 * 1000, dbImpl });
  assert.equal(out.from, "cache-stale");
  assert.match(out.error, /network down/);
  assert.equal(out.stations.length, 2);
});

test("no cache, no network — throws rather than showing an empty list", async () => {
  store.clear();
  globalThis.fetch = async () => { throw new Error("network down"); };
  await assert.rejects(() => loadStationsFromOsm(BBOX, { proxyBase: "http://x", dbImpl }), /network down/);
});

test("no proxy configured is a clear message, not silent success", async () => {
  store.clear();
  await assert.rejects(() => loadStationsFromOsm(BBOX, { proxyBase: null, dbImpl }), /OVERPASS_PROXY_URL/);
});

test("Places fallback filters out-of-bbox results — the search circle overshoots corners", async () => {
  // nearbySearch is circular around the bbox centre, so results outside the bbox are
  // legitimate Places hits that just aren't on this board. Filter them out here.
  const raw = [
    { name: "On board",  lat: 19.076, lng: 72.8777, placeId: "p1" },
    { name: "Off board", lat: 19.500, lng: 72.8777, placeId: "p2" }, // north of the bbox
  ];
  const out = await loadStationsFromPlaces(BBOX, {
    placesImpl: { searchCategory: async () => raw },
  });
  assert.deepEqual(out.stations.map((s) => s.name), ["On board"]);
});

test("Places entries carry stable ids (places:<placeId>)", async () => {
  const raw = [{ name: "Devipada", lat: 19.076, lng: 72.8777, placeId: "ChIJ-abc" }];
  const out = await loadStationsFromPlaces(BBOX, { placesImpl: { searchCategory: async () => raw } });
  assert.equal(out.stations[0].id, "places:ChIJ-abc");
});

test("Places without a key throws — the user asked for Places and it isn't configured", async () => {
  await assert.rejects(() => loadStationsFromPlaces(BBOX, { placesImpl: null }), /Google Places is not available/);
});

test("sourceStationsForGame refuses a game with no area — stations need a board", async () => {
  const game = { gameArea: null };
  await assert.rejects(() => sourceStationsForGame(game, { source: "osm", dbImpl }), /Draw a game area first/);
});

test("sourceStationsForGame + osm returns the OSM shape plus source metadata", async () => {
  store.clear();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
  const game = { gameArea: AREA };
  const out = await sourceStationsForGame(game, { source: "osm", proxyBase: "http://x", dbImpl });
  assert.equal(out.source, "osm");
  assert.equal(out.stations.length, 2);
  assert.ok(out.bbox, "the bbox used must be reported so a later refetch is byte-identical");
});
