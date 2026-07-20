// Phase 3 game test: hider drifts inside → near-edge → outside → back → outside.
//
// The playtest that generated this phase (PLAYTEST_2026-07-19) recorded that hiders
// don't check whether they're still inside the zone during the 45-minute hide — a
// button they'd need to remember to press doesn't catch drift. This test drives a
// realistic drift path through `evaluateGeofence` (the pure decision function the
// Geofence class calls on every GPS tick) and asserts the notification kinds fire
// in the right order, at the right times, and stop firing when the situation
// stabilises.
import test from "node:test";
import assert from "node:assert/strict";

// The module reaches store.js at import time (for the live Geofence class), which
// installs a `pagehide` listener on `window`. The test env doesn't provide one, so
// mirror the shim helpers/turf-env.mjs does — noop event registration is enough.
const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };

const { evaluateGeofence } = await import("../src/geofence.js");

// A hiding zone in Mumbai (Devipada-ish), 500 m radius.
const zone = { point: { lat: 19.2400, lng: 72.8700 }, radius: 500 };
const threshold = 100; // warn within 100 m of the edge

// Tiny helper: shift a point by (dLat, dLng) in degrees.
const at = (dLat, dLng) => ({ lat: zone.point.lat + dLat, lng: zone.point.lng + dLng });

test("game 1: a hider deep inside the zone gets no notification, just a pill", () => {
  const out = evaluateGeofence({ position: zone.point, zone, thresholdMetres: threshold, prior: null });
  assert.equal(out.notify, null, "deep inside → no alert");
  assert.match(out.pill, /^In zone/);
});

test("game 2: drifting to within 80 m of the edge fires an approaching alert", () => {
  // ~400 m north of the centre; the radius is 500, so ~100 m from the edge.
  // (1° lat ≈ 111 km, so 0.0036° ≈ 400 m.)
  const position = at(0.0036, 0);
  const prior = { inside: true, lastEdge: 300, lastCentre: 200 }; // was deeper in
  const out = evaluateGeofence({ position, zone, thresholdMetres: threshold, prior, now: 1_000_000 });
  assert.ok(out.notify, "close to the edge → an alert must fire");
  assert.equal(out.notify.kind, "approaching");
  assert.match(out.notify.body, /turn back/i);
});

test("game 3: crossing the edge outward fires a 'crossed-out' alert, not 'approaching'", () => {
  // Was inside; now 30 m OUTSIDE the boundary.
  const position = at(0.0048, 0); // ~533 m from centre, radius 500 → ~33 m out
  const prior = { inside: true, lastEdge: 50, lastCentre: 450 };
  const out = evaluateGeofence({ position, zone, thresholdMetres: threshold, prior, now: 2_000_000 });
  assert.ok(out.notify);
  assert.equal(out.notify.kind, "crossed-out", "crossing must win over approaching on the same tick");
  assert.match(out.notify.body, /return/i);
  assert.match(out.pill, /^OUT of zone/);
});

test("game 4: still outside on the next tick nudges again once, then is silent", () => {
  const position = at(0.0048, 0);
  // Simulate the state right after the crossing alert fired (from game 3).
  const t0 = 3_000_000;
  const prior = {
    inside: false, lastEdge: 33, lastCentre: 533,
    notify: { side: "out", at: t0, reason: "crossed" },
  };
  // A tick 10 s later — same side, well within the debounce.
  const soon = evaluateGeofence({ position, zone, thresholdMetres: threshold, prior, now: t0 + 10_000 });
  assert.equal(soon.notify, null, "within debounce → do NOT re-alert on every tick");
  // A tick past the 60 s debounce — same side, past debounce → renotify.
  const later = evaluateGeofence({ position, zone, thresholdMetres: threshold, prior, now: t0 + 61_000 });
  assert.ok(later.notify, "past debounce → a still-out reminder is due");
  assert.equal(later.notify.kind, "still-out");
});

test("game 5: coming back in fires 'back-in' — the crossing rearms the debounce", () => {
  const position = at(0.0018, 0); // ~200 m from centre → inside by ~300 m
  const prior = { inside: false, lastEdge: 33, lastCentre: 533, notify: { side: "out", at: 3_000_000, reason: "crossed" } };
  const out = evaluateGeofence({ position, zone, thresholdMetres: threshold, prior, now: 3_005_000 });
  assert.ok(out.notify);
  assert.equal(out.notify.kind, "back-in");
  assert.match(out.pill, /^In zone/);
});

test("game 6: threshold = 0 disables the whole feature (playtest safety net)", () => {
  // Settings ▸ Off must silence everything, including the pill — a hider who turned
  // it off should not see a stale distance readout after their next tick.
  const position = at(0.0036, 0);
  const out = evaluateGeofence({ position, zone, thresholdMetres: 0, prior: null });
  assert.equal(out.notify, null);
  assert.equal(out.pill, null, "off means off — no visible indicator either");
});

test("game 7: no radius = the Hider tool is 'marker only', so geofence stays quiet", () => {
  // focusZone can be a bare point (no radius) — the Hider tool's "marker only" mode.
  // Without a radius there is no edge to measure against, so this feature must skip
  // cleanly rather than throw or warn at 0 m from a non-existent boundary.
  const bareZone = { point: zone.point, radius: null };
  const out = evaluateGeofence({ position: zone.point, zone: bareZone, thresholdMetres: 100, prior: null });
  assert.equal(out.notify, null);
  assert.equal(out.pill, null);
});

test("game 8: the whole hide-time drift — a scripted walk-through", () => {
  // A realistic sequence: hider settles, drifts north, brushes the edge, steps out,
  // gets shooed back by the alert, and returns. Only the notifications that would
  // actually fire are counted — that is the whole point of the module.
  const script = [
    { at: at(0, 0),          reason: "settled" },
    { at: at(0.001, 0),      reason: "shifting north" },
    { at: at(0.0025, 0),     reason: "getting close to edge" },
    { at: at(0.0037, 0),     reason: "within 100 m of edge" },
    { at: at(0.005, 0),      reason: "crossed out" },
    { at: at(0.0025, 0),     reason: "back in" },
  ];
  let prior = null;
  let now = 0;
  const fired = [];
  for (const step of script) {
    now += 30_000; // ticks 30 s apart
    const { state, notify } = evaluateGeofence({ position: step.at, zone, thresholdMetres: threshold, prior, now });
    if (notify) fired.push(notify.kind);
    prior = state;
  }
  // The salient events, in order: an approaching warning as the hider nears the edge,
  // a crossed-out alert when they step over, and a back-in when they return.
  // "still-out" would only fire if they lingered past the 60 s debounce, which the
  // 30 s ticks here don't reach.
  assert.deepEqual(fired, ["approaching", "crossed-out", "back-in"]);
});
