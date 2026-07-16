// A2 — the Thermometer must eliminate a half-plane, not a fixed-size strip.
//
// The old code used a hardcoded L = 3 (~330 km half-extent) with a comment claiming it
// "covers any play area". Jet Lag S1 was played across whole countries, so that is the
// normal case, not an edge case. On a Japan-sized board a Tokyo->Osaka "hotter" answer
// eliminated a band across the middle and left Sapporo — unambiguously colder — alive.
// Nothing threw; the board just quietly kept a region the answer had ruled out.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf } from "./helpers/turf-env.mjs";
import { computeElimination } from "../src/tools.js";

const TOKYO = { lat: 35.6762, lng: 139.6503 };
const OSAKA = { lat: 34.6937, lng: 135.5023 };
const SAPPORO = [141.35, 43.07];

// A Japan-scale board: the case the fixed strip could not span.
const JAPAN = {
  type: "Polygon",
  coordinates: [[[129, 31], [146, 31], [146, 46], [129, 46], [129, 31]]],
};

const thermoStep = (side, a = TOKYO, b = OSAKA) => ({
  id: "t1", tool: "thermometer", enabled: true, inputs: { a, b }, answer: { side },
});

const contains = (geom, pt) =>
  turf.booleanPointInPolygon(turf.point(pt), turf.feature(geom));

test("country-scale: 'hotter' (closer to Osaka) eliminates Sapporo", () => {
  const { eliminated } = computeElimination(thermoStep("hotter"), JAPAN);
  assert.ok(eliminated, "must eliminate something");
  // Sapporo is far from Osaka and on Tokyo's side, so a 'hotter' answer rules it out.
  // This is the exact regression: the ±3° strip never reached 43°N.
  assert.ok(contains(eliminated, SAPPORO), "Sapporo must be eliminated by a 'hotter' answer");
});

test("country-scale: 'colder' eliminates the far side instead, not Sapporo", () => {
  const { eliminated } = computeElimination(thermoStep("colder"), JAPAN);
  assert.ok(eliminated, "must eliminate something");
  assert.ok(!contains(eliminated, SAPPORO), "Sapporo is on the colder side; it must survive");
});

test("country-scale: eliminates roughly half the board, not a fraction of it", () => {
  const { eliminated } = computeElimination(thermoStep("hotter"), JAPAN);
  const boardKm2 = turf.area(turf.feature(JAPAN)) / 1e6;
  const elimKm2 = turf.area(turf.feature(eliminated)) / 1e6;
  const frac = elimKm2 / boardKm2;
  // A bisector splits the board; the exact share depends on where the line falls, but a
  // half-plane can never be the ~18% the old fixed strip produced here.
  assert.ok(frac > 0.3 && frac < 0.7, `expected roughly half the board, got ${(frac * 100).toFixed(1)}%`);
});

test("the two answers partition the board: together they cover it, and they don't overlap", () => {
  const hot = computeElimination(thermoStep("hotter"), JAPAN).eliminated;
  const cold = computeElimination(thermoStep("colder"), JAPAN).eliminated;
  const board = turf.area(turf.feature(JAPAN));
  const sum = turf.area(turf.feature(hot)) + turf.area(turf.feature(cold));
  // Complementary halves must reconstruct the whole board (within polygon-precision).
  assert.ok(Math.abs(sum - board) / board < 0.02, "hotter + colder should cover the board");

  const overlap = turf.intersect(turf.featureCollection([turf.feature(hot), turf.feature(cold)]));
  const overlapArea = overlap ? turf.area(overlap) : 0;
  assert.ok(overlapArea / board < 0.02, "the two sides must not overlap");
});

test("city-scale still works (no regression from the old constant)", () => {
  // ~20 km board around Mumbai: the size the old constant happened to handle.
  const city = {
    type: "Polygon",
    coordinates: [[[72.7777, 18.976], [72.9777, 18.976], [72.9777, 19.176], [72.7777, 19.176], [72.7777, 18.976]]],
  };
  const a = { lat: 19.03, lng: 72.82 };
  const b = { lat: 19.12, lng: 72.94 };
  const { eliminated } = computeElimination(thermoStep("hotter", a, b), city);
  const frac = turf.area(turf.feature(eliminated)) / turf.area(turf.feature(city));
  assert.ok(frac > 0.2 && frac < 0.8, `city-scale split should be substantial, got ${(frac * 100).toFixed(1)}%`);
});

test("high latitude: longitude compression doesn't shrink the strip", () => {
  // At 60°N a degree of longitude is half its equatorial width. Projected units must be
  // used consistently or the derived extent comes out short.
  const nordic = {
    type: "Polygon",
    coordinates: [[[5, 58], [31, 58], [31, 70], [5, 70], [5, 58]]],
  };
  const a = { lat: 59.91, lng: 10.75 };  // Oslo
  const b = { lat: 60.17, lng: 24.94 };  // Helsinki
  const { eliminated } = computeElimination(thermoStep("hotter", a, b), nordic);
  const frac = turf.area(turf.feature(eliminated)) / turf.area(turf.feature(nordic));
  assert.ok(frac > 0.3 && frac < 0.7, `expected roughly half at high latitude, got ${(frac * 100).toFixed(1)}%`);
});
