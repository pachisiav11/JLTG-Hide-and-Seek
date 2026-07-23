// Phase 41 (Track A) test: the hider's BACKGROUND geofence bridge.
//
// The device half (locked-pocket, forced Doze) is manual — Phase 40 already
// proved the foreground service survives Doze on the target OEM. What IS pinnable
// headlessly is the bridge contract that carries the web geofence's meaning to a
// locked phone:
//   - it runs only when a real hider zone + threshold exist,
//   - it fires exactly ONE local notification per band transition (reusing the
//     Phase 32 machine), and NONE while parked in a band,
//   - it honours the Phase 33 "Off" (suppress) and "silent" (quiet channel)
//     styles,
//   - a zone re-place resets the baseline (no spurious alert against old geometry),
//   - stopping cancels any posted alert (the native mirror of the Phase 31.5 fix).
// If this drifts, a locked hider gets double-alerts, stale alerts, or silence in
// the one session background alerts exist for.
import test from "node:test";
import assert from "node:assert/strict";

const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };

const {
  wantsNativeGeofence,
  zoneKey,
  backgroundWatcherOptions,
  localNotificationForNotify,
  NativeGeofence,
  CHANNEL_ALERT,
  CHANNEL_SILENT,
} = await import("../src/native-geofence.js");

// A hiding zone in Mumbai, 500 m radius, warn within 100 m of the edge.
const ZONE = { point: { lat: 19.24, lng: 72.87 }, radius: 500 };
const THRESHOLD = 100;
const gameWith = (over = {}) => ({
  focusZone: over.focusZone !== undefined ? over.focusZone : ZONE,
  settings: {
    geofenceMetres: over.geofenceMetres !== undefined ? over.geofenceMetres : THRESHOLD,
    geofenceAlertStyle: over.geofenceAlertStyle || "vibrate-tone",
  },
});
const at = (dLat, dLng = 0) => ({ latitude: ZONE.point.lat + dLat, longitude: ZONE.point.lng + dLng, time: Date.now() });

// --- Pure helpers ----------------------------------------------------------

test("wantsNativeGeofence gates on a placed zone AND a non-zero threshold", () => {
  assert.equal(wantsNativeGeofence(gameWith()), true);
  assert.equal(wantsNativeGeofence(gameWith({ geofenceMetres: 0 })), false, "threshold 0 = off");
  assert.equal(wantsNativeGeofence(gameWith({ focusZone: { point: ZONE.point, radius: null } })), false, "marker-only = off");
  assert.equal(wantsNativeGeofence(gameWith({ focusZone: { point: null, radius: null } })), false);
  assert.equal(wantsNativeGeofence(null), false);
});

test("zoneKey changes when the point, radius, or threshold changes; null when off", () => {
  const k = zoneKey(gameWith());
  assert.equal(zoneKey(gameWith()), k, "stable for identical geometry");
  assert.notEqual(zoneKey(gameWith({ geofenceMetres: 150 })), k, "threshold edit changes the key");
  assert.notEqual(zoneKey(gameWith({ focusZone: { point: ZONE.point, radius: 600 } })), k, "radius edit changes the key");
  assert.equal(zoneKey(gameWith({ geofenceMetres: 0 })), null);
});

test("backgroundWatcherOptions asks for every fix and walks the always-on grant", () => {
  const o = backgroundWatcherOptions();
  assert.equal(o.distanceFilter, 0, "report every fix so slow drift still triggers");
  assert.equal(o.requestPermissions, true);
  assert.equal(o.stale, false);
  assert.equal(typeof o.backgroundMessage, "string");
});

test("localNotificationForNotify folds Phase 33 styles into channel selection / suppression", () => {
  const notify = { kind: "approaching", title: "Near the edge", body: "100 m — turn back." };
  const normal = localNotificationForNotify(notify, 42, "vibrate-tone");
  assert.equal(normal.id, 42);
  assert.equal(normal.title, "Near the edge");
  assert.equal(normal.channelId, CHANNEL_ALERT);
  assert.equal(localNotificationForNotify(notify, 42, "silent").channelId, CHANNEL_SILENT, "silent → quiet channel");
  assert.equal(localNotificationForNotify(notify, 42, "off"), null, "off → suppress entirely");
  assert.equal(localNotificationForNotify(null, 42, "vibrate-tone"), null, "no notify → nothing");
});

// --- The bridge, driven through a fake plugin + injected store -------------

// A fake store that returns a fixed game and lets a test flip it + emit.
function fakeStore(game) {
  let g = game;
  const subs = new Set();
  return {
    getCurrent: () => g,
    subscribe: (fn) => { subs.add(fn); fn(g); return () => subs.delete(fn); },
    set: (next) => { g = next; for (const fn of subs) fn(g); },
  };
}

// A fake BackgroundGeolocation that captures the watcher callback so a test can
// push fixes, and a fake LocalNotifications that records schedule/cancel calls.
function fakePlugins() {
  let cb = null;
  const scheduled = [];
  const cancelled = [];
  return {
    plugins: {
      BG: {
        addWatcher: async (_opts, callback) => { cb = callback; return "watcher-1"; },
        removeWatcher: async () => { cb = null; },
      },
      LN: {
        requestPermissions: async () => ({ display: "granted" }),
        schedule: async ({ notifications }) => { scheduled.push(...notifications); },
        cancel: async ({ notifications }) => { cancelled.push(...notifications); },
      },
    },
    pushFix: (loc) => cb && cb(loc, null),
    pushError: (err) => cb && cb(null, err),
    scheduled,
    cancelled,
    get started() { return cb != null; },
  };
}

const makeBridge = (store, fk) => new NativeGeofence({ store, isNative: () => true, plugins: fk.plugins });

test("init off-device is completely inert — no watcher, no plugin touch", async () => {
  const fk = fakePlugins();
  const gf = new NativeGeofence({ store: fakeStore(gameWith()), isNative: () => false, plugins: fk.plugins });
  gf.init();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gf.watching, false);
  assert.equal(fk.started, false, "no addWatcher off-device");
});

test("fires exactly one notification per band transition, silent while parked", async () => {
  const store = fakeStore(gameWith());
  const fk = fakePlugins();
  const gf = makeBridge(store, fk);
  gf.init();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(fk.started, true, "a placed zone starts the watcher");

  fk.pushFix(at(0.001));    // safe baseline — silent (first fix establishes band)
  fk.pushFix(at(0.0036));   // → near (approaching)
  fk.pushFix(at(0.00405));  // parked in near — silent
  fk.pushFix(at(0.005));    // → out (crossed-out)
  fk.pushFix(at(0.0052));   // parked out — silent
  fk.pushFix(at(0.0018));   // → back inside (back-in)
  await new Promise((r) => setTimeout(r, 0));

  const titles = fk.scheduled.map((n) => n.title);
  assert.equal(titles.length, 3, `one alert per transition, got: ${JSON.stringify(titles)}`);
  assert.match(titles[0], /edge/i);        // approaching
  assert.match(titles[1], /left/i);         // crossed-out
  assert.match(titles[2], /[Bb]ack inside/); // back-in
  // Ids are distinct ints in the geofence band, and each carries a live schedule.
  const ids = fk.scheduled.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(fk.scheduled.every((n) => n.schedule?.at instanceof Date));
});

test("honours Phase 33 'Off' — a crossing posts nothing", async () => {
  const store = fakeStore(gameWith({ geofenceAlertStyle: "off" }));
  const fk = fakePlugins();
  const gf = makeBridge(store, fk);
  gf.init();
  await new Promise((r) => setTimeout(r, 0));
  fk.pushFix(at(0.001));   // baseline
  fk.pushFix(at(0.0036));  // would be "approaching"
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(fk.scheduled.length, 0, "Off suppresses the notification entirely");
});

test("a fix error is swallowed (no throw, no notification)", async () => {
  const store = fakeStore(gameWith());
  const fk = fakePlugins();
  const gf = makeBridge(store, fk);
  gf.init();
  await new Promise((r) => setTimeout(r, 0));
  fk.pushError({ code: "TIMEOUT", message: "no fix" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(fk.scheduled.length, 0);
});

test("re-placing the zone resets the baseline — no spurious alert against old geometry", async () => {
  const store = fakeStore(gameWith());
  const fk = fakePlugins();
  const gf = makeBridge(store, fk);
  gf.init();
  await new Promise((r) => setTimeout(r, 0));
  fk.pushFix(at(0.0036)); // establishes "near" as the FIRST-fix baseline (silent)
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(fk.scheduled.length, 0, "first fix is always a silent baseline");

  // Move the zone far away (re-placed). The key changes → baseline resets.
  const moved = gameWith();
  moved.focusZone = { point: { lat: 28.61, lng: 77.20 }, radius: 500 };
  store.set(moved);
  fk.pushFix(at(0.0036)); // now far OUTSIDE the moved zone, but it's the new baseline
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(fk.scheduled.length, 0, "the first fix after a re-place re-establishes silently");
});

test("removing the zone stops the watcher and cancels any posted alert", async () => {
  const store = fakeStore(gameWith());
  const fk = fakePlugins();
  const gf = makeBridge(store, fk);
  gf.init();
  await new Promise((r) => setTimeout(r, 0));
  fk.pushFix(at(0.001));   // baseline
  fk.pushFix(at(0.0036));  // approaching → one posted alert
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(fk.scheduled.length, 1);

  // Hider removes the zone.
  store.set(gameWith({ focusZone: { point: null, radius: null } }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gf.watching, false, "no zone → watcher stopped");
  assert.equal(fk.cancelled.length, 1, "the posted alert is cancelled off the tray");
  assert.equal(fk.cancelled[0].id, fk.scheduled[0].id);
});
