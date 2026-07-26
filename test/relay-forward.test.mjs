// Phase 44 (Track B 3/3) test: the server forwards a seeker ping over FCM.
//
// The device half (a locked hider actually buzzing) is manual. What's pinnable is
// the server contract: on a seeker ping the server looks up the hider token and
// sends the RAW coordinates over FCM — and NOTHING about the zone (the server
// stays zone-blind; the hider's phone computes the alert). A dead token is
// evicted; a missing token / disabled FCM is a silent no-op that never throws.
import test from "node:test";
import assert from "node:assert/strict";

const { forwardPingToHider, checkServerApproach } = await import("../relay-forward.js");
const { HiderTokenRegistry } = await import("../hider-tokens.js");

const TOKEN = "cZ12_ab:APA91bH" + "x".repeat(120);

function fakeFcm({ enabled = true, result = { ok: true }, notifyResult } = {}) {
  const sends = [];
  const notifies = [];
  return {
    enabled,
    sends,
    notifies,
    sendData: async (token, data) => { sends.push({ token, data }); return typeof result === "function" ? result() : result; },
    sendNotification: async (token, message) => {
      notifies.push({ token, message });
      const r = notifyResult ?? result;
      return typeof r === "function" ? r() : r;
    },
  };
}

function registryWith(code, token) {
  const r = new HiderTokenRegistry();
  if (token) r.register(code, token);
  return r;
}

const PING = { lat: 19.076, lng: 72.877, at: 1234 };

test("forwards the RAW seeker coords (and only coords) to the hider token", async () => {
  const fcm = fakeFcm();
  const registry = registryWith("game-01", TOKEN);
  const res = await forwardPingToHider({ registry, fcm, code: "game-01", payload: PING });
  assert.deepEqual(res, { forwarded: true, reason: undefined });
  assert.equal(fcm.sends.length, 1);
  assert.equal(fcm.sends[0].token, TOKEN);
  const data = fcm.sends[0].data;
  assert.equal(data.type, "seeker-location");
  assert.equal(data.lat, 19.076);
  assert.equal(data.lng, 72.877);
  assert.equal(data.code, "game-01");
  // Server stays zone-blind: no zone, no radius, no distance in the payload.
  assert.ok(!("radius" in data) && !("zone" in data) && !("distance" in data));
});

test("no hider token registered → silent no-op, no send", async () => {
  const fcm = fakeFcm();
  const res = await forwardPingToHider({ registry: registryWith("game-01", null), fcm, code: "game-01", payload: PING });
  assert.deepEqual(res, { forwarded: false, reason: "no-token" });
  assert.equal(fcm.sends.length, 0);
});

test("FCM disabled → no-op (server runs fine without Firebase configured)", async () => {
  const fcm = fakeFcm({ enabled: false });
  const res = await forwardPingToHider({ registry: registryWith("game-01", TOKEN), fcm, code: "game-01", payload: PING });
  assert.equal(res.forwarded, false);
  assert.equal(res.reason, "fcm-disabled");
  assert.equal(fcm.sends.length, 0);
});

test("a dead token is evicted from the registry so we stop trying", async () => {
  const fcm = fakeFcm({ result: { ok: false, drop: true, reason: "messaging/registration-token-not-registered" } });
  const registry = registryWith("game-01", TOKEN);
  const res = await forwardPingToHider({ registry, fcm, code: "game-01", payload: PING });
  assert.equal(res.forwarded, false);
  assert.equal(registry.lookup("game-01"), null, "unregistered token dropped");
});

test("a transient send failure does NOT evict the token", async () => {
  const fcm = fakeFcm({ result: { ok: false, reason: "messaging/server-unavailable" } });
  const registry = registryWith("game-01", TOKEN);
  await forwardPingToHider({ registry, fcm, code: "game-01", payload: PING });
  assert.equal(registry.lookup("game-01"), TOKEN, "keep the token for the next ping");
});

test("a bad payload is rejected before any send", async () => {
  const fcm = fakeFcm();
  const res = await forwardPingToHider({ registry: registryWith("game-01", TOKEN), fcm, code: "game-01", payload: { lat: NaN, lng: 1 } });
  assert.equal(res.reason, "bad-payload");
  assert.equal(fcm.sends.length, 0);
});

// --- Phase 51: checkServerApproach — the locked/killed-device half ---------
//
// forwardPingToHider (above) stays zone-blind on purpose. checkServerApproach
// is the deliberate, narrow exception: when a hider has registered a zone, the
// server decides the crossing itself and sends a REAL FCM notification (not
// data) — the only way to reach an app process the OS has fully killed.

const CENTRE = { lat: 19.076, lng: 72.877 };
const FAR = { lat: 19.5, lng: 72.877, at: 1 };      // well outside a 1 km threshold
const NEAR = { lat: 19.078, lng: 72.877, at: 2 };   // ~220 m from centre — inside 1 km

function registryWithZone(code, { token = TOKEN, thresholdM = 1000, alertStyle = "vibrate-tone" } = {}) {
  const r = new HiderTokenRegistry();
  if (token) r.register(code, token);
  r.registerZone(code, { point: CENTRE, thresholdM, alertStyle });
  return r;
}

test("no zone registered for the room → no-op, no send", async () => {
  const fcm = fakeFcm();
  const res = await checkServerApproach({ registry: registryWith("game-01", TOKEN), fcm, code: "game-01", payload: NEAR });
  assert.deepEqual(res, { alerted: false, reason: "no-zone" });
  assert.equal(fcm.notifies.length, 0);
});

test("FCM disabled → no-op, checked before touching the registry's zone", async () => {
  const fcm = fakeFcm({ enabled: false });
  const res = await checkServerApproach({ registry: registryWithZone("game-01"), fcm, code: "game-01", payload: NEAR });
  assert.equal(res.reason, "fcm-disabled");
  assert.equal(fcm.notifies.length, 0);
});

test("a registered zone but no token → no-op (nowhere to send)", async () => {
  const fcm = fakeFcm();
  const registry = registryWithZone("game-01", { token: null });
  const res = await checkServerApproach({ registry, fcm, code: "game-01", payload: NEAR });
  assert.equal(res.reason, "no-token");
  assert.equal(fcm.notifies.length, 0);
});

test("alertStyle Off → never sends, even for a seeker sitting right on the centre", async () => {
  const fcm = fakeFcm();
  const registry = registryWithZone("game-01", { alertStyle: "off" });
  const res = await checkServerApproach({ registry, fcm, code: "game-01", payload: { ...CENTRE, at: 1 } });
  assert.equal(res.reason, "alert-style-off");
  assert.equal(fcm.notifies.length, 0);
});

test("with no prior baseline, a ping that's already inside alerts immediately (evaluateApproach's own contract — better to over-alert on first contact than miss it)", async () => {
  const fcm = fakeFcm();
  const registry = registryWithZone("game-01");
  const res = await checkServerApproach({ registry, fcm, code: "game-01", payload: NEAR });
  assert.equal(res.alerted, true);
  assert.equal(fcm.notifies.length, 1);
  assert.ok(registry.getApproachState("game-01"), "baseline is now recorded for the next ping");
});

test("with no prior baseline, a ping that's already OUTSIDE establishes the baseline silently", async () => {
  const fcm = fakeFcm();
  const registry = registryWithZone("game-01");
  const res = await checkServerApproach({ registry, fcm, code: "game-01", payload: FAR });
  assert.equal(res.reason, "no-crossing");
  assert.equal(fcm.notifies.length, 0);
  assert.ok(registry.getApproachState("game-01"), "baseline is now recorded for the next ping");
});

test("outside → inside fires exactly once; staying inside does not re-fire", async () => {
  const fcm = fakeFcm();
  const registry = registryWithZone("game-01");

  await checkServerApproach({ registry, fcm, code: "game-01", payload: FAR }); // baseline: outside
  assert.equal(fcm.notifies.length, 0);

  const crossed = await checkServerApproach({ registry, fcm, code: "game-01", payload: NEAR }); // crosses in
  assert.equal(crossed.alerted, true);
  assert.equal(fcm.notifies.length, 1);
  const [{ token, message }] = fcm.notifies;
  assert.equal(token, TOKEN);
  assert.match(message.title, /Seeker close/i);
  assert.equal(message.data.type, "seeker-close-alert");
  assert.equal(message.data.code, "game-01");

  await checkServerApproach({ registry, fcm, code: "game-01", payload: { ...NEAR, at: 3 } }); // still inside
  assert.equal(fcm.notifies.length, 1, "once-per-crossing debounce holds server-side too");
});

test("channelId follows alertStyle: silent uses the silent channel, everything else the alerting one", async () => {
  const fcmSilent = fakeFcm();
  const silentReg = registryWithZone("sil-001", { alertStyle: "silent" });
  await checkServerApproach({ registry: silentReg, fcm: fcmSilent, code: "sil-001", payload: FAR });
  await checkServerApproach({ registry: silentReg, fcm: fcmSilent, code: "sil-001", payload: NEAR });
  assert.equal(fcmSilent.notifies[0].message.channelId, "jltg-seeker-close-silent");

  const fcmLoud = fakeFcm();
  const loudReg = registryWithZone("loud-002", { alertStyle: "vibrate-tone" });
  await checkServerApproach({ registry: loudReg, fcm: fcmLoud, code: "loud-002", payload: FAR });
  await checkServerApproach({ registry: loudReg, fcm: fcmLoud, code: "loud-002", payload: NEAR });
  assert.equal(fcmLoud.notifies[0].message.channelId, "jltg-seeker-close");
});

test("a dead token from sendNotification is evicted from the registry", async () => {
  const fcm = fakeFcm({ notifyResult: { ok: false, drop: true, reason: "messaging/registration-token-not-registered" } });
  const registry = registryWithZone("game-01");
  await checkServerApproach({ registry, fcm, code: "game-01", payload: FAR });
  await checkServerApproach({ registry, fcm, code: "game-01", payload: NEAR });
  assert.equal(registry.lookup("game-01"), null, "dead token dropped");
});

test("a bad payload is rejected before touching the registry", async () => {
  const fcm = fakeFcm();
  const registry = registryWithZone("game-01");
  const res = await checkServerApproach({ registry, fcm, code: "game-01", payload: { lat: NaN, lng: 1 } });
  assert.equal(res.reason, "bad-payload");
  assert.equal(fcm.notifies.length, 0);
});
