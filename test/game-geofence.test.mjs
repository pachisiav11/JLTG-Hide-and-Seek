// Phase 3 + Phase 32 game test: hider drifts inside → near-edge → outside → back.
//
// The playtest that generated Phase 3 recorded that hiders don't check whether
// they're still inside the zone during the 45-minute hide. Phase 32 (req #6)
// then replaced the old every-minute "still outside" nudge with an EDGE-TRIGGERED
// state machine over three bands — safe / near / out — that fires ONCE per band
// change and stays silent while parked in a band. This test drives realistic
// drift paths through `evaluateGeofence` (the pure decision function the Geofence
// class calls on every GPS tick) and pins that new contract.
import test from "node:test";
import assert from "node:assert/strict";

const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };

const { evaluateGeofence } = await import("../src/geofence.js");

// A hiding zone in Mumbai (Devipada-ish), 500 m radius.
const zone = { point: { lat: 19.2400, lng: 72.8700 }, radius: 500 };
const threshold = 100; // warn within 100 m of the edge

// Tiny helper: shift a point by (dLat, dLng) in degrees.
const at = (dLat, dLng) => ({ lat: zone.point.lat + dLat, lng: zone.point.lng + dLng });
// Drive one tick from a prior state.
const step = (position, prior) => evaluateGeofence({ position, zone, thresholdMetres: threshold, prior });

test("game 1: the first fix establishes a band silently — no boot-tick alert", () => {
  const out = step(zone.point, null);
  assert.equal(out.notify, null, "deep inside on the first fix → no alert, just a baseline");
  assert.equal(out.state.band, "safe");
  assert.match(out.pill, /^In zone/);
});

test("game 2: safe → near fires exactly one 'approaching' alert", () => {
  const safe = step(at(0.001, 0), null);       // baseline, comfortably inside
  assert.equal(safe.state.band, "safe");
  const near = step(at(0.0036, 0), safe.state); // ~400 m N of centre → ~100 m from a 500 m edge
  assert.equal(near.state.band, "near");
  assert.ok(near.notify, "crossing safe → near must alert");
  assert.equal(near.notify.kind, "approaching");
  assert.match(near.notify.body, /turn back/i);
});

test("game 3: parked in the near band is silent on every subsequent tick", () => {
  let s = step(at(0.001, 0), null).state;         // safe baseline
  const first = step(at(0.0042, 0), s);           // ~467 m from centre → ~33 m from edge → near
  assert.equal(first.state.band, "near");
  assert.equal(first.notify.kind, "approaching");
  // Three more ticks hovering solidly in the near band — not a single repeat.
  let prior = first.state;
  for (const d of [0.00425, 0.0041, 0.00435]) {
    const tick = step(at(d, 0), prior);
    assert.equal(tick.state.band, "near");
    assert.equal(tick.notify, null, "no re-alert while parked in the near band");
    prior = tick.state;
  }
});

test("game 4: near → out fires 'crossed-out', not 'approaching'", () => {
  const near = step(at(0.0036, 0), step(at(0.001, 0), null).state);
  const out = step(at(0.0048, 0), near.state); // ~533 m from centre → ~33 m outside
  assert.equal(out.state.band, "out");
  assert.ok(out.notify);
  assert.equal(out.notify.kind, "crossed-out", "crossing out must win over approaching");
  assert.match(out.notify.body, /return/i);
  assert.match(out.pill, /^OUT of zone/);
});

test("game 5: parked OUTSIDE stays silent — the every-minute nudge is gone", () => {
  // Land outside, then sit there for several ticks. The old code re-nudged every
  // 60 s; the new machine says nothing until the band changes again.
  let prior = step(at(0.0048, 0), step(at(0.0036, 0), step(at(0.001, 0), null).state).state).state;
  assert.equal(prior.band, "out");
  for (const d of [0.0049, 0.005, 0.0051]) {
    const tick = step(at(d, 0), prior);
    assert.equal(tick.state.band, "out");
    assert.equal(tick.notify, null, "parked outside must not re-alert");
    prior = tick.state;
  }
});

test("game 6: out → back inside fires 'back-in' (landing in near or safe)", () => {
  const outState = { band: "out", inside: false, lastEdge: 33, lastCentre: 533 };
  // Return to ~200 m from centre → deep inside (safe).
  const back = step(at(0.0018, 0), outState);
  assert.ok(back.notify);
  assert.equal(back.notify.kind, "back-in");
  assert.match(back.pill, /^In zone/);
  // Returning but only as far as the near band still counts as back-in.
  const backNear = step(at(0.0037, 0), outState);
  assert.equal(backNear.state.band, "near");
  assert.equal(backNear.notify.kind, "back-in", "re-entry into the near band is still 'back in', not 'approaching'");
});

test("game 7: near → safe (moving deeper inside) is silent", () => {
  const near = step(at(0.0036, 0), step(at(0.001, 0), null).state);
  assert.equal(near.state.band, "near");
  const safe = step(at(0.0005, 0), near.state); // retreat toward the centre
  assert.equal(safe.state.band, "safe");
  assert.equal(safe.notify, null, "moving away from the edge back to safe needs no alert");
});

test("game 8: threshold = 0 disables the whole feature, pill included", () => {
  const out = evaluateGeofence({ position: at(0.0036, 0), zone, thresholdMetres: 0, prior: null });
  assert.equal(out.notify, null);
  assert.equal(out.pill, null, "off means off — no visible indicator either");
});

test("game 9: no radius = 'marker only', so geofence stays quiet", () => {
  const bareZone = { point: zone.point, radius: null };
  const out = evaluateGeofence({ position: zone.point, zone: bareZone, thresholdMetres: 100, prior: null });
  assert.equal(out.notify, null);
  assert.equal(out.pill, null);
});

test("game 10: the full scripted walk — one alert per transition, re-exit re-alerts", () => {
  // safe → near → out → near → safe, then out again. Each band change fires once;
  // hovering never repeats.
  const script = [
    at(0, 0),        // settle (safe, baseline)
    at(0.001, 0),    // still safe
    at(0.0036, 0),   // near   → approaching
    at(0.005, 0),    // out    → crossed-out
    at(0.0037, 0),   // near   → back-in (came from out)
    at(0.0005, 0),   // safe   → silent
    at(0.005, 0),    // out    → crossed-out again (re-exit re-alerts)
  ];
  let prior = null;
  const fired = [];
  for (const p of script) {
    const { state, notify } = step(p, prior);
    if (notify) fired.push(notify.kind);
    prior = state;
  }
  assert.deepEqual(fired, ["approaching", "crossed-out", "back-in", "crossed-out"]);
});
