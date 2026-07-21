// Phase 33 (req #10): a real "Off" for the proximity alerts.
//
// Today's "silent" still posts a tray notification (just no buzz/tone). "Off"
// is the genuinely-quiet setting: no system notification AND no buzz/tone, for
// BOTH the geofence-edge and the live-share seeker-close alerts. The on-screen
// pill still updates — that's written before _fireNotification — so a hider who
// glances at the app still sees their distance; they simply aren't alerted.
import test from "node:test";
import assert from "node:assert/strict";
import { createGame } from "../src/model.js";

const posted = [];   // GEOFENCE_NOTIFY messages the SW would show
const vibrated = []; // navigator.vibrate calls
Object.defineProperty(globalThis, "navigator", {
  value: {
    serviceWorker: { controller: { postMessage: (m) => posted.push(m) } },
    vibrate: (pattern) => { vibrated.push(pattern); return true; },
  },
  configurable: true, writable: true,
});
const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents); // no AudioContext → tone no-ops
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };

const { Geofence } = await import("../src/geofence.js");
const { LiveShare } = await import("../src/live-share.js");
const store = await import("../src/store.js");

const grantedN = { permission: "granted" };
function setStyle(style) {
  const g = createGame({ name: "N" });
  g.settings.geofenceAlertStyle = style;
  store.setCurrent(g);
}
function reset() { posted.length = 0; vibrated.length = 0; }

test("geofence off: no notification and no buzz/tone", () => {
  setStyle("off"); reset();
  const gf = new Geofence({ Notification: grantedN, geolocation: navigator });
  gf._fireNotification({ title: "Near the edge", body: "turn back" });
  assert.equal(posted.length, 0, "Off posts no system notification");
  assert.equal(vibrated.length, 0, "Off does not vibrate");
});

test("geofence silent: posts a notification but does NOT buzz", () => {
  setStyle("silent"); reset();
  const gf = new Geofence({ Notification: grantedN, geolocation: navigator });
  gf._fireNotification({ title: "Near the edge", body: "turn back" });
  assert.equal(posted.length, 1, "silent still posts the tray notification");
  assert.equal(posted[0].type, "GEOFENCE_NOTIFY");
  assert.equal(vibrated.length, 0, "silent = notification only, no buzz");
});

test("geofence vibrate-tone: posts AND buzzes (unchanged behaviour)", () => {
  setStyle("vibrate-tone"); reset();
  const gf = new Geofence({ Notification: grantedN, geolocation: navigator });
  gf._fireNotification({ title: "Near the edge", body: "turn back" });
  assert.equal(posted.length, 1, "still posts");
  assert.equal(vibrated.length, 1, "still vibrates");
});

test("seeker-close off: the shared setting silences the live-share alert too", () => {
  setStyle("off"); reset();
  const ls = new LiveShare({ transport: null, Notification: grantedN });
  ls._fireNotification({ title: "Seeker close", body: "~1 km away" });
  assert.equal(posted.length, 0, "Off suppresses the seeker-close notification");
});

test("seeker-close non-off: the alert still posts", () => {
  setStyle("vibrate-tone"); reset();
  const ls = new LiveShare({ transport: null, Notification: grantedN });
  ls._fireNotification({ title: "Seeker close", body: "~1 km away" });
  assert.equal(posted.length, 1, "a non-off style still delivers the seeker-close alert");
  assert.equal(posted[0].type, "GEOFENCE_NOTIFY");
});
