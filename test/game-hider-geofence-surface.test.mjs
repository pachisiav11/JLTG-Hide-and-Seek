// Phase 34 (req #8): the geofence edge-alert threshold is settable from the
// Hider-zone flow, not only from deep Settings. Setting it there must write
// settings.geofenceMetres and — because the Geofence watcher subscribes to the
// store — start the GPS watch, exactly as the Settings control does.
import test from "node:test";
import assert from "node:assert/strict";
import { createGame } from "../src/model.js";
import { squareArea } from "./helpers/turf-env.mjs";

Object.defineProperty(globalThis, "navigator", {
  value: {
    serviceWorker: { controller: { postMessage: () => {} } },
    geolocation: { watchPosition: () => 11, clearWatch: () => {} },
  },
  configurable: true, writable: true,
});
const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };

const { Focus } = await import("../src/focus.js");
const { Geofence } = await import("../src/geofence.js");
const store = await import("../src/store.js");

const AREA = squareArea([72.8777, 19.176], 0.4);
const ZONE = { point: { lat: 19.176, lng: 72.8777 }, radius: 500 };

function boot() {
  const g = createGame({ name: "Hider", gameArea: AREA, focusZone: ZONE });
  g.settings.geofenceMetres = 0; // start with the edge alert off
  g.settings.role = "hider"; // these tests exercise the Hider's own edge-alert flow
  store.setCurrent(g);
  const gf = new Geofence({ Notification: { permission: "granted" }, geolocation: navigator.geolocation });
  gf.init(); // subscribes; no watch yet (threshold 0)
  const focus = new Focus(null); // map unused by setGeofenceThreshold
  return { gf, focus };
}

test("surface 1: setting the threshold from the Hider flow writes it and starts the watch", () => {
  const { gf, focus } = boot();
  assert.equal(gf.watching, false, "no watch while the edge alert is Off");

  focus.setGeofenceThreshold(100);

  assert.equal(store.getCurrent().settings.geofenceMetres, 100, "written to settings.geofenceMetres");
  assert.equal(gf.watching, true, "the Geofence watcher started on the store change");
  gf.destroy();
});

test("surface 2: setting it back to 0 stops the watch", () => {
  const { gf, focus } = boot();
  focus.setGeofenceThreshold(100);
  assert.equal(gf.watching, true);

  focus.setGeofenceThreshold(0);
  assert.equal(store.getCurrent().settings.geofenceMetres, 0);
  assert.equal(gf.watching, false, "Off stops the watch");
  gf.destroy();
});

test("surface 3: junk/negative is treated as Off, never a bogus threshold", () => {
  const { gf, focus } = boot();
  focus.setGeofenceThreshold("abc");
  assert.equal(store.getCurrent().settings.geofenceMetres, 0);
  focus.setGeofenceThreshold(-50);
  assert.equal(store.getCurrent().settings.geofenceMetres, 0);
  assert.equal(gf.watching, false);
  gf.destroy();
});

test("surface 4: role defaults to seeker, which keeps the watch off even with a threshold set", () => {
  const { gf, focus } = boot();
  store.update((g) => (g.settings = { ...g.settings, role: "seeker" }));
  focus.setGeofenceThreshold(100);
  assert.equal(store.getCurrent().settings.geofenceMetres, 100);
  assert.equal(gf.watching, false, "a seeker's Hider-zone is just a guess — no self-alerting");
  gf.destroy();
});

test("surface 5: switching role to hider arms an already-set threshold; back to seeker disarms it", () => {
  const { gf, focus } = boot();
  store.update((g) => (g.settings = { ...g.settings, role: "seeker" }));
  focus.setGeofenceThreshold(100);
  assert.equal(gf.watching, false);

  focus.setRole("hider");
  assert.equal(store.getCurrent().settings.role, "hider");
  assert.equal(gf.watching, true, "switching to Hider starts the watch immediately");

  focus.setRole("seeker");
  assert.equal(gf.watching, false, "switching back to Seeker stops it again");
  gf.destroy();
});
