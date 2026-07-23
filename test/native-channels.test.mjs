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
