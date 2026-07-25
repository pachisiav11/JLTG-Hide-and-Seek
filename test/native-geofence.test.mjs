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
    // These tests exercise the Hider's own background alert path.
    role: over.role !== undefined ? over.role : "hider",
  },
});
const at = (dLat, dLng = 0) => ({ latitude: ZONE.point.lat + dLat, longitude: ZONE.point.lng + dLng, time: Date.now() });

// --- Pure helpers ----------------------------------------------------------

test("wantsNativeGeofence gates on a placed zone AND a non-zero threshold AND the Hider role", () => {
  assert.equal(wantsNativeGeofence(gameWith()), true);
  assert.equal(wantsNativeGeofence(gameWith({ geofenceMetres: 0 })), false, "threshold 0 = off");
  assert.equal(wantsNativeGeofence(gameWith({ focusZone: { point: ZONE.point, radius: null } })), false, "marker-only = off");
  assert.equal(wantsNativeGeofence(gameWith({ focusZone: { point: null, radius: null } })), false);
  assert.equal(wantsNativeGeofence(gameWith({ role: "seeker" })), false, "a seeker's Hider-zone is just a guess — no self-alerting");
  const noRoleKey = gameWith();
  delete noRoleKey.settings.role;
  assert.equal(wantsNativeGeofence(noRoleKey), false, "a game predating this setting has no role key — defaults to seeker, same as off");
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
  let watcherCalls = 0;
  return {
    plugins: {
      BG: {
        addWatcher: async (_opts, callback) => { watcherCalls++; cb = callback; return `watcher-${watcherCalls}`; },
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
    get watcherCalls() { return watcherCalls; },
  };
}

const makeBridge = (store, fk) => new NativeGeofence({ store, isNative: () => true, plugins: fk.plugins, ensureChannels: async () => true });

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
  // Ids are distinct ints in the geofence band.
  const ids = fk.scheduled.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
  // No `schedule` — posted immediately via notify(), not raced through
  // AlarmManager against a near-future `at` that Android can silently drop.
  assert.ok(fk.scheduled.every((n) => n.schedule === undefined));
});

test("channels not confirmed ready: _fire() strips channelId instead of posting to a nonexistent one", async () => {
  const store = fakeStore(gameWith());
  const fk = fakePlugins();
  const gf = new NativeGeofence({ store, isNative: () => true, plugins: fk.plugins, ensureChannels: async () => false });
  gf.init();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gf._channelsReady, false, "start() recorded the failed channel check");

  fk.pushFix(at(0.001));   // baseline
  fk.pushFix(at(0.0036));  // → near: tries to fire
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(fk.scheduled.length, 1);
  assert.equal(fk.scheduled[0].channelId, undefined, "falls back to the plugin's own default channel");
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

test("role seeker: the watcher never starts, even with a placed zone + threshold", async () => {
  const store = fakeStore(gameWith({ role: "seeker" }));
  const fk = fakePlugins();
  const gf = makeBridge(store, fk);
  gf.init();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gf.watching, false);
  assert.equal(fk.started, false, "a seeker's Hider-zone is just a guess — no background watcher");
});

test("switching role from hider to seeker mid-game stops the watcher and cancels the posted alert", async () => {
  const store = fakeStore(gameWith());
  const fk = fakePlugins();
  const gf = makeBridge(store, fk);
  gf.init();
  await new Promise((r) => setTimeout(r, 0));
  fk.pushFix(at(0.001));   // baseline
  fk.pushFix(at(0.0036));  // approaching → one posted alert
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(fk.scheduled.length, 1);

  store.set(gameWith({ role: "seeker" }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gf.watching, false, "role switch disarms it exactly like removing the zone");
  assert.equal(fk.cancelled.length, 1, "the posted alert is cancelled off the tray");
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

test("a fatal watcher error clears state so the feature can retry, instead of wedging forever", async () => {
  const store = fakeStore(gameWith());
  const fk = fakePlugins();
  const gf = makeBridge(store, fk);
  gf.init();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(fk.started, true, "a placed zone starts the watcher");
  assert.equal(fk.watcherCalls, 1, "first watcher call");

  fk.pushError({ message: "Location services disabled." });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gf.watching, false, "error clears watcherId, so watching is false");
  assert.equal(gf._activeKey, null, "activeKey is also cleared");

  // Trigger a retry by re-emitting the store. This should start a fresh watcher.
  store.set(gameWith());
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(fk.watcherCalls, 2, "a fresh addWatcher call happened after the retry");
  assert.equal(gf.watching, true, "the new watcher is now active");
});

test("onError is called on a fatal watcher error", async () => {
  const errors = [];
  const store = fakeStore(gameWith());
  const fk = fakePlugins();
  const gf = new NativeGeofence({
    store,
    isNative: () => true,
    plugins: fk.plugins,
    onError: (msg) => errors.push(msg),
    ensureChannels: async () => true,
  });
  gf.init();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(fk.started, true);

  fk.pushError({ message: "Permission denied." });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(errors.length, 1, "onError was called once");
  assert.match(errors[0], /Permission denied/, "error message is passed through");
});

test("a rejected LN.schedule() calls onError instead of throwing/silently vanishing", async () => {
  const errors = [];
  const store = fakeStore(gameWith());
  const fk = fakePlugins();
  // Override LN.schedule to reject
  fk.plugins.LN.schedule = async () => {
    throw new Error("Notifications not enabled on this device");
  };
  const gf = new NativeGeofence({
    store,
    isNative: () => true,
    plugins: fk.plugins,
    onError: (msg) => errors.push(msg),
    ensureChannels: async () => true,
  });
  gf.init();
  await new Promise((r) => setTimeout(r, 0));
  fk.pushFix(at(0.001));   // baseline
  fk.pushFix(at(0.0036));  // approaching → tries to fire a notification
  // Give the async schedule().catch time to run
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(errors.length, 1, "onError was called once");
  assert.match(errors[0], /notification|Notifications/, "error mentions the notification failure");
});

test("postTestNotification: off-device returns not-running error", async () => {
  const { postTestNotification } = await import("../src/native-geofence.js");
  const result = await postTestNotification({ isNative: () => false });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Android app/);
});

test("postTestNotification: on-device success", async () => {
  const { postTestNotification } = await import("../src/native-geofence.js");
  const scheduled = [];
  const fk = {
    LN: {
      schedule: async ({ notifications }) => { scheduled.push(...notifications); },
    },
  };
  const result = await postTestNotification({ plugins: fk, isNative: () => true });
  assert.equal(result.ok, true);
  assert.equal(scheduled.length, 1);
  assert.match(scheduled[0].title, /[Tt]est/);
});

test("postTestNotification: LN.schedule rejection returns error", async () => {
  const { postTestNotification } = await import("../src/native-geofence.js");
  const fk = {
    LN: {
      schedule: async () => {
        throw new Error("Permission denied by the OS");
      },
    },
  };
  const result = await postTestNotification({ plugins: fk, isNative: () => true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Permission denied/);
});

test("postTestNotification: denied notification permission is caught before schedule (no silent no-op)", async () => {
  const { postTestNotification } = await import("../src/native-geofence.js");
  let scheduleCalled = false;
  const fk = {
    LN: {
      checkPermissions: async () => ({ display: "denied" }),
      // Android won't reprompt once already denied — requestPermissions() just
      // echoes the denial back with no dialog.
      requestPermissions: async () => ({ display: "denied" }),
      schedule: async () => { scheduleCalled = true; },
    },
  };
  const result = await postTestNotification({ plugins: fk, isNative: () => true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Settings/);
  assert.equal(scheduleCalled, false, "must not call schedule() against a known-denied grant");
});

test("postTestNotification: not-yet-decided permission is requested, then proceeds once granted", async () => {
  const { postTestNotification } = await import("../src/native-geofence.js");
  const scheduled = [];
  let requested = false;
  const fk = {
    LN: {
      checkPermissions: async () => ({ display: "prompt" }),
      requestPermissions: async () => { requested = true; return { display: "granted" }; },
      schedule: async ({ notifications }) => { scheduled.push(...notifications); },
    },
  };
  const result = await postTestNotification({ plugins: fk, isNative: () => true });
  assert.equal(requested, true);
  assert.equal(result.ok, true);
  assert.equal(scheduled.length, 1);
});

test("postTestNotification: channels not ready reports an honest failure instead of a false success", async () => {
  const { postTestNotification } = await import("../src/native-geofence.js");
  let scheduleCalled = false;
  const fk = {
    LN: {
      checkPermissions: async () => ({ display: "granted" }),
      schedule: async () => { scheduleCalled = true; },
    },
  };
  const result = await postTestNotification({ plugins: fk, isNative: () => true, ensureChannels: async () => false });
  assert.equal(result.ok, false);
  assert.match(result.reason, /channels/i);
  assert.equal(scheduleCalled, false, "must not claim success against channels that don't exist");
});

test("postTestNotification: channels ready proceeds to schedule normally", async () => {
  const { postTestNotification } = await import("../src/native-geofence.js");
  const scheduled = [];
  const fk = {
    LN: {
      checkPermissions: async () => ({ display: "granted" }),
      schedule: async ({ notifications }) => { scheduled.push(...notifications); },
    },
  };
  const result = await postTestNotification({ plugins: fk, isNative: () => true, ensureChannels: async () => true });
  assert.equal(result.ok, true);
  assert.equal(scheduled.length, 1);
});
