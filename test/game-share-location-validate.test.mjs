// Phase 18 game test: server-side share-location payload validator.
//
// Regression pin for review finding #6 (2026-07-21). The relay's
// `share-location` handler used to accept any finite lat/lng and rebroadcast
// it. Number.isFinite(9999) is true, so a rogue seeker (or a buggy
// geolocation stub returning a sentinel value) could inject coordinates far
// off the globe; the hider's client would compute a giant distance, corrupt
// the pill readout, and any future code that plots the pin on the map would
// jump to nowhere.
//
// The pure validator lives in share-location.js so this test can pin it
// without booting server.js's HTTP + Socket.IO listener. server.js imports
// the same function into its share-location handler.
import test from "node:test";
import assert from "node:assert/strict";
import { isValidLocationPayload } from "../share-location.js";

test("game 1: real Mumbai coordinates pass", () => {
  assert.equal(isValidLocationPayload({ lat: 19.076, lng: 72.877 }), true);
  assert.equal(isValidLocationPayload({ lat: 0, lng: 0 }), true, "null island is a real coordinate");
  assert.equal(isValidLocationPayload({ lat: -33.87, lng: 151.21 }), true, "southern hemisphere too");
});

test("game 2: off-globe coordinates fail — the whole point of this fix", () => {
  // The exact rogue-payload the finding named.
  assert.equal(isValidLocationPayload({ lat: 9999, lng: -9999 }), false);
  // The boundaries themselves are legal.
  assert.equal(isValidLocationPayload({ lat: 90, lng: 180 }), true);
  assert.equal(isValidLocationPayload({ lat: -90, lng: -180 }), true);
  // Just past the boundaries are not.
  assert.equal(isValidLocationPayload({ lat: 90.0001, lng: 0 }), false);
  assert.equal(isValidLocationPayload({ lat: 0, lng: 180.0001 }), false);
  assert.equal(isValidLocationPayload({ lat: -90.0001, lng: 0 }), false);
  assert.equal(isValidLocationPayload({ lat: 0, lng: -180.0001 }), false);
});

test("game 3: non-finite or non-numeric values fail (pre-existing behaviour)", () => {
  assert.equal(isValidLocationPayload({ lat: NaN, lng: 0 }), false);
  assert.equal(isValidLocationPayload({ lat: Infinity, lng: 0 }), false);
  assert.equal(isValidLocationPayload({ lat: "19.076", lng: 72.877 }), false, "strings are not accepted");
  assert.equal(isValidLocationPayload({ lng: 72.877 }), false, "missing lat");
  assert.equal(isValidLocationPayload({ lat: 19.076 }), false, "missing lng");
  assert.equal(isValidLocationPayload({}), false);
  assert.equal(isValidLocationPayload(null), false);
  assert.equal(isValidLocationPayload(undefined), false);
  assert.equal(isValidLocationPayload(42), false);
});

test("game 4: the exact server-side call site still handles rejected payloads by silent drop", () => {
  // Simulate the handler: if isValidLocationPayload is false, nothing is
  // emitted. This test guards the CONTRACT that a bad payload is a no-op,
  // not an error surfaced to the hider (who did nothing wrong).
  const emitted = [];
  const socketMock = { to: () => ({ emit: (ev, data) => emitted.push({ ev, data }) }) };
  const payloads = [
    { lat: 9999, lng: 0 },
    { lat: 0, lng: -181 },
    { lat: "bad", lng: 0 },
    null,
  ];
  for (const payload of payloads) {
    if (!isValidLocationPayload(payload)) continue; // <- exact server-side gate
    socketMock.to("room").emit("location", { lat: payload.lat, lng: payload.lng, at: Date.now() });
  }
  assert.equal(emitted.length, 0, "not one bad payload made it past the gate");
});

test("game 5: extra properties on a payload don't break the check", () => {
  // A real client's geolocation ping may carry accuracy, heading, etc. The
  // gate must not reject those — it only checks lat/lng.
  const rich = { lat: 19.076, lng: 72.877, accuracy: 12.5, heading: 47, speed: 1.2 };
  assert.equal(isValidLocationPayload(rich), true);
});
