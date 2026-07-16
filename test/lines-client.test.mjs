// §G1 client: the board→bbox derivation and the cache/network/stale-cache ladder.
//
// The ladder is the part worth testing. This runs outdoors on a phone, where Overpass fails
// ~64% of individual calls and signal is not guaranteed, so "network failed but we have a
// month-old copy" must show the copy rather than an empty map — and must SAY which it is.
import test from "node:test";
import assert from "node:assert/strict";
import { squareArea } from "./helpers/turf-env.mjs"; // also installs window.turf, which boardBbox reads
import { boardBbox, loadLines as rawLoadLines } from "../src/lines.js";

// A stand-in for IndexedDB, injected the same way overpass.js takes fetchImpl.
const store = new Map();
let dbThrows = false;
const dbImpl = {
  get: async (_s, k) => { if (dbThrows) throw new Error("IndexedDB unavailable"); return store.get(k) || null; },
  put: async (_s, v) => { if (dbThrows) throw new Error("quota exceeded"); store.set(v.key, v); },
};
const loadLines = (kind, bbox, opts = {}) => rawLoadLines(kind, bbox, { dbImpl, ...opts });

const AREA = squareArea([72.8777, 19.076], 0.2); // 0.2° square around Mumbai
const payload = (n = 2) => ({
  kind: "rail",
  lines: [{ name: "Western Line", ref: "W", wayIds: [1] }],
  ways: { 1: Array.from({ length: n }, (_, i) => [19.07 + i * 0.001, 72.87]) },
  counts: { lines: 1, ways: 1, vertices: n },
});

test("boardBbox pads the board and snaps to 3dp", () => {
  const bbox = boardBbox(AREA);
  const [s, w, n, e] = bbox.split(",").map(Number);
  // 0.2° square + 10% pad each side -> 0.24° span.
  assert.ok(Math.abs((n - s) - 0.24) < 1e-6, `expected a 0.24° tall bbox, got ${n - s}`);
  assert.ok(Math.abs((e - w) - 0.24) < 1e-6, `expected a 0.24° wide bbox, got ${e - w}`);
  assert.ok(s < n && w < e, "S,W,N,E order");
  for (const v of [s, w, n, e]) assert.equal(v, Math.round(v * 1e3) / 1e3, `${v} not snapped to 3dp`);
});

test("the same board yields a byte-identical bbox — the cache depends on it", () => {
  // Float noise in the stored polygon would otherwise miss the cache on every load and
  // re-run a slow, failure-prone query for geometry already on disk.
  const jittered = {
    type: "Polygon",
    coordinates: [AREA.coordinates[0].map(([x, y]) => [x + 1e-9, y - 1e-9])],
  };
  assert.equal(boardBbox(jittered), boardBbox(AREA));
});

test("boardBbox refuses a degenerate area rather than fetching the planet", () => {
  assert.equal(boardBbox(null), null);
  const dot = { type: "Polygon", coordinates: [[[72.8, 19.0], [72.8, 19.0], [72.8, 19.0], [72.8, 19.0]]] };
  assert.equal(boardBbox(dot), null);
});

test("a fresh cache entry is served without touching the network", async () => {
  store.clear();
  let called = 0;
  globalThis.fetch = async () => { called++; throw new Error("should not be called"); };
  store.set("rail:-:B", { key: "rail:-:B", fetchedAt: 1000, data: payload() });
  const out = await loadLines("rail", "B", { proxyBase: "http://x", now: 1000 + 60_000 });
  assert.equal(out.from, "cache");
  assert.equal(called, 0);
});

test("a network answer is cached for next time", async () => {
  store.clear();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload() });
  const out = await loadLines("rail", "B", { proxyBase: "http://x", now: 5000 });
  assert.equal(out.from, "network");
  assert.equal(store.get("rail:-:B").fetchedAt, 5000);
});

test("a STALE entry is served when the network fails — the offline case", async () => {
  store.clear();
  store.set("rail:-:B", { key: "rail:-:B", fetchedAt: 0, data: payload() });
  globalThis.fetch = async () => { throw new Error("network down"); };
  // Well past the TTL, so this would have re-fetched had the network been up.
  const out = await loadLines("rail", "B", { proxyBase: "http://x", now: 400 * 24 * 3600 * 1000 });
  assert.equal(out.from, "cache-stale", "a month-old rail line beats a blank map on a dead board");
  assert.match(out.error, /network down/, "and it must still say why it is stale");
  assert.equal(out.counts.ways, 1);
});

test("with no cache and no network, it throws rather than showing an empty map", async () => {
  store.clear();
  globalThis.fetch = async () => { throw new Error("network down"); };
  await assert.rejects(() => loadLines("rail", "B", { proxyBase: "http://x" }), /network down/);
});

test("a 400 keeps its detail — a query bug must not read as an outage", async () => {
  store.clear();
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'kind must be one of: rail, coastline, border.' }) });
  // 400 = our request is wrong and fails identically everywhere; 502 = endpoints were busy.
  // Collapsing them is how someone spends an afternoon hunting a phantom outage.
  await assert.rejects(() => loadLines("rail", "B", { proxyBase: "http://x" }), (e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /kind must be one of/);
    return true;
  });
});

test("no proxy configured is a clear message, not a silent blank", async () => {
  store.clear();
  await assert.rejects(() => loadLines("rail", "B", { proxyBase: null }), /OVERPASS_PROXY_URL/);
});

test("a stale entry still serves when no proxy is configured", async () => {
  store.clear();
  store.set("rail:-:B", { key: "rail:-:B", fetchedAt: 0, data: payload() });
  const out = await loadLines("rail", "B", { proxyBase: null, now: 400 * 24 * 3600 * 1000 });
  assert.equal(out.from, "cache-stale");
});

test("an unusable IndexedDB degrades to network-only instead of failing", async () => {
  store.clear();
  dbThrows = true;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload() });
    const out = await loadLines("rail", "B", { proxyBase: "http://x" });
    assert.equal(out.from, "network", "a dead cache must not take the feature down with it");
  } finally { dbThrows = false; }
});

test("border levels get distinct cache keys", async () => {
  store.clear();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload() });
  await loadLines("border", "B", { level: 2, proxyBase: "http://x" });
  await loadLines("border", "B", { level: 4, proxyBase: "http://x" });
  // A shared key would show country borders where state borders were asked for.
  assert.deepEqual([...store.keys()].sort(), ["border:2:B", "border:4:B"]);
});
