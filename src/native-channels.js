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

let _lnBox = null;
// Boxed in a plain object — NEVER return the bare plugin proxy from an async
// function. Capacitor's registerPlugin() proxy has a catch-all `get` trap
// (vendor/capacitor-core.js), so `proxy.then` resolves to a callable and the
// JS engine treats a bare-returned proxy as a THENABLE: it calls
// `proxy.then(resolve, reject)` itself, which asks native to run a method
// literally named "then". That throws ("LocalNotifications.then() is not
// implemented on android") into a promise nobody holds, and neither `resolve`
// nor `reject` is ever invoked — the original caller's `await` hangs forever,
// silently. This is exactly what broke channel creation on-device: confirmed
// live (logcat + CDP) that `loadLN()`'s old `return _LN;` shape never settled,
// so `ensureNotificationChannels()` never reached its create-channel loop —
// every alert since Phase 41/44 was scheduled against a channel id Android had
// never created, which it drops with total silence (no error, no crash).
async function loadLNBox() {
  if (_lnBox) return _lnBox;
  const { registerPlugin } = await import("../vendor/capacitor-core.js");
  _lnBox = { LN: registerPlugin("LocalNotifications") };
  return _lnBox;
}

async function _createChannels({ isNative, plugins }) {
  if (!isNative()) return false;
  let LN;
  try {
    LN = plugins?.LN || (await loadLNBox()).LN;
  } catch (e) {
    console.warn("native-channels: could not load LocalNotifications plugin", e);
    return false;
  }
  if (!LN?.createChannel) return false;
  let allOk = true;
  for (const ch of NOTIFICATION_CHANNELS) {
    try {
      await LN.createChannel({ id: ch.id, name: ch.name, description: ch.description, importance: ch.importance, vibration: ch.vibration, visibility: 1 });
    } catch (e) {
      console.warn(`native-channels: createChannel(${ch.id}) failed`, e);
      allOk = false;
    }
  }
  return allOk;
}

let _channelsReady = null;

// Create (or update) every channel this app's local notifications rely on, and
// report whether every one of them is actually ready to receive a post — the
// alert-firing modules (native-geofence.js, native-local-notify.js) gate on
// this rather than assuming boot-time creation already landed. Memoized once
// per app session so every caller shares the same outcome instead of re-running
// the loop, EXCEPT when a test injects `plugins` directly: that always runs
// fresh so tests stay isolated from each other and from app boot's own call.
// Native-only (resolves false off-device); never throws.
export function ensureNotificationChannels({ isNative = isNativeCapacitor, plugins = null } = {}) {
  if (plugins) return _createChannels({ isNative, plugins });
  if (!_channelsReady) _channelsReady = _createChannels({ isNative, plugins: null });
  return _channelsReady;
}
