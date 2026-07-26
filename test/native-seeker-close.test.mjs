// Phase 44 (Track B 3/3) test, revised by Phase 51: the hider RECEIVES what the
// relay forwards over FCM.
//
// Phase 51 split what used to be one decision into two messages: raw
// "seeker-location" coords (still forwarded on every ping, still just update
// the dot/pill) and a SEPARATE "seeker-close-alert" message the SERVER only
// sends once it has decided a crossing happened (relay-forward.js
// checkServerApproach, against the zone the client registered — see
// game-live-share-server-approach.test.mjs for that half). The device no
// longer re-decides the crossing from a "seeker-location" message — see
// LiveShare._onSeekerPingSilent — because the server already has everything
// it needs to decide correctly, including for an app process the OS has
// fully killed, which a client-side recompute can never run for anyway.
//
// This file pins the on-device wiring:
//   - seekerCloseNotification folds Phase 33 styles into channel/suppression,
//   - initHiderPushReceiver routes "seeker-location" to onSeekerCoords and
//     "seeker-close-alert" to onCloseAlert (ignoring foreign/malformed ones),
//   - and end-to-end: a "seeker-location" ping updates the dot/pill only; a
//     "seeker-close-alert" posts the local notification directly from the
//     server-supplied title/body, still honouring the LOCAL "Off" setting as
//     a second line of defence (_fireNotification re-reads it fresh).
import test from "node:test";
import assert from "node:assert/strict";

const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };
Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });

const { seekerCloseNotification, postSeekerCloseNotification, SEEKER_CLOSE_CHANNEL, SEEKER_CLOSE_CHANNEL_SILENT } = await import("../src/native-local-notify.js");
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

test("postSeekerCloseNotification schedules against the selected channel when channels are ready", async () => {
  const scheduled = [];
  const LN = { schedule: async ({ notifications }) => scheduled.push(...notifications) };
  const id = await postSeekerCloseNotification(
    { title: "Seeker close", body: "~500 m" },
    { isNative: () => true, plugins: { LN }, ensureChannels: async () => true },
  );
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].channelId, SEEKER_CLOSE_CHANNEL);
  assert.equal(scheduled[0].id, id);
});

test("postSeekerCloseNotification falls back to no channelId when channels aren't confirmed ready", async () => {
  const scheduled = [];
  const LN = { schedule: async ({ notifications }) => scheduled.push(...notifications) };
  await postSeekerCloseNotification(
    { title: "Seeker close", body: "~500 m" },
    { isNative: () => true, plugins: { LN }, ensureChannels: async () => false },
  );
  assert.equal(scheduled.length, 1, "still posts — just without a channel id Android never created");
  assert.equal(scheduled[0].channelId, undefined);
});

// --- the push receiver ------------------------------------------------------

function fakePush() {
  const listeners = {};
  return {
    addListener: async (ev, cb) => { listeners[ev] = cb; return { remove() { delete listeners[ev]; } }; },
    // Simulate a data-only FCM message (Phase 44 shape — data, no notification block).
    deliverData: (data) => listeners.pushNotificationReceived?.({ data }),
    // Simulate a genuine FCM *notification* message — title/body live at the
    // TOP level of the event (where FCM's `notification` block surfaces via
    // Capacitor's plugin), `data` alongside for routing/metadata only.
    deliverNotification: (title, body, data) => listeners.pushNotificationReceived?.({ title, body, data }),
  };
}

test("initHiderPushReceiver turns a seeker-location data message into raw coords", async () => {
  const push = fakePush();
  const got = [];
  const unsub = await initHiderPushReceiver({ isNative: () => true, plugin: push, onSeekerCoords: (c) => got.push(c) });
  push.deliverData({ type: "seeker-location", lat: "19.076", lng: "72.877", at: "1234" });
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { lat: 19.076, lng: 72.877, at: 1234 });
  // Foreign / malformed messages are ignored.
  push.deliverData({ type: "something-else", lat: "1", lng: "2" });
  push.deliverData({ type: "seeker-location", lat: "nope", lng: "2" });
  assert.equal(got.length, 1, "only well-formed seeker-location messages pass");
  unsub();
});

test("initHiderPushReceiver routes a seeker-close-alert message to onCloseAlert", async () => {
  const push = fakePush();
  const coords = [];
  const alerts = [];
  const unsub = await initHiderPushReceiver({
    isNative: () => true, plugin: push,
    onSeekerCoords: (c) => coords.push(c),
    onCloseAlert: (a) => alerts.push(a),
  });
  push.deliverNotification("Seeker close", "~500 m from your hiding zone centre.", { type: "seeker-close-alert", code: "1234" });
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0], { title: "Seeker close", body: "~500 m from your hiding zone centre." });
  assert.equal(coords.length, 0, "a close-alert message must not also be read as a coords ping");
  unsub();
});

test("a seeker-close-alert with no title is dropped, not passed through as an empty alert", async () => {
  const push = fakePush();
  const alerts = [];
  await initHiderPushReceiver({ isNative: () => true, plugin: push, onCloseAlert: (a) => alerts.push(a) });
  push.deliverNotification("", "", { type: "seeker-close-alert" });
  assert.equal(alerts.length, 0);
});

test("initHiderPushReceiver is inert off-device", async () => {
  const push = fakePush();
  const got = [];
  await initHiderPushReceiver({ isNative: () => false, plugin: push, onSeekerCoords: (c) => got.push(c) });
  push.deliverData({ type: "seeker-location", lat: "1", lng: "2" });
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

test("a forwarded seeker-location ping updates the dot/pill but does NOT decide to alert (server owns that now)", async () => {
  // A hider zone centred in Mumbai; even a ping WELL inside a 1 km threshold
  // must not, on its own, produce a local notification any more.
  const g = createGame({ settings: { approachThresholdM: 1000, geofenceAlertStyle: "vibrate-tone" } });
  g.focusZone = { point: { lat: 19.076, lng: 72.877 }, radius: 500 };
  store.setCurrent(g);

  const push = fakePush();
  const posted = [];
  const dots = [];
  const share = new LiveShare({
    transport: mockTransport(),
    isNative: () => true,
    initPushReceiver: (opts) => initHiderPushReceiver({ isNative: () => true, plugin: push, onSeekerCoords: opts.onSeekerCoords, onCloseAlert: opts.onCloseAlert }),
    postLocalNotify: (notify, { alertStyle }) => { posted.push({ notify, alertStyle }); },
    onSeekerPoint: (pt) => dots.push(pt),
  });
  share.startAsHider("game-01");
  await tick(); // let the receiver attach

  push.deliverData({ type: "seeker-location", lat: 19.5, lng: 72.877 }); // far
  assert.equal(dots.length, 1, "red dot updates on every ping");
  assert.equal(posted.length, 0);

  push.deliverData({ type: "seeker-location", lat: 19.078, lng: 72.877 }); // ~220 m from centre — well inside
  assert.equal(dots.length, 2);
  assert.equal(posted.length, 0, "even a ping deep inside the zone must not trigger a local alert by itself");

  share.stop();
  store.setCurrent(createGame()); // reset shared store for other tests
});

test("a server-decided seeker-close-alert posts the local notification directly", async () => {
  const g = createGame({ settings: { geofenceAlertStyle: "vibrate-tone" } });
  store.setCurrent(g);

  const push = fakePush();
  const posted = [];
  const share = new LiveShare({
    transport: mockTransport(),
    isNative: () => true,
    initPushReceiver: (opts) => initHiderPushReceiver({ isNative: () => true, plugin: push, onSeekerCoords: opts.onSeekerCoords, onCloseAlert: opts.onCloseAlert }),
    postLocalNotify: (notify, { alertStyle }) => { posted.push({ notify, alertStyle }); },
  });
  share.startAsHider("game-01");
  await tick();

  push.deliverNotification("Seeker close", "A seeker is ~430 m from your hiding zone centre.", { type: "seeker-close-alert", code: "game-01" });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].notify.title, "Seeker close");
  assert.match(posted[0].notify.body, /430 m/);
  assert.equal(posted[0].alertStyle, "vibrate-tone");

  share.stop();
  store.setCurrent(createGame());
});

test("with the LOCAL alert style Off, a server-decided alert still posts nothing — a second line of defence", () => {
  // The server is expected to already suppress sending when it knows the
  // hider's style is Off (relay-forward.js checkServerApproach). This pins
  // that _fireNotification ALSO re-checks fresh, in case the two ever
  // disagree (e.g. the setting changed after the server made its decision but
  // before this message arrived) — belt and braces, not the primary guard.
  const g = createGame({ settings: { geofenceAlertStyle: "off" } });
  store.setCurrent(g);

  const posted = [];
  const share = new LiveShare({
    transport: mockTransport(),
    isNative: () => true,
    postLocalNotify: (notify, opts) => { posted.push({ notify, opts }); },
  });
  share.role = "hider"; // exercise _onServerAlert directly, no receiver plumbing needed for this pin
  share._onServerAlert({ title: "Seeker close", body: "~500 m" });
  assert.equal(posted.length, 0, "Off suppresses the local notification");
  assert.equal(share._isNative(), true, "sanity: this really did take the native branch, not fall through the web path for the wrong reason");
  store.setCurrent(createGame());
});
