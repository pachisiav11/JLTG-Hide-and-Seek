// Native notification channels for the Android build.
//
// Phases 41 and 44 select a channel id per alert (jltg-geofence/-silent,
// jltg-seeker-close/-silent) but never created one — on Android 8+ a
// LocalNotifications.schedule() call against a channel id that doesn't exist is
// silently dropped (no crash, no visible notification), which would make every
// background alert built in this track invisible. Rather than writing a native
// Kotlin snippet (the manual half those phases' docs described), this creates
// the channels from JS via LocalNotifications.createChannel() — the plugin's own
// public API — once at app boot on the native shell. Idempotent: createChannel
// on an existing id is a no-op update, so calling this on every launch is safe.

import { isNativeCapacitor } from "./bg-spike.js";
import { CHANNEL_ALERT, CHANNEL_SILENT } from "./native-geofence.js";
import { SEEKER_CLOSE_CHANNEL, SEEKER_CLOSE_CHANNEL_SILENT } from "./native-local-notify.js";

// Importance levels per the plugin's NotificationChannel type: 1 (none) .. 5
// (urgent/heads-up + sound). Alerting channels use 4 (high: heads-up, no
// override-DND); silent channels use 2 (low: no sound/heads-up, still visible in
// the shade) so Phase 33's "silent" style is actually quiet, not just un-vibrated.
export const NOTIFICATION_CHANNELS = [
  { id: CHANNEL_ALERT, name: "Hiding-zone edge alerts", description: "Warns when you're near or have crossed the hiding-zone edge.", importance: 4, vibration: true },
  { id: CHANNEL_SILENT, name: "Hiding-zone edge alerts (silent)", description: "Same as above, but without sound or vibration.", importance: 2, vibration: false },
  { id: SEEKER_CLOSE_CHANNEL, name: "Seeker-close alerts", description: "Fires when a live-shared seeker gets close to your hiding zone.", importance: 4, vibration: true },
  { id: SEEKER_CLOSE_CHANNEL_SILENT, name: "Seeker-close alerts (silent)", description: "Same as above, but without sound or vibration.", importance: 2, vibration: false },
];

let _LN = null;
async function loadLN() {
  if (_LN) return _LN;
  const { registerPlugin } = await import("../vendor/capacitor-core.js");
  _LN = registerPlugin("LocalNotifications");
  return _LN;
}

// Create (or update) every channel this app's local notifications rely on.
// Native-only; a no-op off-device. `plugins.LN` injectable for tests.
export async function ensureNotificationChannels({ isNative = isNativeCapacitor, plugins = null } = {}) {
  if (!isNative()) return;
  const LN = plugins?.LN || (await loadLN());
  if (!LN?.createChannel) return;
  for (const ch of NOTIFICATION_CHANNELS) {
    try {
      await LN.createChannel({ id: ch.id, name: ch.name, description: ch.description, importance: ch.importance, vibration: ch.vibration, visibility: 1 });
    } catch (e) {
      console.warn(`native-channels: createChannel(${ch.id}) failed`, e);
    }
  }
}
