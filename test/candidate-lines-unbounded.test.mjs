// P2: `candidateLines` computed a distance for every path on the board and then threw the
// result away whenever the radius was not finite.
//
// Matching asks about the WHOLE board and calls with `Infinity`, so `best <= radius` was true
// for every line — 2,109 pointToLineDistance calls over 24,545 vertices on the MMR board, 213
// of the function's 220 ms, to produce an ordering the Matching sheet deliberately does not
// display (it does not know where the seeker is standing). Tentacles passes a real radius
// (2 km / 25 km) and must keep behaving exactly as before.
//
// These tests pin both halves: the unbounded call does no distance work and orders by label,
// and the bounded call still filters and orders by distance.
import test from "node:test";
import assert from "node:assert/strict";
import { squareArea } from "./helpers/turf-env.mjs";
import { candidateLines } from "../src/lines.js";
import { readFileSync } from "node:fs";
import { normalizeLines } from "../overpass-lines.js";

const AREA = squareArea([72.8777, 19.076], 0.4); // Mumbai, big enough to hold the fixture
const CENTRE = { lat: 19.076, lng: 72.8777 };
const GAME = { id: "g1", hiddenRoutes: [] }; // empty filter — nothing hidden

const RAIL = normalizeLines(
  "rail",
  JSON.parse(readFileSync(new URL("./fixtures/overpass-rail-mumbai.json", import.meta.url), "utf8")),
);

// candidateLines reaches the network through the module-level `fetch` and its proxy config,
// and its IndexedDB read simply throws in Node and is caught. Serving the fixture from a
// stubbed fetch is therefore the whole harness.
function serveFixture() {
  let calls = 0;
  globalThis.window.JLTG_CONFIG = { OVERPASS_PROXY_URL: "http://proxy.test" };
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => RAIL }; };
  return () => calls;
}

// Count the real geometry work by counting pointToLineDistance calls, which is the operation
// P2 removes. Wrapping turf is more honest than timing: a wall-clock assertion would pass on a
// fast machine even if the loop were still running.
function countDistanceCalls(fn) {
  const real = globalThis.turf.pointToLineDistance;
  let n = 0;
  globalThis.turf.pointToLineDistance = (...a) => { n++; return real(...a); };
  globalThis.window.turf = globalThis.turf;
  return fn().finally(() => {
    globalThis.turf.pointToLineDistance = real;
    globalThis.window.turf = globalThis.turf;
  }).then((r) => ({ result: r, calls: n }));
}

test("an unbounded radius does no distance work at all", async () => {
  serveFixture();
  const { result, calls } = await countDistanceCalls(() =>
    candidateLines("rail", AREA, CENTRE, Infinity, { game: GAME }));
  assert.equal(calls, 0, "Infinity radius must not measure a single path — that was the 213 ms");
  assert.ok(result.lines.length > 1, `expected the fixture's lines, got ${result.lines.length}`);
  for (const l of result.lines) {
    assert.equal(l.distance, null, `${l.label} carries a distance that was never measured`);
  }
});

test("an unbounded result is ordered by label, numerically", async () => {
  serveFixture();
  const { lines } = await candidateLines("rail", AREA, CENTRE, Infinity, { game: GAME });
  const labels = lines.map((l) => String(l.label));
  const sorted = [...labels].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  assert.deepEqual(labels, sorted, "the sheet shows this order, so it must be the label order");
});

test("`Line 2` sorts before `Line 10`, not after it", () => {
  // The reason the comparator passes `numeric`. A plain string sort puts "Line 10" first,
  // which is exactly the ordering a player reads as a bug.
  const labels = ["Line 10", "Line 2", "Line 1"];
  labels.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  assert.deepEqual(labels, ["Line 1", "Line 2", "Line 10"]);
});

test("a finite radius still measures, filters and orders by distance", async () => {
  serveFixture();
  const { result, calls } = await countDistanceCalls(() =>
    candidateLines("rail", AREA, CENTRE, 3000, { game: GAME }));
  assert.ok(calls > 0, "Tentacles must be unaffected — a real radius still has to measure");
  for (const l of result.lines) {
    assert.equal(typeof l.distance, "number");
    assert.ok(l.distance <= 3000, `${l.label} at ${Math.round(l.distance)} m is outside the radius`);
  }
  const ds = result.lines.map((l) => l.distance);
  assert.deepEqual(ds, [...ds].sort((a, b) => a - b), "nearest first");
});

test("the unbounded call returns at least as many lines as a 3 km one", async () => {
  // The whole board is a superset of a disc on it. If this ever inverted, the unbounded
  // branch would be skipping lines rather than skipping distance work.
  serveFixture();
  const all = await candidateLines("rail", AREA, CENTRE, Infinity, { game: GAME });
  const near = await candidateLines("rail", AREA, CENTRE, 3000, { game: GAME });
  assert.ok(all.lines.length >= near.lines.length,
    `board ${all.lines.length} < 3 km ${near.lines.length}`);
});
