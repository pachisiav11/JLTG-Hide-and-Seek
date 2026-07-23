// Phase 44 (Track B 3/3) test: the server forwards a seeker ping over FCM.
//
// The device half (a locked hider actually buzzing) is manual. What's pinnable is
// the server contract: on a seeker ping the server looks up the hider token and
// sends the RAW coordinates over FCM — and NOTHING about the zone (the server
// stays zone-blind; the hider's phone computes the alert). A dead token is
// evicted; a missing token / disabled FCM is a silent no-op that never throws.
import test from "node:test";
import assert from "node:assert/strict";

const { forwardPingToHider } = await import("../relay-forward.js");
const { HiderTokenRegistry } = await import("../hider-tokens.js");

const TOKEN = "cZ12_ab:APA91bH" + "x".repeat(120);

function fakeFcm({ enabled = true, result = { ok: true } } = {}) {
  const sends = [];
  return {
    enabled,
    sends,
    sendData: async (token, data) => { sends.push({ token, data }); return typeof result === "function" ? result() : result; },
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
