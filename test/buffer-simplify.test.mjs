// Auto-sourced coastlines can be brutally dense. Bergen fjords: 457 pieces, 13,405 vertices
// in a small board. Measured 2026-07-17: `turf.buffer` on that at 1 km OOMs at 4 GB heap; at
// 100 m it takes 109 s and 1.9 GB. Dead on a phone, and nothing throws until it OOMs — the
// Coastline card just froze mid-question in every Norwegian / Swedish / Greek-islands board.
//
// The fix is to Douglas–Peucker-simplify above a threshold before buffering. These tests pin
// both halves of the trade-off: dense input still produces a valid buffer instead of dying,
// and modestly-sized input isn't touched.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf, squareArea } from "./helpers/turf-env.mjs";
import { computeElimination } from "../src/tools.js";

const BOARD = squareArea([13.38, 52.5], 0.2);

// A synthetic "fjord" — many disjoint pieces, each moderately dense. This is the shape
// that OOMs: hundreds of MultiLineString pieces, ~50 vertices each.
function makeFjord(pieces = 200, vertsPerPiece = 60) {
  const coords = [];
  for (let p = 0; p < pieces; p++) {
    const cx = 13.30 + (p % 20) * 0.008, cy = 52.46 + Math.floor(p / 20) * 0.008;
    const piece = [];
    for (let i = 0; i < vertsPerPiece; i++) {
      // A jagged wiggle around (cx, cy) — like a fjord fingertip.
      piece.push([cx + i * 5e-5, cy + Math.sin(i * 0.7) * 4e-4]);
    }
    coords.push(piece);
  }
  return { type: "MultiLineString", coordinates: coords };
}

test("a dense coastline BUFFERS instead of OOMing", () => {
  // The bug this pins: turf.buffer on Bergen's coast never returned. Nothing threw; it just
  // consumed all available memory. So the check is that the elimination COMPLETES and returns
  // a real buffer polygon — a smaller pass than "the area is exactly right".
  const geom = makeFjord(200, 60); // 12,000 vertices, comparable to Bergen's 13,405
  const step = {
    id: "s", tool: "measuring", enabled: true,
    inputs: { refType: "line", refLabel: "Coastline", refSource: "osm", refGeometry: geom, distance: 1000 },
    answer: { side: "in" },
  };
  const t0 = Date.now();
  const { eliminated } = computeElimination(step, BOARD);
  const ms = Date.now() - t0;
  assert.ok(eliminated, "the buffer must produce a real region, not null");
  assert.ok(ms < 30_000, `buffer took ${ms} ms — the whole point of the fix is to be usable on a phone`);
});

test("a smooth coastline is NOT simplified — the threshold protects the fast path", () => {
  // The Mumbai case as a non-regression: 281 vertices, below the 500-vertex threshold, so no
  // simplification should run. Compare against the raw buffer to prove they agree exactly.
  const smooth = { type: "LineString", coordinates: Array.from({ length: 100 }, (_, i) => [72.80 + i * 1e-4, 19.05]) };
  const buffered = turf.buffer(turf.feature(smooth), 1000, { units: "meters" });
  const step = {
    id: "s", tool: "measuring", enabled: true,
    inputs: { refType: "line", refLabel: "Coastline", refSource: "osm", refGeometry: smooth, distance: 1000 },
    answer: { side: "in" },
  };
  const AREA = squareArea([72.85, 19.05], 0.2);
  const { eliminated } = computeElimination(step, AREA);
  const bufferedArea = turf.area(buffered);
  // Raw and threshold path should produce a buffer of the same area, because no simplify runs.
  const bufferOverBoard = turf.intersect(turf.featureCollection([buffered, turf.feature(AREA)]));
  const rawKept = bufferOverBoard ? turf.area(bufferOverBoard) : 0;
  const eliminatedArea = turf.area(turf.feature(AREA)) - turf.area(turf.feature(eliminated));
  const diff = Math.abs(eliminatedArea - rawKept);
  assert.ok(diff / rawKept < 0.01, `below the threshold the buffer must be untouched — diff ${(diff/rawKept*100).toFixed(1)}%`);
  assert.ok(bufferedArea > 0, "sanity: the buffer covers something");
});

test("simplification preserves the coastline's shape well enough to be useful", () => {
  // The complementary property to the OOM test: after simplifying, the buffer's area is still
  // close to what a naive buffer would produce. "Close" here means within ~15 % — the tolerance
  // is ~55 m and the fingertip errors this feature exists to replace are 100–500 m, so this is
  // strictly better than what shipped before.
  //
  // Uses a MODERATELY dense line (600 vertices) so the raw buffer completes in this test in
  // reasonable time; the OOM shape is exercised separately by the test above.
  const jagged = {
    type: "LineString",
    coordinates: Array.from({ length: 600 }, (_, i) => [
      13.30 + i * 1e-4,
      52.50 + Math.sin(i * 0.3) * 3e-4,
    ]),
  };
  const t0 = Date.now();
  const rawBuf = turf.buffer(turf.feature(jagged), 1000, { units: "meters" });
  const rawMs = Date.now() - t0;
  const rawArea = turf.area(rawBuf);

  // The elimination path (which simplifies internally above 500 verts).
  const step = {
    id: "s", tool: "measuring", enabled: true,
    inputs: { refType: "line", refLabel: "Coast", refSource: "osm", refGeometry: jagged, distance: 1000 },
    answer: { side: "in" },
  };
  const AREA = squareArea([13.38, 52.5], 0.3);
  const t1 = Date.now();
  const { eliminated } = computeElimination(step, AREA);
  const stepMs = Date.now() - t1;
  const boardArea = turf.area(turf.feature(AREA));
  const bufferedArea = boardArea - turf.area(turf.feature(eliminated));

  const err = Math.abs(bufferedArea - rawArea) / rawArea;
  assert.ok(err < 0.15, `simplify must preserve area within 15% (was ${(err * 100).toFixed(1)}%)`);
  assert.ok(stepMs < rawMs || stepMs < 500, `elimination should be no slower than raw buffer (raw ${rawMs} ms, step ${stepMs} ms)`);
});
