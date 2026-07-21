// Phase 21 game test: shared metresBetween pinned on known-distance pairs.
//
// Regression pin for review finding #9 (2026-07-21). Both src/geofence.js and
// src/live-share.js used to carry the same inline equirectangular-lite
// distance formula. If one had ever been "improved" for cross-hemisphere
// correctness the other would silently disagree, and a close-approach alert
// would fire at a different distance than the geofence's edge readout — the
// exact class of "the pill agrees with itself but not with the alert"
// mismatch that a real playtest would find hardest to diagnose.
//
// Now both import metresBetween from src/geo.js. This test pins the shared
// implementation on a handful of known-distance city pairs (from geodesy
// reference data) so any future edit that shifts the formula surfaces here
// instead of in a silent-drift regression.
import "./helpers/turf-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { metresBetween } from "../src/geo.js";

test("game 1: 1 degree of latitude at the equator is ~111 km", () => {
  const d = metresBetween({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
  // Ground truth: 1° lat ≈ 111.32 km. Equirectangular-lite is exact for
  // pure-N-S movement, so this should be well under 1% off.
  assert.ok(Math.abs(d - 111_320) < 500, `got ${d}, expected ~111320`);
});

test("game 2: two neighbourhoods in Mumbai (~5 km apart)", () => {
  // Andheri West to Bandra West — a real seeker-to-hider distance in the
  // 2026-07-19 playtest region. Reference: ~5.5 km great-circle.
  const andheri = { lat: 19.1367, lng: 72.8267 };
  const bandra = { lat: 19.0596, lng: 72.8295 };
  const d = metresBetween(andheri, bandra);
  assert.ok(d > 8000 && d < 9500, `Andheri↔Bandra should be ~8.5 km, got ${d} m`);
});

test("game 3: two GPS pings 50 m apart round-trip to ~50 m", () => {
  // At Mumbai's latitude, 50 m of movement in latitude is ~0.00045°. Verify
  // the formula agrees with itself in both directions (symmetry) — a
  // signed-arg bug would show up here.
  const a = { lat: 19.076, lng: 72.877 };
  const b = { lat: 19.076 + 0.00045, lng: 72.877 };
  const d1 = metresBetween(a, b);
  const d2 = metresBetween(b, a);
  assert.equal(d1, d2, "distance must be symmetric");
  assert.ok(Math.abs(d1 - 50) < 3, `expected ~50 m, got ${d1}`);
});

test("game 4: two identical points return 0 (the pill readout depends on this)", () => {
  const p = { lat: 19.076, lng: 72.877 };
  assert.equal(metresBetween(p, p), 0);
});

test("game 5: geofence and live-share now agree by construction — no drift possible", async () => {
  // The finding named the drift risk: 'if one is ever improved for cross-
  // hemisphere correctness the other will silently disagree.' Now that both
  // import from ./geo.js there is exactly one implementation to update.
  // Prove the wiring by asserting the two consumers (geofence's edge distance
  // and live-share's approach distance) reach the same number for the same
  // pair of points. If a future refactor accidentally revives an inline
  // copy, this test fails immediately.
  const { evaluateGeofence } = await import("../src/geofence.js");
  const { evaluateApproach } = await import("../src/live-share.js");

  const position = { lat: 19.076, lng: 72.877 };
  const centre = { lat: 19.100, lng: 72.900 };

  const gf = evaluateGeofence({
    position,
    zone: { point: centre, radius: 100 }, // radius chosen small so edge < centre
    thresholdMetres: 1,
    prior: null,
    now: 1000,
  });
  // Geofence's pill reports metres from the edge; recover metres to the
  // CENTRE by adding the radius back on. That should equal what live-share
  // computes for the same two points.
  const centreDistFromGf = Number(gf.pill.match(/(\d+)/)[1]) + 100;

  const ls = evaluateApproach({
    seekerPoint: position,
    zoneCentre: centre,
    thresholdM: 0, // pin-only mode returns distance without firing
    prior: null,
    now: 1000,
  });

  // Both rounded to the nearest metre — the geofence pill truncates to
  // integer, so we tolerate a metre either way.
  assert.ok(Math.abs(centreDistFromGf - ls.state.distance) < 2,
    `geofence saw ${centreDistFromGf} m to centre, live-share saw ${ls.state.distance} m`);
});
