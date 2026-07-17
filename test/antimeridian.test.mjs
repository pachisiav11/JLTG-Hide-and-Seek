// D2 — a board across the ±180° line is refused, not silently wrapped.
//
// The finding predicted: "a zone straddling ±180° makes unionRings return null -> gameArea is
// null -> every tool reports 'Add a zone first' after a zone was added", and prescribed a
// minimum fix of distinguishing "union failed" from "no zones".
//
// MEASURED 2026-07-17: the premise is wrong and the prescribed fix would have been a NO-OP.
// unionRings does not fail and does not return null. It returns a perfectly valid Polygon of
// 851,313 km² for a Fiji board whose intended size is ~470 km² — roughly 1800x too big,
// spanning the Pacific, because turf reads the +179.9 -> -179.9 edge as going the long way
// round. Nothing throws, and there is no misleading message to fix: there is a board that is
// silently, enormously wrong.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf } from "./helpers/turf-env.mjs";
import { ringCrossesAntimeridian, unionRings } from "../src/geo.js";

// Rings are [lat,lng]. Google normalises lng to [-180,180], so tapping a box across the date
// line near Taveuni, Fiji yields +179.9 then -179.9.
const FIJI_STRADDLE = [[-16.8, 179.9], [-16.8, -179.9], [-17.0, -179.9], [-17.0, 179.9]];
const FIJI_BESIDE = [[-16.8, 179.5], [-16.8, 179.9], [-17.0, 179.9], [-17.0, 179.5]];
const MUMBAI = [[19.03, 72.83], [19.03, 72.93], [19.13, 72.93], [19.13, 72.83]];
const GREENWICH = [[51.4, -0.1], [51.4, 0.1], [51.6, 0.1], [51.6, -0.1]]; // crosses 0°, not 180°

test("a ring across the date line is detected", () => {
  assert.equal(ringCrossesAntimeridian(FIJI_STRADDLE), true);
});

test("ordinary boards are not — including one straddling the PRIME meridian", () => {
  // The false positive that would matter most: crossing 0° is completely normal (any London
  // board does it) and must not be confused with crossing 180°.
  assert.equal(ringCrossesAntimeridian(GREENWICH), false);
  assert.equal(ringCrossesAntimeridian(MUMBAI), false);
  assert.equal(ringCrossesAntimeridian(FIJI_BESIDE), false, "179.5–179.9 is near the line but does not cross it");
});

test("the CLOSING edge is checked", () => {
  // The ring closes implicitly, so a crossing can live on the last->first edge alone.
  const closingOnly = [[-16.8, 179.9], [-16.9, 179.95], [-17.0, -179.9]];
  assert.equal(ringCrossesAntimeridian(closingOnly), true);
});

test("degenerate input is not a crossing", () => {
  assert.equal(ringCrossesAntimeridian(null), false);
  assert.equal(ringCrossesAntimeridian([]), false);
  assert.equal(ringCrossesAntimeridian([[19, 72]]), false);
});

test("WHY it is refused: the board silently becomes ~1800x its size, and nothing fails", () => {
  // This is the state the guard prevents, and the reason the finding's prescribed fix
  // (distinguish "union failed" from "no zones") would have changed nothing: the union
  // does not fail. There is no error to report — only a wrong board.
  const wrapped = unionRings([FIJI_STRADDLE]);
  assert.ok(wrapped, "unionRings does NOT return null — the finding's premise");
  const km2 = turf.area(turf.feature(wrapped)) / 1e6;
  assert.ok(km2 > 500_000, `expected a wrapped board of ~851,000 km², got ${Math.round(km2)}`);

  // The same box moved 0.4° west — the board the player actually meant — is ~470 km².
  const intended = turf.area(turf.feature(unionRings([FIJI_BESIDE]))) / 1e6;
  assert.ok(intended < 2000, `the intended board is ~950 km², got ${Math.round(intended)}`);
  assert.ok(km2 / intended > 100, "the wrapped board is orders of magnitude too large");
});

test("WHY unwrapping was not attempted: it is a half fix that hides a POI", () => {
  // Unwrapping the ring alone DOES fix the area — but it is not enough, and shipping it would
  // trade a visible 1800x board for an invisible false elimination. Every point entering the
  // geometry layer (Places, Overpass, seeker positions, radar centres) would have to be
  // unwrapped into the same frame. This test records that, so the half fix isn't attempted
  // later on the assumption it works.
  const unwrap = (ring) => {
    const l0 = ring[0][1];
    return ring.map(([lat, lng]) => {
      let d = lng - l0;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      return [lat, l0 + d];
    });
  };
  const toPoly = (ring) => {
    const r = ring.map(([lat, lng]) => [lng, lat]);
    r.push([...r[0]]);
    return turf.polygon([r]);
  };

  const unwrapped = toPoly(unwrap(FIJI_STRADDLE));
  const km2 = turf.area(unwrapped) / 1e6;
  assert.ok(km2 > 400 && km2 < 550, `unwrapping fixes the AREA (~473 km²), got ${Math.round(km2)}`);

  // ...but a POI inside that board, with the longitude Places actually returns, is now missed.
  const asPlacesReturnsIt = turf.point([-179.95, -16.9]);
  assert.equal(
    turf.booleanPointInPolygon(asPlacesReturnsIt, unwrapped), false,
    "a POI genuinely inside the board reads as OUTSIDE unless it is unwrapped into the same frame",
  );
  assert.equal(
    turf.booleanPointInPolygon(turf.point([180.05, -16.9]), unwrapped), true,
    "the same point, unwrapped, is correctly inside — which is the whole pipeline's problem",
  );
});
