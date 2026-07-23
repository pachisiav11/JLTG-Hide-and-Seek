// Phase 44 (Track B 3/3) test: the hider RECEIVES the forwarded ping and computes
// the seeker-close alert LOCALLY.
//
// The headline of the whole native track: a seeker-close alert reaches a LOCKED
// hider. The device half is manual; here we pin the on-device wiring:
//   - seekerCloseNotification folds Phase 33 styles into channel/suppression,
//   - initHiderPushReceiver turns an FCM data message into raw {lat,lng} coords
//     (ignoring foreign messages / bad payloads),
//   - and end-to-end: an FCM ping fed to LiveShare runs the SAME evaluateApproach
//     against the LOCAL focus zone and posts a LOCAL notification once per
//     crossing — honouring "Off" — with the red dot updated too. The server is
//     never consulted for the zone; the phone decides.
import test from "node:test";
import assert from "node:assert/strict";

const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };
Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });

const { seekerCloseNotification, SEEKER_CLOSE_CHANNEL, SEEKER_CLOSE_CHANNEL_SILENT } = await import("../src/native-local-notify.js");
const { initHiderPushReceiver } = await import("../src/native-push.js");
const { LiveShare } = await import("../src/live-share.js");
const store = await import("../src/store.js");
const { createGame } = await import("../src/model.js");

const tick = () => new Promise((r) => setTimeout(r, 0));

// --- pure notification mapping ---------------------------------------------

test("seekerCloseNotification folds Phase 33 styles into channel / suppression", () => {
  const notify = { kind: "seeker-close", title: "Seeker close", body: "~500 m from your zone." };
  assert.equal(seekerCloseNotification(notify, 7, "vibrate-tone").channelId, SEEKER_CLOSE_CHANNEL);
  assert.equal(seekerCloseNotification(notify, 7, "silent").channelId, SEEKER_CLOSE_CHANNEL_SILENT);
  assert.equal(seekerCloseNotification(notify, 7, "off"), null, "Off suppresses");
  assert.equal(seekerCloseNotification(notify, 7).id, 7);
});

// --- the push receiver ------------------------------------------------------

function fakePush() {
  const listeners = {};
  return {
    addListener: async (ev, cb) => { listeners[ev] = cb; return { remove() { delete listeners[ev]; } }; },
    // Simulate an FCM data message arriving (foreground/woken delivery).
    deliver: (data) => listeners.pushNotificationReceived?.({ data }),
  };
}

test("initHiderPushReceiver turns a seeker-location data message into raw coords", async () => {
  const push = fakePush();
  const got = [];
  const unsub = await initHiderPushReceiver({ isNative: () => true, plugin: push, onSeekerCoords: (c) => got.push(c) });
  push.deliver({ type: "seeker-location", lat: "19.076", lng: "72.877", at: "1234" });
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { lat: 19.076, lng: 72.877, at: 1234 });
  // Foreign / malformed messages are ignored.
  push.deliver({ type: "something-else", lat: "1", lng: "2" });
  push.deliver({ type: "seeker-location", lat: "nope", lng: "2" });
  assert.equal(got.length, 1, "only well-formed seeker-location messages pass");
  unsub();
});

test("initHiderPushReceiver is inert off-device", async () => {
  const push = fakePush();
  const got = [];
  await initHiderPushReceiver({ isNative: () => false, plugin: push, onSeekerCoords: (c) => got.push(c) });
  push.deliver({ type: "seeker-location", lat: "1", lng: "2" });
  assert.equal(got.length, 0);
});

// --- end-to-end: LiveShare on the native shell ------------------------------

function mockTransport() {
  const listeners = new Map();
  return {
    on: (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); },
    off: (ev, fn) => listeners.get(ev)?.delete(fn),
    emit: () => {},
  };
}

test("a forwarded FCM ping alerts a LOCKED hider locally, once per crossing, honouring Off", async () => {
  // A hider zone centred in Mumbai; alert when a seeker is within 1 km of centre.
  const g = createGame({ settings: { approachThresholdM: 1000, geofenceAlertStyle: "vibrate-tone" } });
  g.focusZone = { point: { lat: 19.076, lng: 72.877 }, radius: 500 };
  store.setCurrent(g);

  const push = fakePush();
  const posted = [];
  const dots = [];
  const share = new LiveShare({
    transport: mockTransport(),
    isNative: () => true,
    initPushReceiver: (opts) => initHiderPushReceiver({ isNative: () => true, plugin: push, onSeekerCoords: opts.onSeekerCoords }),
    postLocalNotify: (notify, { alertStyle }) => { posted.push({ notify, alertStyle }); },
    onSeekerPoint: (pt) => dots.push(pt),
  });
  share.startAsHider("game-01");
  await tick(); // let the receiver attach

  // Seeker far away → no alert, but the red dot still tracks it.
  push.deliver({ type: "seeker-location", lat: 19.5, lng: 72.877 });
  assert.equal(posted.length, 0, "far seeker: no alert");
  assert.equal(dots.length, 1, "red dot updates on every ping");

  // Seeker crosses INSIDE the 1 km threshold → exactly one local notification.
  push.deliver({ type: "seeker-location", lat: 19.078, lng: 72.877 }); // ~220 m from centre
  assert.equal(posted.length, 1, "crossing inside fires once");
  assert.match(posted[0].notify.title, /Seeker close/i);
  assert.equal(posted[0].alertStyle, "vibrate-tone");

  // Another ping still inside → the once-per-crossing debounce holds.
  push.deliver({ type: "seeker-location", lat: 19.079, lng: 72.877 });
  assert.equal(posted.length, 1, "no re-alert while the seeker stays inside");

  share.stop();
  store.setCurrent(createGame()); // reset shared store for other tests
});

test("with alert style Off, a forwarded crossing posts nothing", async () => {
  const g = createGame({ settings: { approachThresholdM: 1000, geofenceAlertStyle: "off" } });
  g.focusZone = { point: { lat: 19.076, lng: 72.877 }, radius: 500 };
  store.setCurrent(g);

  const push = fakePush();
  const posted = [];
  const share = new LiveShare({
    transport: mockTransport(),
    isNative: () => true,
    initPushReceiver: (opts) => initHiderPushReceiver({ isNative: () => true, plugin: push, onSeekerCoords: opts.onSeekerCoords }),
    postLocalNotify: (notify, opts) => { posted.push({ notify, opts }); },
  });
  share.startAsHider("game-01");
  await tick();
  push.deliver({ type: "seeker-location", lat: 19.078, lng: 72.877 }); // inside
  assert.equal(posted.length, 0, "Off suppresses the local notification");
  share.stop();
  store.setCurrent(createGame());
});
