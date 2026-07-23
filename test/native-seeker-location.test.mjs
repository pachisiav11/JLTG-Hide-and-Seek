// Phase 42 (Track B 1/3) test: the seeker's BACKGROUND location stream.
//
// The device half (seeker phone locked, relay still receiving pings) is manual.
// What's pinnable headlessly is the contract that makes the background path a
// drop-in for the foreground one:
//   - NativeSeekerWatch exposes the exact GeoWatch surface (subscribe → unsub,
//     active, lastFix, onActiveChange) and normalizes plugin fixes to {lat,lng},
//   - it ref-counts the foreground service: first subscribe opens the watcher,
//     last unsubscribe tears it down (no leaked service),
//   - and LiveShare rides it UNCHANGED — on the native shell the seeker
//     subscribes to the background watcher, off-device to the foreground one,
//     with the identical Phase 23 throttle either way.
import test from "node:test";
import assert from "node:assert/strict";

const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };
Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });

const { NativeSeekerWatch, seekerWatcherOptions } = await import("../src/native-seeker-location.js");
const { LiveShare } = await import("../src/live-share.js");

const tick = () => new Promise((r) => setTimeout(r, 0));

// A fake BackgroundGeolocation whose addWatcher captures the callback so a test
// can push fixes, and records removeWatcher so we can assert teardown.
function fakeBG() {
  let cb = null;
  const removed = [];
  let nextId = 1;
  return {
    plugins: {
      BG: {
        addWatcher: async (_opts, callback) => { cb = callback; return `w${nextId++}`; },
        removeWatcher: async ({ id }) => { removed.push(id); cb = null; },
      },
    },
    pushFix: (loc) => cb && cb(loc, null),
    pushErr: (err) => cb && cb(null, err),
    removed,
    get watching() { return cb != null; },
  };
}

const fix = (dLat) => ({ latitude: 19.076 + dLat, longitude: 72.877, accuracy: 9, time: Date.now() });

test("seekerWatcherOptions runs a foreground service with the sharing message", () => {
  const o = seekerWatcherOptions();
  assert.equal(o.requestPermissions, true);
  assert.equal(o.stale, false);
  assert.match(o.backgroundTitle, /sharing your location/i, "the ongoing notification is the req-#5 indicator");
  assert.equal(typeof o.distanceFilter, "number");
});

test("available reflects the native shell", () => {
  assert.equal(new NativeSeekerWatch({ isNative: () => true }).available, true);
  assert.equal(new NativeSeekerWatch({ isNative: () => false }).available, false);
});

test("first subscribe opens the watcher; fixes arrive normalized to {lat,lng,at}", async () => {
  const bg = fakeBG();
  const w = new NativeSeekerWatch({ isNative: () => true, plugins: bg.plugins });
  const seen = [];
  w.subscribe((f) => seen.push(f));
  await tick();
  assert.equal(bg.watching, true, "addWatcher opened the foreground service");
  assert.equal(w.active, true);
  bg.pushFix(fix(0));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].lat, 19.076);
  assert.equal(seen[0].lng, 72.877);
  assert.equal(seen[0].accuracy, 9);
  assert.ok(seen[0].at > 0);
  assert.deepEqual(w.lastFix, seen[0]);
});

test("last unsubscribe tears the watcher down — no leaked foreground service", async () => {
  const bg = fakeBG();
  const w = new NativeSeekerWatch({ isNative: () => true, plugins: bg.plugins });
  const un1 = w.subscribe(() => {});
  const un2 = w.subscribe(() => {});
  await tick();
  un1();
  assert.equal(w.active, true, "still one subscriber → watcher stays up");
  un2();
  await tick();
  assert.equal(w.active, false, "last unsubscribe stops the watcher");
  assert.equal(bg.removed.length, 1, "removeWatcher called exactly once");
});

test("onActiveChange fires on the false→true→false transitions", async () => {
  const bg = fakeBG();
  const w = new NativeSeekerWatch({ isNative: () => true, plugins: bg.plugins });
  const seen = [];
  w.onActiveChange((a) => seen.push(a));
  assert.deepEqual(seen, [false], "immediate sync call with the current state");
  const un = w.subscribe(() => {});
  await tick();
  un();
  await tick();
  assert.deepEqual(seen, [false, true, false]);
});

test("an unsubscribe that races ahead of addWatcher does not leak a watcher", async () => {
  const bg = fakeBG();
  const w = new NativeSeekerWatch({ isNative: () => true, plugins: bg.plugins });
  const un = w.subscribe(() => {});
  un(); // synchronous — before the async addWatcher resolves
  await tick();
  assert.equal(w.active, false);
  // The watcher may have opened then immediately closed; either way it must not
  // be left running.
  assert.equal(bg.watching, false, "no dangling foreground service");
});

// --- LiveShare integration -------------------------------------------------

function mockTransport() {
  const listeners = new Map();
  const emitted = [];
  return {
    emitted,
    on: (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); },
    off: (ev, fn) => listeners.get(ev)?.delete(fn),
    emit: (ev, payload) => emitted.push({ ev, payload }),
  };
}

// A minimal foreground GeoWatch stand-in.
function fgWatch() {
  let onFix = null;
  return {
    subscribed: 0,
    subscribe(f) { this.subscribed++; onFix = f; return () => { onFix = null; }; },
    fire(f) { onFix?.(f); },
  };
}

test("LiveShare seeker rides the BACKGROUND watch on the native shell", async () => {
  const bg = fakeBG();
  const bgWatch = new NativeSeekerWatch({ isNative: () => true, plugins: bg.plugins });
  const fg = fgWatch();
  const transport = mockTransport();
  const share = new LiveShare({ transport, watch: fg, bgWatch, isNative: () => true });
  share.startAsSeeker("abcdef");
  await tick();
  assert.equal(fg.subscribed, 0, "foreground watch must NOT be used on-device");
  assert.equal(bg.watching, true, "the background foreground-service watcher is used");
  bg.pushFix(fix(0));
  const emits = transport.emitted.filter((e) => e.ev === "share-location");
  assert.equal(emits.length, 1, "a background fix reaches the relay");
  assert.deepEqual(emits[0].payload, { lat: 19.076, lng: 72.877 });
  share.stop();
  await tick();
  assert.equal(bgWatch.active, false, "stop() tears down the background watcher");
});

test("LiveShare seeker uses the FOREGROUND watch off-device (bgWatch present but not native)", async () => {
  const bg = fakeBG();
  const bgWatch = new NativeSeekerWatch({ isNative: () => false, plugins: bg.plugins });
  const fg = fgWatch();
  const transport = mockTransport();
  const share = new LiveShare({ transport, watch: fg, bgWatch, isNative: () => false });
  share.startAsSeeker("abcdef");
  await tick();
  assert.equal(fg.subscribed, 1, "off-device the foreground watch is used, unchanged");
  assert.equal(bg.watching, false, "no background service off-device");
  fg.fire({ lat: 19.076, lng: 72.877 });
  assert.equal(transport.emitted.filter((e) => e.ev === "share-location").length, 1);
  share.stop();
});
