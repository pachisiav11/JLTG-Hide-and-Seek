// C1-4: a sourced-geometry question re-buffered its reference on every render.
//
// Found by running the coastline tool in a real game rather than by reading. Measured against
// the repo's Mumbai coastline fixture (1 part, 281 vertices):
//
//     buffer      183.6 ms   92.9% of the whole elimination
//     difference    5.2 ms
//     intersect     2.6 ms
//     elimination 197.7 ms
//
// The LIVE Mumbai coastline is 98 parts / 5,320 vertices, where one elimination measured
// ~3,900 ms, twice in a row with no caching. `computeActiveArea` runs on every `emit`, and
// `emit` runs on every `store.update` — so on a board carrying a single coastline question,
// one drag event measured **6,948 ms**.
//
// The buffer is now memoised on (geometry identity, distance). Identity is the correct key
// *because* sourced geometry is stored rather than referenced — deliberately, so a partition
// recomputes identically for the life of the game even if OSM is edited. It is never mutated
// in place, so a cache hit cannot be stale. These tests pin both halves: that it is reused, and
// that reuse never changes an answer.
import test from "node:test";
import assert from "node:assert/strict";
import { turf, squareArea } from "./helpers/turf-env.mjs";
import { normalizeLines } from "../overpass-lines.js";
import { computeElimination, computeActiveArea } from "../src/tools.js";
import { readFileSync } from "node:fs";

const raw = JSON.parse(readFileSync(new URL("./fixtures/overpass-coastline-mumbai.json", import.meta.url), "utf8"));
const norm = normalizeLines("coastline", raw);
// The MultiLineString shape the app stores: every way, [lat,lng] -> [lng,lat].
const COAST = {
  type: "MultiLineString",
  coordinates: Object.values(norm.ways || {}).filter((w) => w && w.length >= 2).map((w) => w.map(([lat, lng]) => [lng, lat])),
};
const AREA = squareArea([72.8777, 19.076], 0.4);
const km2 = (g) => (g ? turf.area(turf.feature(g)) / 1e6 : 0);

const step = (geom, side = "in", distance = 3000) => ({
  id: "c1", tool: "measuring", enabled: true,
  inputs: { refType: "line", refGeometry: geom, distance }, answer: { side },
});

test("the fixture is the real coastline, not a stub", () => {
  assert.ok(COAST.coordinates.length >= 1);
  const verts = COAST.coordinates.reduce((n, p) => n + p.length, 0);
  assert.ok(verts > 200, `expected a real capture, got ${verts} vertices`);
});

test("a repeated elimination is dramatically cheaper the second time", () => {
  // The whole point. Fresh geometry object so this test owns its own cache entry.
  const geom = structuredClone(COAST);
  const t0 = performance.now();
  const first = computeElimination(step(geom), AREA);
  const firstMs = performance.now() - t0;
  const t1 = performance.now();
  const second = computeElimination(step(geom), AREA);
  const secondMs = performance.now() - t1;

  assert.ok(first.eliminated, "the first call must actually compute something");
  assert.ok(secondMs * 3 < firstMs,
    `expected the memoised call to be far cheaper: first ${firstMs.toFixed(1)} ms, second ${secondMs.toFixed(1)} ms`);
});

test("the memoised result is IDENTICAL, not merely similar", () => {
  const geom = structuredClone(COAST);
  const a = computeElimination(step(geom), AREA).eliminated;
  const b = computeElimination(step(geom), AREA).eliminated;
  assert.equal(km2(a).toFixed(6), km2(b).toFixed(6), "a cache hit must not change the answer");
  assert.deepEqual(a, b);
});

test("both sides still partition the board exactly", () => {
  // The cache is shared between the two answers (same geometry, same distance), which is the
  // point — but it must not make them agree with each other.
  const geom = structuredClone(COAST);
  const inn = km2(computeElimination(step(geom, "in"), AREA).eliminated);
  const out = km2(computeElimination(step(geom, "out"), AREA).eliminated);
  const board = km2(AREA);
  assert.ok(inn > 0 && out > 0, `both sides must eliminate something (${inn}, ${out})`);
  assert.ok(Math.abs((inn + out) - board) / board < 0.01,
    `within + beyond should be the board: ${inn.toFixed(1)} + ${out.toFixed(1)} vs ${board.toFixed(1)}`);
});

test("a different distance is a different cache entry, not a stale hit", () => {
  // Keyed on (geometry, distance). A 3 km buffer must never be served for a 6 km question.
  const geom = structuredClone(COAST);
  const near = km2(computeElimination(step(geom, "out", 3000), AREA).eliminated);
  const far = km2(computeElimination(step(geom, "out", 6000), AREA).eliminated);
  assert.ok(far > near, `a 6 km buffer must eliminate more than a 3 km one (${far} vs ${near})`);
  // and back again — the first entry must still be correct after the second was added
  const nearAgain = km2(computeElimination(step(geom, "out", 3000), AREA).eliminated);
  assert.equal(near.toFixed(6), nearAgain.toFixed(6), "the 3 km entry was corrupted by the 6 km one");
});

test("a different geometry object is a different entry", () => {
  // Identity keying means two equal-but-distinct geometries each compute once. That is correct
  // and must not silently share: a future caller could hand over a mutated copy.
  const a = structuredClone(COAST);
  const b = structuredClone(COAST);
  const ea = km2(computeElimination(step(a), AREA).eliminated);
  const eb = km2(computeElimination(step(b), AREA).eliminated);
  assert.equal(ea.toFixed(6), eb.toFixed(6), "equal geometry must still give equal answers");
});

test("a reference with no bufferable geometry eliminates nothing, repeatably", () => {
  // An empty MultiLineString is well-formed enough to reach the buffer and produces nothing to
  // buffer. The memo caches that null, so the second call must agree rather than resurrect.
  const empty = { type: "MultiLineString", coordinates: [] };
  const first = computeElimination(step(empty), AREA);
  const second = computeElimination(step(empty), AREA);
  assert.equal(first.eliminated, null);
  assert.equal(second.eliminated, null, "a cached null must stay null, not resurrect");
});

test("a malformed reference is contained by computeActiveArea, not left to blank the board", () => {
  // Not a memo property — a pre-existing guarantee worth pinning next to it, because the memo
  // sits inside the path that guarantee protects. `computeElimination` may throw on a garbage
  // reference; `computeActiveArea` must catch it, report it, and keep the rest of the board.
  const bad = { type: "MultiLineString", coordinates: "not coordinates" };
  assert.throws(() => computeElimination(step(bad), AREA), "the raw call still surfaces the problem");
  const failed = [];
  const area = computeActiveArea(AREA, [step(bad)], (id, why) => failed.push({ id, why }));
  assert.ok(area, "one bad step must not blank the active area");
  assert.equal(km2(area).toFixed(3), km2(AREA).toFixed(3), "and must not silently eliminate anything");
  assert.deepEqual(failed, [{ id: "c1", why: "compute" }], "the failure must be reported, not swallowed");
});

test("buffering does NOT mutate the stored geometry — the memo's load-bearing assumption", () => {
  // Every memo added this session keys on geometry IDENTITY, which is only sound because stored
  // geometry is never mutated in place. `bufferGeometry` is the one place that could break that:
  // above BUFFER_SIMPLIFY_THRESHOLD it runs turf.simplify, and `feat()` only WRAPS the geometry
  // in a Feature — it does not copy the coordinates. If simplify mutated its input, every cache
  // hit afterwards would serve a buffer built from geometry the caller no longer has, and a
  // partition would stop being reproducible for the life of the game.
  //
  // The threshold matters: the repo fixture is 281 vertices and never reaches simplify, so
  // testing it alone proves nothing. This repeats the coastline to clear 500.
  const repeated = { type: "MultiLineString", coordinates: [] };
  for (let k = 0; k < 4; k++) {
    for (const part of COAST.coordinates) repeated.coordinates.push(part.map(([x, y]) => [x + k * 0.001, y]));
  }
  const verts = repeated.coordinates.reduce((n, p) => n + p.length, 0);
  assert.ok(verts > 500, `the probe must exceed the simplify threshold, got ${verts}`);

  const before = JSON.stringify(repeated);
  computeElimination(step(repeated), squareArea([72.8777, 19.076], 0.4));
  assert.equal(JSON.stringify(repeated), before, "turf.simplify must not have mutated the stored geometry");
});

test("the cache cannot pin deleted steps' geometry in memory", () => {
  const src = readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");
  assert.match(src, /_bufferCache = new WeakMap\(\)/, "must be weakly keyed on the geometry");
  assert.match(src, /_clipCache = new WeakMap\(\)/, "and so must the clip cache");
});

// ---- the clip memo -------------------------------------------------------------
//
// Memoising the buffer left the CLIP as the remaining cost: on the live 98-part Mumbai
// coastline, computeActiveArea was 148.7 ms of which this one step was 136.9 ms even with the
// buffer cached. It is keyed on (buffer, gameArea, side) by identity — safe because gameArea is
// REPLACED rather than mutated when zones change.

test("a different game area is a different clip entry, not a stale hit", () => {
  // The property the whole memo rests on. If a new board reused the old board's clip, every
  // question on the new board would eliminate against the old one — silently.
  // Sizes chosen so the answers genuinely differ. Measured, this buffer is 66.36 km2 and fits
  // entirely inside any board of 0.2 deg or more, so two large boards would BOTH clip to 66.36
  // — equal for a real reason, and useless for detecting a stale hit. At 0.1 deg the board
  // truncates the buffer (27.41 km2), which is the discriminating case.
  const geom = structuredClone(COAST);
  const small = squareArea([72.8777, 19.076], 0.1);
  const big = squareArea([72.8777, 19.076], 0.4);
  const a = km2(computeElimination(step(geom, "out"), small).eliminated);
  const b = km2(computeElimination(step(geom, "out"), big).eliminated);
  assert.ok(b > a + 1, `a bigger board must clip more coastline buffer (${b.toFixed(2)} vs ${a.toFixed(2)})`);
  const aAgain = km2(computeElimination(step(geom, "out"), small).eliminated);
  assert.equal(a.toFixed(6), aAgain.toFixed(6), "the small board's entry was corrupted by the big one");
});

test("the two sides do not share a clip entry", () => {
  const geom = structuredClone(COAST);
  const area = squareArea([72.8777, 19.076], 0.4);
  const inn = km2(computeElimination(step(geom, "in"), area).eliminated);
  const out = km2(computeElimination(step(geom, "out"), area).eliminated);
  assert.ok(Math.abs(inn - out) > 1, `"in" and "out" must not return the same clip (${inn} vs ${out})`);
  // and re-reading each must still give its own answer
  assert.equal(km2(computeElimination(step(geom, "in"), area).eliminated).toFixed(6), inn.toFixed(6));
  assert.equal(km2(computeElimination(step(geom, "out"), area).eliminated).toFixed(6), out.toFixed(6));
});

test("the clipped result is reused, not recomputed", () => {
  const geom = structuredClone(COAST);
  const area = squareArea([72.8777, 19.076], 0.4);
  computeElimination(step(geom, "in"), area);            // warm buffer AND clip
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) computeElimination(step(geom, "in"), area);
  const perCall = (performance.now() - t0) / 20;
  assert.ok(perCall < 20, `20 warm eliminations averaged ${perCall.toFixed(1)} ms each — the clip is not cached`);
});
