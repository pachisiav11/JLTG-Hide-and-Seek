// Phase 11 (§C2) game test: the format the "Copy my location" button writes
// to the clipboard is EXACTLY the shape A2's parseSeekerLocation accepts.
//
// The two features are symmetric — seeker copies here, hider pastes there.
// If they drift out of alignment, the paste will fail on the hider's device
// and the round-trip is broken silently. This test welds them together.
import test from "node:test";
import assert from "node:assert/strict";
import { formatLocationForClipboard, parseSeekerLocation } from "../src/ingest.js";

test("game 1: formatLocationForClipboard is the mirror of parseSeekerLocation — round trips", () => {
  const cases = [
    [19.076, 72.8777],
    [-33.8688, 151.2093],  // Sydney (southern + eastern hemisphere)
    [40.7128, -74.0060],   // New York (northern + western)
    [0.0001, 0.0001],      // near the equator/meridian — sub-metre precision
    [-89.9999, 179.9999],  // near the antipodes
  ];
  for (const [lat, lng] of cases) {
    const text = formatLocationForClipboard(lat, lng);
    const parsed = parseSeekerLocation(text);
    assert.ok(parsed, `${text} must be parseable by parseSeekerLocation`);
    assert.ok(Math.abs(parsed.lat - lat) < 1e-4, `lat roundtrip: ${parsed.lat} vs ${lat}`);
    assert.ok(Math.abs(parsed.lng - lng) < 1e-4, `lng roundtrip: ${parsed.lng} vs ${lng}`);
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
