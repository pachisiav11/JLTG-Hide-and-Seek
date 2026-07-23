// Phase 43 (Track B 2/3) test: the CLIENT half — mint the hider's FCM token and
// register it against the session.
//
// The token itself only exists on a real device; what's pinnable is the flow:
//   - getHiderPushToken resolves the token from the plugin, and returns null on
//     every honest failure (not native, permission denied, registration error,
//     no token in time) rather than hanging or throwing,
//   - LiveShare.startAsHider registers the token on the native shell and does
//     NOT off-device, and a token that resolves after the session changed is not
//     emitted to the wrong room.
import test from "node:test";
import assert from "node:assert/strict";

const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };
Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });

const { getHiderPushToken } = await import("../src/native-push.js");
const { LiveShare } = await import("../src/live-share.js");

const tick = () => new Promise((r) => setTimeout(r, 0));

// A fake @capacitor/push-notifications: register() drives the registration (or
// registrationError) listener, mirroring the real event-based token delivery.
function fakePush({ token = "fcm-token-123", denied = false, error = false } = {}) {
  const listeners = {};
  return {
    requestPermissions: async () => ({ receive: denied ? "denied" : "granted" }),
    addListener: async (ev, cb) => { listeners[ev] = cb; return { remove() { delete listeners[ev]; } }; },
    register: async () => {
      if (error) listeners.registrationError?.({ error: "no fcm" });
      else listeners.registration?.({ value: token });
    },
  };
}

test("getHiderPushToken returns null off-device", async () => {
  assert.equal(await getHiderPushToken({ isNative: () => false, plugin: fakePush() }), null);
});

test("getHiderPushToken resolves the token from the registration event", async () => {
  const token = await getHiderPushToken({ isNative: () => true, plugin: fakePush({ token: "abc123" }) });
  assert.equal(token, "abc123");
});

test("getHiderPushToken returns null when permission is denied", async () => {
  assert.equal(await getHiderPushToken({ isNative: () => true, plugin: fakePush({ denied: true }) }), null);
});

test("getHiderPushToken returns null on a registration error", async () => {
  assert.equal(await getHiderPushToken({ isNative: () => true, plugin: fakePush({ error: true }) }), null);
});

test("getHiderPushToken times out to null rather than hanging", async () => {
  // A plugin that never fires either event → the timeout wins.
  const silentPlugin = { requestPermissions: async () => ({ receive: "granted" }), addListener: async () => ({ remove() {} }), register: async () => {} };
  assert.equal(await getHiderPushToken({ isNative: () => true, plugin: silentPlugin, timeoutMs: 20 }), null);
});

// --- LiveShare registration ------------------------------------------------

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

test("startAsHider registers the FCM token against the session on the native shell", async () => {
  const transport = mockTransport();
  const share = new LiveShare({ transport, isNative: () => true, getPushToken: async () => "hider-token-xyz" });
  share.startAsHider("game-01");
  await tick();
  const reg = transport.emitted.filter((e) => e.ev === "register-token");
  assert.equal(reg.length, 1);
  assert.deepEqual(reg[0].payload, { code: "game-01", token: "hider-token-xyz" });
  share.stop();
});

test("startAsHider does NOT register off-device", async () => {
  const transport = mockTransport();
  const share = new LiveShare({ transport, isNative: () => false, getPushToken: async () => "hider-token-xyz" });
  share.startAsHider("game-01");
  await tick();
  assert.equal(transport.emitted.filter((e) => e.ev === "register-token").length, 0);
  share.stop();
});

test("a token that resolves after the session ends is not emitted to a dead room", async () => {
  const transport = mockTransport();
  // Token resolves on a later tick, after we've stopped the session.
  let release;
  const gate = new Promise((r) => { release = r; });
  const share = new LiveShare({ transport, isNative: () => true, getPushToken: () => gate.then(() => "late-token") });
  share.startAsHider("game-01");
  share.stop(); // session ends before the token arrives
  release();
  await tick();
  assert.equal(transport.emitted.filter((e) => e.ev === "register-token").length, 0, "stale token must not register");
});
