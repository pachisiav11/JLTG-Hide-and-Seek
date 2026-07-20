// Phase 9 (§C4) game test: Geofence prefers the service worker path for its
// system notification, and falls back to page-side new Notification() only
// when no SW controller is available.
//
// The failure mode this closes: Phase 3's `new Notification(...)` from the
// page runs only while the tab is foregrounded on Android. A hider whose
// phone is asleep in a pocket sees nothing. Routing through the SW's
// registration.showNotification makes it a first-class system notification
// that Android delivers to the tray even when the tab is evicted.
import test from "node:test";
import assert from "node:assert/strict";

const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };

const { Geofence } = await import("../src/geofence.js");

// Build a Geofence with mock Notification (permission granted) + optional SW.
function boot({ withController = false, withReady = false } = {}) {
  const posted = [];
  const fired = [];
  class MockN {
    static permission = "granted";
    constructor(title, opts) { fired.push({ title, opts }); }
  }
  const controller = withController ? { postMessage: (m) => posted.push({ via: "controller", m }) } : null;
  const readyReg = withReady ? { active: { postMessage: (m) => posted.push({ via: "ready", m }) } } : null;
  Object.defineProperty(globalThis, "navigator", {
    value: {
      serviceWorker: {
        controller,
        ready: readyReg ? Promise.resolve(readyReg) : null,
      },
    },
    configurable: true, writable: true,
  });
  const gf = new Geofence({ Notification: MockN, geolocation: null });
  return { gf, posted, fired };
}

test("game 1: with a controlling SW, the notification is posted, not shown page-side", async () => {
  const { gf, posted, fired } = boot({ withController: true });
  gf._fireNotification({ title: "Near the edge", body: "80 m from the edge" });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].m.type, "GEOFENCE_NOTIFY");
  assert.equal(posted[0].m.title, "Near the edge");
  assert.equal(posted[0].m.body, "80 m from the edge");
  assert.equal(fired.length, 0, "the page-side Notification path must not fire when the SW took the message");
});

test("game 2: no controller but a ready registration — postMessage via ready.active", async () => {
  const { gf, posted, fired } = boot({ withController: false, withReady: true });
  gf._fireNotification({ title: "Left the zone", body: "50 m past" });
  // ready is async, wait a tick.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].via, "ready");
  assert.equal(fired.length, 0, "the fallback page Notification must not double-fire");
});

test("game 3: no SW at all — falls back to page-side new Notification()", () => {
  const { gf, posted, fired } = boot({ withController: false, withReady: false });
  gf._fireNotification({ title: "Fallback", body: "no SW" });
  assert.equal(posted.length, 0);
  assert.equal(fired.length, 1, "the page path is the safety net");
  assert.equal(fired[0].title, "Fallback");
});

test("game 4: Notification.permission=denied silences ALL paths — no message posted, no page notif", () => {
  const posted = [];
  class DeniedN { static permission = "denied"; constructor() { throw new Error("must not be constructed"); } }
  Object.defineProperty(globalThis, "navigator", {
    value: { serviceWorker: { controller: { postMessage: (m) => posted.push(m) } } },
    configurable: true, writable: true,
  });
  const gf = new Geofence({ Notification: DeniedN, geolocation: null });
  gf._fireNotification({ title: "denied", body: "" });
  assert.equal(posted.length, 0, "denied permission must not silently post to the SW anyway");
});
