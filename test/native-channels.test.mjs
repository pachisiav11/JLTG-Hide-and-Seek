// Notification channel setup test.
//
// Without a created channel, Android 8+ silently drops a scheduled local
// notification against an unknown channel id — no crash, no visible alert. This
// pins that ensureNotificationChannels() creates exactly the four channel ids the
// geofence (Phase 41) and seeker-close (Phase 44) alerts select by, is inert
// off-device, and never throws if the plugin can't create one.
import test from "node:test";
import assert from "node:assert/strict";

const { ensureNotificationChannels, NOTIFICATION_CHANNELS } = await import("../src/native-channels.js");
const { CHANNEL_ALERT, CHANNEL_SILENT } = await import("../src/native-geofence.js");
const { SEEKER_CLOSE_CHANNEL, SEEKER_CLOSE_CHANNEL_SILENT } = await import("../src/native-local-notify.js");

test("NOTIFICATION_CHANNELS covers exactly the ids the alert modules select", () => {
  const ids = NOTIFICATION_CHANNELS.map((c) => c.id).sort();
  assert.deepEqual(ids, [CHANNEL_ALERT, CHANNEL_SILENT, SEEKER_CLOSE_CHANNEL, SEEKER_CLOSE_CHANNEL_SILENT].sort());
});

test("silent channels carry low importance and no vibration; alert channels don't", () => {
  for (const ch of NOTIFICATION_CHANNELS) {
    if (ch.id.endsWith("-silent")) {
      assert.equal(ch.vibration, false, `${ch.id} must not vibrate`);
      assert.ok(ch.importance <= 2, `${ch.id} must be low importance`);
    } else {
      assert.equal(ch.vibration, true, `${ch.id} should vibrate`);
      assert.ok(ch.importance >= 4, `${ch.id} should be high importance`);
    }
  }
});

test("ensureNotificationChannels is a no-op off-device", async () => {
  const calls = [];
  await ensureNotificationChannels({ isNative: () => false, plugins: { LN: { createChannel: async (c) => calls.push(c) } } });
  assert.equal(calls.length, 0);
});

test("ensureNotificationChannels creates all four channels on the native shell", async () => {
  const calls = [];
  await ensureNotificationChannels({ isNative: () => true, plugins: { LN: { createChannel: async (c) => calls.push(c) } } });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((c) => c.id).sort(), NOTIFICATION_CHANNELS.map((c) => c.id).sort());
});

test("a channel that fails to create does not stop the others (no throw)", async () => {
  const calls = [];
  const LN = {
    createChannel: async (c) => {
      if (c.id === CHANNEL_ALERT) throw new Error("boom");
      calls.push(c);
    },
  };
  await assert.doesNotReject(ensureNotificationChannels({ isNative: () => true, plugins: { LN } }));
  assert.equal(calls.length, 3, "the other three channels still get created");
});

test("ensureNotificationChannels resolves true only when every channel is created", async () => {
  const okLN = { LN: { createChannel: async () => {} } };
  assert.equal(await ensureNotificationChannels({ isNative: () => true, plugins: okLN }), true);

  const flakyLN = { LN: { createChannel: async (c) => { if (c.id === CHANNEL_ALERT) throw new Error("boom"); } } };
  assert.equal(await ensureNotificationChannels({ isNative: () => true, plugins: flakyLN }), false);

  assert.equal(await ensureNotificationChannels({ isNative: () => false, plugins: okLN }), false, "off-device is never ready");
});

// The device-confirmed root cause of the whole bug: async functions in this
// codebase used to `return` the bare Capacitor plugin proxy directly. That
// proxy (vendor/capacitor-core.js) answers EVERY property access, including
// `.then`, with a callable — so the JS engine treats a bare-returned proxy as
// a THENABLE and calls `proxy.then(resolve, reject)` itself. That throws into
// a promise nobody holds, and neither `resolve` nor `reject` is ever called:
// the loader's own promise hangs forever, with no error visible anywhere. This
// silently starved every notification of a channel (native-channels.js's old
// loadLN() had exactly this shape) — logcat + a live CDP repro on-device
// confirmed a bare-returned proxy really does hang. This test pins the fix
// (boxing the proxy in a plain object) against a hand-built stand-in for that
// proxy, without needing the real vendor/capacitor-core.js or a device.
test("boxing a thenable-trap proxy in a plain object prevents the hang; returning it bare reproduces it", async () => {
  const trapProxy = new Proxy({}, { get: () => () => {} }); // answers .then with a callable, like the real plugin proxy
  const settled = (p, ms) => Promise.race([
    p.then(() => "settled").catch(() => "settled"),
    new Promise((r) => setTimeout(() => r("hung"), ms)),
  ]);

  async function returnsBare() { return trapProxy; }
  assert.equal(await settled(returnsBare(), 50), "hung", "sanity check: an unboxed proxy really does hang forever");

  async function returnsBoxed() { return { LN: trapProxy }; }
  assert.equal(await settled(returnsBoxed(), 50), "settled", "boxing the proxy must prevent the thenable trap");
});
