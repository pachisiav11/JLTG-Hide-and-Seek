// Phase 11 (§C2) game test: the format the "Copy my location" button writes
// to the clipboard is a clean, fixed-precision "lat, lng" pair.
import test from "node:test";
import assert from "node:assert/strict";
import { formatLocationForClipboard } from "../src/ingest.js";

test("game 1: formatLocationForClipboard renders a fixed 5dp 'lat, lng' pair", () => {
  const cases = [
    [19.076, 72.8777, "19.07600, 72.87770"],
    [-33.8688, 151.2093, "-33.86880, 151.20930"],  // Sydney (southern + eastern hemisphere)
    [40.7128, -74.0060, "40.71280, -74.00600"],    // New York (northern + western)
    [0.0001, 0.0001, "0.00010, 0.00010"],          // near the equator/meridian — sub-metre precision
    [-89.9999, 179.9999, "-89.99990, 179.99990"],  // near the antipodes
  ];
  for (const [lat, lng, expected] of cases) {
    assert.equal(formatLocationForClipboard(lat, lng), expected);
  }
});

test("game 2: refuses non-finite input rather than writing NaN to the clipboard", () => {
  assert.equal(formatLocationForClipboard(NaN, 0), null);
  assert.equal(formatLocationForClipboard(0, undefined), null);
  assert.equal(formatLocationForClipboard(Infinity, 0), null);
});

test("game 3: the output shape matches WhatsApp's typical readable form (lat, lng with 5dp)", () => {
  const text = formatLocationForClipboard(19.076, 72.8777);
  assert.equal(text, "19.07600, 72.87770");
});
