// A1 — a fully-eliminated board must be distinguishable from a fresh one.
//
// The bug these guard against is silent: computeActiveArea returned null when the
// eliminations covered the whole board, the renderer did `active || g.gameArea`, and a
// dead game drew pixel-identically to an untouched one. Nothing threw, so no banner.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { squareArea, radarStep } from "./helpers/turf-env.mjs";
import { computeActiveArea, EMPTY_AREA } from "../src/tools.js";

const AREA = squareArea(); // ~0.2° square around Mumbai

test("no game area yields null (not the empty sentinel)", () => {
  assert.equal(computeActiveArea(null, []), null);
});

test("no enabled steps yields the whole game area", () => {
  assert.equal(computeActiveArea(AREA, []), AREA);
  const disabled = radarStep({ radiusM: 100_000, side: "out", enabled: false });
  assert.equal(computeActiveArea(AREA, [disabled]), AREA);
});

test("a partial elimination yields real geometry, not the sentinel", () => {
  // A small circle answered "out" removes only its interior.
  const step = radarStep({ radiusM: 2_000, side: "out" });
  const active = computeActiveArea(AREA, [step]);
  assert.notEqual(active, EMPTY_AREA);
  assert.ok(active && (active.type === "Polygon" || active.type === "MultiPolygon"));
});

test("eliminating the whole board yields EMPTY_AREA, never null", () => {
  // A circle far larger than the board, answered "out", removes everything.
  const step = radarStep({ radiusM: 500_000, side: "out" });
  const active = computeActiveArea(AREA, [step]);

  // The precise regression: null here is what made a dead board render as fresh,
  // because the caller fell back to `active || g.gameArea`.
  assert.notEqual(active, null, "must not be null — the renderer falls back to gameArea on null");
  assert.equal(active, EMPTY_AREA);
});

test("EMPTY_AREA is falsy-safe: it must not be mistaken for absent geometry", () => {
  // The renderer branches on identity, so the sentinel has to be a truthy object;
  // were it falsy, `active || g.gameArea` would resurrect the old bug silently.
  assert.ok(EMPTY_AREA, "sentinel must be truthy");
  assert.notEqual(EMPTY_AREA, null);
});

test("two steps that only jointly cover the board still yield EMPTY_AREA", () => {
  // The board is ~21 km across (0.2° at lat 19°), so the circles are sized against that:
  // 16 km from each edge-midpoint reaches the far corners (~15.3 km) but not the opposite
  // edge (~21 km). Neither alone clears the board; unioned they do. Guards the union path.
  const west = radarStep({ center: [72.7777, 19.076], radiusM: 16_000, side: "out", id: "w" });
  const east = radarStep({ center: [72.9777, 19.076], radiusM: 16_000, side: "out", id: "e" });

  assert.notEqual(computeActiveArea(AREA, [west]), EMPTY_AREA, "west alone should not clear the board");
  assert.notEqual(computeActiveArea(AREA, [east]), EMPTY_AREA, "east alone should not clear the board");
  assert.equal(computeActiveArea(AREA, [west, east]), EMPTY_AREA);
});
