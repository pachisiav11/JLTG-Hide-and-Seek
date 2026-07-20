// Phase 12 (§C5) game test: the close-approach evaluator + the LiveShare
// class driven by a mock transport, so the alert path can be exercised
// without opening a socket.
//
// The playtest scenario: hider is in their zone; a seeker starts closing
// in from 5 km out. Every 60 s their live-shared ping updates on the hider's
// device. When the distance drops below the (configurable) threshold, the
// hider gets a system notification once — no repeats while the seeker parks
// nearby (per user 2026-07-20).
import test from "node:test";
import assert from "node:assert/strict";

const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };

const { evaluateApproach, generateSessionCode, LiveShare } = await import("../src/live-share.js");
const { createGame } = await import("../src/model.js");
const store = await import("../src/store.js");

const HIDING_CENTRE = { lat: 19.24, lng: 72.87 };

test("game 1: evaluateApproach fires ONCE on the outside→inside crossing", () => {
  // Two ticks: first far, second inside the threshold.
  const t1 = evaluateApproach({ seekerPoint: { lat: 19.20, lng: 72.87 }, zoneCentre: HIDING_CENTRE, thresholdM: 3000, prior: null });
  assert.equal(t1.notify, null, "first tick, far away → no alert");
  assert.equal(t1.state.inside, false);
  const t2 = evaluateApproach({ seekerPoint: { lat: 19.235, lng: 72.87 }, zoneCentre: HIDING_CENTRE, thresholdM: 3000, prior: t1.state });
  assert.ok(t2.notify);
  assert.equal(t2.notify.kind, "seeker-close");
  assert.equal(t2.state.inside, true);
});

test("game 2: repeated pings inside the threshold do NOT re-fire — per user 2026-07-20 'once per crossing'", () => {
  const t1 = evaluateApproach({ seekerPoint: { lat: 19.235, lng: 72.87 }, zoneCentre: HIDING_CENTRE, thresholdM: 3000, prior: null });
  assert.ok(t1.notify, "first-time inside always fires");
  const t2 = evaluateApproach({ seekerPoint: { lat: 19.236, lng: 72.87 }, zoneCentre: HIDING_CENTRE, thresholdM: 3000, prior: t1.state });
  assert.equal(t2.notify, null, "still inside → no re-alert");
  const t3 = evaluateApproach({ seekerPoint: { lat: 19.240, lng: 72.87 }, zoneCentre: HIDING_CENTRE, thresholdM: 3000, prior: t2.state });
  assert.equal(t3.notify, null, "even inside AND at the centre — silent");
});

test("game 3: outside → inside → outside → inside re-fires the second time", () => {
  let state = null;
  for (const [lat, wantsAlert] of [[19.20, false], [19.235, true], [19.20, false], [19.235, true]]) {
    const r = evaluateApproach({ seekerPoint: { lat, lng: 72.87 }, zoneCentre: HIDING_CENTRE, thresholdM: 3000, prior: state });
    assert.equal(!!r.notify, wantsAlert, `at lat ${lat}, expected alert=${wantsAlert}`);
    state = r.state;
  }
});

test("game 4: threshold=0 disables the alert entirely (pin only, per §C5)", () => {
  const r = evaluateApproach({ seekerPoint: HIDING_CENTRE, zoneCentre: HIDING_CENTRE, thresholdM: 0, prior: null });
  assert.equal(r.notify, null);
});

test("game 5: generateSessionCode is 6 chars, unambiguous alphabet", () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const c = generateSessionCode();
    assert.match(c, /^[a-hjkmnpqrstuvwxyz23456789]{6}$/, `code "${c}" contains ambiguous chars`);
    seen.add(c);
  }
  assert.ok(seen.size > 50, "collision rate is far too high for a 6-char random space");
});

test("game 6: LiveShare (hider role) receives a seeker ping via mock transport and fires an alert", async () => {
  // Mock EventEmitter transport: on/off/emit tracked in a Map, and we invoke
  // the location handler directly to simulate a server broadcast.
  const listeners = new Map();
  const emitted = [];
  const transport = {
    on: (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); },
    off: (ev, fn) => listeners.get(ev)?.delete(fn),
    emit: (ev, payload) => emitted.push({ ev, payload }),
  };
  const g = createGame({
    name: "live-share test",
    focusZone: { point: HIDING_CENTRE, radius: 500 },
    settings: { approachThresholdM: 3000 },
  });
  store.setCurrent(g);

  class MockN {
    static permission = "granted";
    constructor(title, opts) { emitted.push({ ev: "page-notif", payload: { title, opts } }); }
  }
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
  const share = new LiveShare({ transport, geolocation: null, Notification: MockN });
  share.startAsHider("abc123");

  // The transport should have received the join.
  assert.ok(emitted.some((e) => e.ev === "join-session" && e.payload.role === "hider"));

  // Simulate the server sending a distant ping — no alert.
  const handler = [...listeners.get("location") || []][0];
  handler({ lat: 19.20, lng: 72.87, at: Date.now() });
  assert.equal(emitted.filter((e) => e.ev === "page-notif").length, 0);

  // Now close in — alert fires (page-notif since we mocked no SW).
  handler({ lat: 19.235, lng: 72.87, at: Date.now() });
  assert.equal(emitted.filter((e) => e.ev === "page-notif").length, 1);
  assert.match(emitted.find((e) => e.ev === "page-notif").payload.title, /Seeker/);

  // Second inside tick — no re-fire.
  handler({ lat: 19.238, lng: 72.87, at: Date.now() });
  assert.equal(emitted.filter((e) => e.ev === "page-notif").length, 1);

  share.stop();
});
