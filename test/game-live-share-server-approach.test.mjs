// Phase 51 game test: the CLIENT half of the server-computed seeker-close
// alert — LiveShare telling the relay what to check.
//
// The server (relay-forward.js checkServerApproach, hider-tokens.js
// registerZone) can only decide a locked/killed hider's crossing if it knows
// their zone. This pins that a native hider session keeps the relay's copy of
// {point, thresholdM, alertStyle} current: registered on connect, refreshed on
// every relevant settings/zone change, and — crucially — never sent for a web
// session, where there is no locked-device case for it to help with.
import test from "node:test";
import assert from "node:assert/strict";

const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };
Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });

const { LiveShare } = await import("../src/live-share.js");
const { createGame } = await import("../src/model.js");
const store = await import("../src/store.js");

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

function zoneEmits(transport) {
  return transport.emitted.filter((e) => e.ev === "set-hider-zone");
}

const ZONE_POINT = { lat: 19.076, lng: 72.877 };

test("native hider with a zone already placed registers it with the relay on connect", async () => {
  const g = createGame({ focusZone: { point: ZONE_POINT, radius: 500 }, settings: { approachThresholdM: 1000, geofenceAlertStyle: "vibrate-tone" } });
  store.setCurrent(g);

  const transport = mockTransport();
  const share = new LiveShare({ transport, isNative: () => true, geolocation: null });
  share.startAsHider("game-01");

  const emits = zoneEmits(transport);
  assert.equal(emits.length, 1);
  assert.deepEqual(emits[0].payload, { code: "game-01", point: ZONE_POINT, thresholdM: 1000, alertStyle: "vibrate-tone" });
  share.stop();
  store.setCurrent(createGame());
});

test("nothing is registered yet when no zone has been placed", async () => {
  const g = createGame({ settings: { approachThresholdM: 1000 } });
  store.setCurrent(g);

  const transport = mockTransport();
  const share = new LiveShare({ transport, isNative: () => true, geolocation: null });
  share.startAsHider("game-01");

  assert.equal(zoneEmits(transport).length, 0, "no point to register — nothing sent");
  share.stop();
  store.setCurrent(createGame());
});

test("placing the zone WHILE already connected re-registers it — no reconnect needed", async () => {
  const g = createGame({ settings: { approachThresholdM: 1000 } });
  store.setCurrent(g);

  const transport = mockTransport();
  const share = new LiveShare({ transport, isNative: () => true, geolocation: null });
  share.startAsHider("game-01");
  assert.equal(zoneEmits(transport).length, 0);

  store.update((gg) => { gg.focusZone = { point: ZONE_POINT, radius: 500 }; });
  const emits = zoneEmits(transport);
  assert.equal(emits.length, 1);
  assert.deepEqual(emits[0].payload.point, ZONE_POINT);
  share.stop();
  store.setCurrent(createGame());
});

test("editing the threshold or alert style mid-session re-registers the zone with the new values", async () => {
  const g = createGame({ focusZone: { point: ZONE_POINT, radius: 500 }, settings: { approachThresholdM: 1000, geofenceAlertStyle: "vibrate-tone" } });
  store.setCurrent(g);

  const transport = mockTransport();
  const share = new LiveShare({ transport, isNative: () => true, geolocation: null });
  share.startAsHider("game-01");
  assert.equal(zoneEmits(transport).length, 1);

  store.update((gg) => (gg.settings = { ...gg.settings, approachThresholdM: 500 }));
  let emits = zoneEmits(transport);
  assert.equal(emits.length, 2);
  assert.equal(emits[1].payload.thresholdM, 500);

  store.update((gg) => (gg.settings = { ...gg.settings, geofenceAlertStyle: "off" }));
  emits = zoneEmits(transport);
  assert.equal(emits.length, 3);
  assert.equal(emits[2].payload.alertStyle, "off");

  share.stop();
  store.setCurrent(createGame());
});

test("off-device (web/PWA) never registers a zone — there's no locked-device case to serve", async () => {
  const g = createGame({ focusZone: { point: ZONE_POINT, radius: 500 }, settings: { approachThresholdM: 1000 } });
  store.setCurrent(g);

  const transport = mockTransport();
  const share = new LiveShare({ transport, isNative: () => false, geolocation: null });
  share.startAsHider("game-01");
  store.update((gg) => (gg.settings = { ...gg.settings, approachThresholdM: 2000 })); // still nothing

  assert.equal(zoneEmits(transport).length, 0);
  share.stop();
  store.setCurrent(createGame());
});

test("stopping the session stops re-registering on further settings changes", async () => {
  const g = createGame({ focusZone: { point: ZONE_POINT, radius: 500 }, settings: { approachThresholdM: 1000 } });
  store.setCurrent(g);

  const transport = mockTransport();
  const share = new LiveShare({ transport, isNative: () => true, geolocation: null });
  share.startAsHider("game-01");
  const before = zoneEmits(transport).length;
  share.stop();

  store.update((gg) => (gg.settings = { ...gg.settings, approachThresholdM: 2000 }));
  assert.equal(zoneEmits(transport).length, before, "no further emits after stop() unsubscribed from the store");
  store.setCurrent(createGame());
});

test("switching sessions re-targets registration at the NEW code only — the old session's subscription is torn down, not left running alongside it", async () => {
  const g = createGame({ focusZone: { point: ZONE_POINT, radius: 500 }, settings: { approachThresholdM: 1000 } });
  store.setCurrent(g);

  const transport = mockTransport();
  const share = new LiveShare({ transport, isNative: () => true, geolocation: null });
  share.startAsHider("first-code");
  assert.deepEqual(zoneEmits(transport).map((e) => e.payload.code), ["first-code"]);

  share.startAsHider("second-code"); // startAsHider tears down the old session before arming the new one
  store.update((gg) => (gg.settings = { ...gg.settings, approachThresholdM: 777 }));

  const codes = zoneEmits(transport).map((e) => e.payload.code);
  assert.deepEqual(codes, ["first-code", "second-code", "second-code"], "the settings change after switching only re-registers the CURRENT session — never a second, stale 'first-code' emit");
  share.stop();
  store.setCurrent(createGame());
});
