// Phase 31.5 (bug): removing the hider zone must dismiss the outstanding
// geofence notification, not leave it sitting in the tray.
//
// The alert is shown by the service worker with a fixed tag and lives in the
// tray until closed. When the zone is cleared the GPS watch stops (no NEW
// alerts) but nothing used to close the last one — so it lingered on the lock
// screen as if the app were still watching a zone that no longer exists. The
// fix: a clearNotification(tag) helper that asks the SW to close tagged
// notifications, called whenever the watch stops.
import test from "node:test";
import assert from "node:assert/strict";
import { createGame } from "../src/model.js";
import { squareArea } from "./helpers/turf-env.mjs";

// A fake SW controller that records every postMessage.
const posted = [];
const swController = { postMessage: (m) => posted.push(m) };
Object.defineProperty(globalThis, "navigator", {
  value: {
    serviceWorker: { controller: swController },
    geolocation: {
      watchPosition: () => 7,   // return a watch id so the geofence is "active"
      clearWatch: () => {},
    },
  },
  configurable: true, writable: true,
});

const { clearNotification } = await import("../src/sw-notify.js");
const { Geofence } = await import("../src/geofence.js");
const store = await import("../src/store.js");

const AREA = squareArea([72.8777, 19.176], 0.4);
const ZONE = { point: { lat: 19.176, lng: 72.8777 }, radius: 500 };

test("clear 1: clearNotification posts a CLEAR_NOTIFY for the tag", () => {
  posted.length = 0;
  const dispatched = clearNotification("jltg-geofence");
  assert.equal(dispatched, true);
  assert.deepEqual(posted, [{ type: "CLEAR_NOTIFY", tag: "jltg-geofence" }]);
});

test("clear 2: no tag → no-op (returns false, posts nothing)", () => {
  posted.length = 0;
  assert.equal(clearNotification(""), false);
  assert.equal(clearNotification(null), false);
  assert.equal(posted.length, 0);
});

test("clear 3: no service worker → returns false without throwing", () => {
  const saved = navigator.serviceWorker;
  navigator.serviceWorker = undefined;
  try {
    assert.equal(clearNotification("jltg-geofence"), false);
  } finally {
    navigator.serviceWorker = saved;
  }
});

test("geofence 1: removing the hider zone dismisses the geofence notification", () => {
  // Active geofence: a zone with a radius + a threshold set.
  const g = createGame({ name: "Zone", gameArea: AREA, focusZone: ZONE });
  g.settings.geofenceMetres = 80;
  store.setCurrent(g);

  const gf = new Geofence({ Notification: { permission: "granted" }, geolocation: navigator.geolocation });
  gf.init(); // subscribes + reconciles → watch starts, no clear yet

  posted.length = 0;
  assert.equal(gf.watchId, 7, "the watch is running while the zone exists");

  // Remove the hider zone — exactly what focus.clear() does.
  store.update((game) => { game.focusZone = { point: null, radius: null }; });

  assert.equal(gf.watchId, null, "the watch stops when the zone is gone");
  assert.ok(
    posted.some((m) => m.type === "CLEAR_NOTIFY" && m.tag === "jltg-geofence"),
    "a CLEAR_NOTIFY was sent so the stale tray notification is dismissed",
  );
  gf.destroy();
});

test("geofence 2: a normal active reconcile does NOT clear (only stopping does)", () => {
  const g = createGame({ name: "Zone", gameArea: AREA, focusZone: ZONE });
  g.settings.geofenceMetres = 80;
  store.setCurrent(g);

  const gf = new Geofence({ Notification: { permission: "granted" }, geolocation: navigator.geolocation });
  gf.init();
  posted.length = 0;

  // A store change that keeps the zone (e.g. an unrelated settings tweak) must
  // not spuriously dismiss a live alert.
  store.update((game) => { game.settings = { ...game.settings, units: "imperial" }; });

  assert.ok(!posted.some((m) => m.type === "CLEAR_NOTIFY"), "no clear while the zone is still active");
  gf.destroy();
});
