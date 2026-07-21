// Phase 13 game test: "Off (pin only)" live-share mode must not crash the hider.
//
// Regression pin for the review finding #1 (2026-07-21): _onSeekerPing
// dereferenced `out.state.distance` on the first seeker ping while
// approachThresholdM was 0 (the "Off (pin only)" radio in games.js:525).
// evaluateApproach was collapsing "no signal" and "threshold disabled" into
// the same null state, so the hider tab threw once and stopped rendering
// live-share for the rest of the game.
//
// The scenario simulates the real playtest choice: the hider says "I don't
// want a system notification, just show me the seekers on the pill", picks
// pin-only, then a seeker ping arrives. The pill must update with a real
// distance, no notification must fire, and repeated pings must keep working.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/turf-env.mjs";
import { evaluateApproach, LiveShare } from "../src/live-share.js";
import { createGame } from "../src/model.js";
import * as store from "../src/store.js";

const HIDING_CENTRE = { lat: 19.24, lng: 72.87 };

test("game 1: pin-only evaluateApproach returns distance in state, never null", () => {
  // With centre + point but threshold=0, state must carry the distance so the
  // caller's pill has something to show. Notify stays null.
  const out = evaluateApproach({
    seekerPoint: { lat: 19.20, lng: 72.87 },
    zoneCentre: HIDING_CENTRE,
    thresholdM: 0,
    prior: null,
  });
  assert.equal(out.notify, null, "pin-only never signals a crossing");
  assert.ok(out.state, "state must not be null — the pill would have nothing to render");
  assert.ok(Number.isFinite(out.state.distance), "distance is populated even in pin-only mode");
  assert.equal(out.state.inside, false, "pin-only mode never reports inside — no threshold to compare against");
});

test("game 2: missing seekerPoint or zoneCentre still returns state=null (unchanged)", () => {
  // The "no signal" guard is separate from the "threshold disabled" guard.
  // A missing point genuinely has nothing to compute; callers already handle
  // out.state being null (they short-circuit before rendering the pill).
  const a = evaluateApproach({ seekerPoint: null, zoneCentre: HIDING_CENTRE, thresholdM: 2000, prior: null });
  assert.equal(a.state, null);
  const b = evaluateApproach({ seekerPoint: { lat: 19.2, lng: 72.87 }, zoneCentre: null, thresholdM: 2000, prior: null });
  assert.equal(b.state, null);
});

test("game 3: LiveShare hider on pin-only survives a seeker ping without throwing", () => {
  const g = createGame({
    name: "pin-only playtest",
    focusZone: { point: HIDING_CENTRE, radius: 500 },
    settings: { approachThresholdM: 0 }, // the "Off (pin only)" radio
  });
  store.setCurrent(g);

  const listeners = new Map();
  const emitted = [];
  const transport = {
    on: (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); },
    off: (ev, fn) => listeners.get(ev)?.delete(fn),
    emit: (ev, payload) => emitted.push({ ev, payload }),
  };

  class MockN { static permission = "granted"; constructor(title, opts) { emitted.push({ ev: "page-notif", payload: { title, opts } }); } }
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });

  const share = new LiveShare({ transport, geolocation: null, Notification: MockN });
  share.startAsHider("pinonly");

  const handler = [...listeners.get("location") || []][0];
  // The very ping that used to throw: any coordinate, any distance.
  assert.doesNotThrow(() => handler({ lat: 19.20, lng: 72.87, at: Date.now() }),
    "seeker ping must not throw in pin-only mode");
  // No notification: pin-only never fires.
  assert.equal(emitted.filter((e) => e.ev === "page-notif").length, 0);
  // And a follow-up ping is still handled cleanly — the crash used to leave
  // the LiveShare in a broken state after the first ping.
  assert.doesNotThrow(() => handler({ lat: 19.22, lng: 72.87, at: Date.now() }));
  assert.doesNotThrow(() => handler({ lat: 19.24, lng: 72.87, at: Date.now() }));

  share.stop();
});

test("game 4: raising threshold above 0 mid-session immediately arms the alert on the next ping", () => {
  // A playtest hider might start pin-only, then decide midway that they
  // want the alert too. approachState is currently a "pin-only shape"
  // ({inside:false, distance, at}); switching threshold from 0 to 2000
  // must not require a reset.
  let prior = null;
  // Two pin-only pings.
  let r = evaluateApproach({ seekerPoint: { lat: 19.20, lng: 72.87 }, zoneCentre: HIDING_CENTRE, thresholdM: 0, prior });
  prior = r.state;
  r = evaluateApproach({ seekerPoint: { lat: 19.22, lng: 72.87 }, zoneCentre: HIDING_CENTRE, thresholdM: 0, prior });
  prior = r.state;
  assert.equal(prior.inside, false, "pin-only always inside=false");
  // Now the user raises the threshold, seeker is well inside 3 km → this
  // must fire the alert (outside→inside crossing from prior.inside=false).
  r = evaluateApproach({ seekerPoint: { lat: 19.235, lng: 72.87 }, zoneCentre: HIDING_CENTRE, thresholdM: 3000, prior });
  assert.ok(r.notify, "raising the threshold arms the alert on the very next crossing");
  assert.equal(r.state.inside, true);
});
